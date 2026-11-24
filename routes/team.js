/** Departments, profiles (employees) and employee performance. */
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const {
  Department,
  User,
  Lead,
  Client,
  FollowUp,
  Task,
  Payment,
  Activity,
  ENUMS,
  EMAIL_RE,
} = require("../models");
const {
  wrap,
  bad,
  forbidden,
  notFound,
  idParam,
  oid,
  pick,
  sameId,
  json,
} = require("../utils/http");
const {
  isAdmin,
  isSuper,
  scopeFilter,
  requireAdmin,
  requireSuper,
  visibleIds,
} = require("../utils/access");
const { ensureDefaultChannels } = require("../utils/channels");
const { emitChange } = require("../utils/realtime");

// ---------------- Departments ----------------
router.get(
  "/departments",
  wrap(async (req, res) => {
    res.json(
      (
        await Department.find({ workspace_id: req.user.workspace_id }).sort({
          name: 1,
        })
      ).map(json),
    );
  }),
);
router.post(
  "/departments",
  wrap(async (req, res) => {
    requireSuper(req.user);
    const name = String(req.body.name || "").trim();
    if (!name) throw bad("Department name is required");
    const d = await Department.create({
      workspace_id: req.user.workspace_id,
      name,
    });
    await ensureDefaultChannels(req.user.workspace_id);
    emitChange("departments");
    emitChange("chat_channels");
    res.status(201).json(json(d));
  }),
);

// ---------------- Profiles ----------------
/** Admins see everyone; others see themselves and their department colleagues. */
function profileScope(u) {
  const ws = { workspace_id: u.workspace_id };
  if (u.role === "super_admin") return ws; // sees the whole company
  // An admin sees themselves + their visible agents (own + super-admin-created),
  // which the auth middleware precomputed as subordinate_ids.
  if (u.role === "admin")
    return { ...ws, _id: { $in: u.subordinate_ids || [u._id] } };
  return { ...ws, _id: u._id }; // employees see only themselves
}

router.get(
  "/profiles",
  wrap(async (req, res) => {
    const rows = await User.find(profileScope(req.user))
      .populate({ path: "department", select: "name" })
      .sort({ full_name: 1 });
    res.json(rows.map(json));
  }),
);

// Create an employee account (admins and super admins only)
router.post(
  "/profiles",
  wrap(async (req, res) => {
    const me = req.user;
    requireAdmin(me);
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");
    const full_name = String(req.body.full_name || "").trim();
    const phone = req.body.phone ? String(req.body.phone).trim() : null;
    const role = String(req.body.role || "employee");
    let department_id = oid(req.body.department_id);

    if (!EMAIL_RE.test(email)) throw bad("Valid email required");
    if (password.length < 8)
      throw bad("Password must be at least 8 characters");
    if (!full_name) throw bad("Full name required");
    if (!ENUMS.role.includes(role)) throw bad("Invalid role");
    if (me.role === "admin") {
      if (role === "super_admin")
        throw forbidden("Admins cannot create super admins");
      department_id = me.department_id || null;
    }
    if (
      department_id &&
      !(await Department.exists({
        _id: department_id,
        workspace_id: me.workspace_id,
      }))
    )
      throw bad("Department not found");
    if (await User.exists({ email }))
      throw bad("A user with this email address has already been registered");

    const u = await User.create({
      workspace_id: me.workspace_id,
      email,
      password_hash: await bcrypt.hash(password, 10),
      full_name,
      phone,
      role,
      department_id,
      manager_id: me._id, // hierarchy: the creator owns this user
      designation: String(req.body.designation || "").trim() || null,
    });
    await ensureDefaultChannels(me.workspace_id);
    emitChange("profiles");
    emitChange("chat_channels");
    res.status(201).json({ ok: true, user_id: String(u._id) });
  }),
);

// Update a profile. Self: name/phone/avatar. Admin: own department. Super admin: anyone.
router.patch(
  "/profiles/:id",
  wrap(async (req, res) => {
    const me = req.user;
    const target = await User.findById(idParam(req.params.id));
    if (!target || !sameId(target.workspace_id, me.workspace_id))
      throw notFound();
    const self = sameId(target._id, me._id);
    const adminOfDept =
      me.role === "admin" &&
      target.department_id &&
      sameId(target.department_id, me.department_id);
    if (!self && !isSuper(me) && !adminOfDept) throw forbidden();

    const patch = pick(req.body, [
      "full_name",
      "phone",
      "avatar_url",
      "role",
      "department_id",
      "designation",
      "is_active",
    ]);

    // ---- email (sign-in address) ----
    // Yourself: confirm with your current password. Others: super admin (anyone) or admin (employees of own department).
    if (req.body.email !== undefined) {
      const email = String(req.body.email || "")
        .trim()
        .toLowerCase();
      if (email !== target.email) {
        if (!EMAIL_RE.test(email)) throw bad("Enter a valid email address.");
        if (self) {
          const current = String(req.body.current_password || "");
          if (
            !current ||
            !(await bcrypt.compare(current, target.password_hash))
          )
            throw bad("Your current password is not correct.");
        } else {
          const ownEmployee =
            me.role === "admin" &&
            target.role === "employee" &&
            target.department_id &&
            sameId(target.department_id, me.department_id);
          if (!isSuper(me) && !ownEmployee)
            throw forbidden("You cannot change this person's email.");
        }
        if (await User.exists({ email, _id: { $ne: target._id } }))
          throw bad("Another account already uses this email.");
        patch.email = email;
      }
    }
    if ("role" in patch && patch.role !== target.role) {
      if (!isSuper(me)) throw forbidden("Only a super admin can change roles");
      if (!ENUMS.role.includes(patch.role)) throw bad("Invalid role");
    }
    if ("department_id" in patch) {
      patch.department_id = oid(patch.department_id);
      if (!sameId(patch.department_id, target.department_id)) {
        if (!isAdmin(me)) throw forbidden("You cannot change departments");
        if (
          me.role === "admin" &&
          !sameId(patch.department_id, me.department_id)
        )
          throw forbidden(
            "Admins can only keep people in their own department",
          );
      }
    }
    if ("is_active" in patch && Boolean(patch.is_active) !== target.is_active) {
      if (!isAdmin(me))
        throw forbidden("You cannot activate/deactivate accounts");
      if (self) throw forbidden("You cannot deactivate your own account");
      patch.is_active = Boolean(patch.is_active);
    }
    if (me.role === "admin" && patch.role === "super_admin")
      throw forbidden("Admins cannot promote to super admin");
    if ("full_name" in patch)
      patch.full_name = String(patch.full_name || "").trim();
    if ("phone" in patch)
      patch.phone = patch.phone ? String(patch.phone).trim() : null;
    if ("designation" in patch)
      patch.designation = patch.designation
        ? String(patch.designation).trim().slice(0, 80) || null
        : null;

    const membershipChanged = ["role", "department_id", "is_active"].some(
      (k) => k in patch,
    );
    target.set(patch);
    await target.save();
    if (membershipChanged) {
      await ensureDefaultChannels(me.workspace_id);
      emitChange("chat_channels");
    }
    emitChange("profiles");
    const out = await User.findById(target._id).populate({
      path: "department",
      select: "name",
    });
    res.json(json(out));
  }),
);

// POST /api/profiles/:id/password { password } -> admin sets a new password for someone.
router.post(
  "/profiles/:id/password",
  wrap(async (req, res) => {
    const me = req.user;
    requireAdmin(me);
    const target = await User.findById(idParam(req.params.id));
    if (!target || !sameId(target.workspace_id, me.workspace_id))
      throw notFound();
    if (sameId(target._id, me._id))
      throw bad("Use Settings → Security to change your own password.");
    if (!isSuper(me)) {
      const ownDept =
        target.department_id && sameId(target.department_id, me.department_id);
      if (!ownDept || target.role !== "employee")
        throw forbidden(
          "Admins can only reset passwords of employees in their own department.",
        );
    }
    const pw = String(req.body.password || "");
    if (pw.length < 8) throw bad("Password must be at least 8 characters");
    if (pw.length > 128) throw bad("Password is too long");
    target.password_hash = await bcrypt.hash(pw, 10);
    target.token_version = (target.token_version || 0) + 1;
    await target.save();
    res.json({ ok: true });
  }),
);

// Permanently remove an employee account only when no business records still reference it.
router.delete(
  "/profiles/:id",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const target = await User.findOne({
      _id: idParam(req.params.id),
      workspace_id: req.user.workspace_id,
    });
    if (!target) throw notFound();
    if (sameId(target._id, req.user._id))
      throw forbidden("You cannot delete your own account.");
    if (target.is_owner || target.role === "super_admin")
      throw forbidden("Owner and super admin accounts cannot be deleted.");
    if (
      !isSuper(req.user) &&
      !(
        target.role === "employee" &&
        sameId(target.department_id, req.user.department_id)
      )
    )
      throw forbidden("You can only delete employees in your department.");
    const models = [
      [Lead, ["assigned_to", "shared_with", "created_by"]],
      [Client, ["assigned_to", "created_by"]],
      [FollowUp, ["assigned_to", "created_by", "attendees"]],
      [Task, ["assigned_to", "created_by"]],
      [Activity, ["user_id"]],
    ];
    for (const [Model, fields] of models) {
      if (
        await Model.exists({
          workspace_id: req.user.workspace_id,
          $or: fields.map((field) => ({ [field]: target._id })),
        })
      )
        throw bad(
          "This employee has associated CRM records. Reassign their leads and work first; historical activity must be retained. Deactivate the account instead if needed.",
        );
    }
    await target.deleteOne();
    await ensureDefaultChannels(req.user.workspace_id);
    emitChange("profiles");
    emitChange("chat_channels");
    res.json({ ok: true });
  }),
);

// Reports are based on recorded CRM activity.
router.get(
  "/reports/agent-outreach",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const start = new Date(String(req.query.from || ""));
    const end = new Date(String(req.query.to || ""));
    if (
      Number.isNaN(+start) ||
      Number.isNaN(+end) ||
      start > end ||
      +end - +start > 366 * 86400000
    )
      throw bad("Select a valid date range of up to 366 days.");
    const scope = profileScope(req.user);
    // Super admins do the assigning, not the calling — leave them out of the
    // agent report so it only shows admins and agents.
    const people = (
      await User.find(scope).select("full_name email role is_active").lean()
    ).filter((p) => p.role !== "super_admin");
    const ids = people.map((p) => p._id);
    const leadCounts = await Lead.aggregate([
      {
        $match: {
          workspace_id: req.user.workspace_id,
          assigned_to: { $in: ids },
        },
      },
      { $group: { _id: "$assigned_to", count: { $sum: 1 } } },
    ]);
    const leadMap = Object.fromEntries(
      leadCounts.map((x) => [String(x._id), x.count]),
    );
    const calls = await Activity.find({
      workspace_id: req.user.workspace_id,
      user_id: { $in: ids },
      type: "call",
      created_at: { $gte: start, $lte: end },
    })
      .select("user_id created_at lead_id client_id metadata")
      .lean();
    const followups = await FollowUp.find({
      workspace_id: req.user.workspace_id,
      assigned_to: { $in: ids },
      type: "call",
      status: "done",
      completed_at: { $gte: start, $lte: end },
    })
      .select("assigned_to completed_at")
      .lean();
    const rows = people.map((p) => ({
      id: String(p._id),
      full_name: p.full_name,
      email: p.email,
      role: p.role,
      is_active: p.is_active,
      leads_assigned: leadMap[String(p._id)] || 0,
      logged_calls: 0,
      answered_calls: 0,
      not_answered_calls: 0,
      talk_time_seconds: 0,
      completed_call_followups: 0,
      unique_leads_contacted: 0,
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0 })),
    }));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const contacted = {};
    for (const c of calls) {
      const id = String(c.user_id),
        r = byId[id];
      if (!r) continue;
      r.logged_calls++;
      const o = c.metadata?.outcome;
      if (o === "answered") {
        r.answered_calls++;
        r.talk_time_seconds += Number(c.metadata?.duration_seconds) || 0;
      } else if (o === "not_answered") {
        r.not_answered_calls++;
      }
      r.hourly[new Date(c.created_at).getUTCHours()].calls++;
      if (c.lead_id) (contacted[id] ||= new Set()).add(String(c.lead_id));
    }
    for (const c of followups) {
      const r = byId[String(c.assigned_to)];
      if (r) r.completed_call_followups++;
    }
    for (const r of rows) r.unique_leads_contacted = contacted[r.id]?.size || 0;

    // A readable log of the most recent calls: who called, whom, and when.
    const recent = [...calls]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 100);
    const leadIds = recent.filter((c) => c.lead_id).map((c) => c.lead_id);
    const clientIds = recent.filter((c) => c.client_id).map((c) => c.client_id);
    const [leadsN, clientsN] = await Promise.all([
      Lead.find({ _id: { $in: leadIds } })
        .select("name")
        .lean(),
      Client.find({ _id: { $in: clientIds } })
        .select("name")
        .lean(),
    ]);
    const leadName = Object.fromEntries(
      leadsN.map((l) => [String(l._id), l.name]),
    );
    const clientName = Object.fromEntries(
      clientsN.map((c) => [String(c._id), c.name]),
    );
    const agentName = Object.fromEntries(rows.map((r) => [r.id, r.full_name]));
    const recent_calls = recent.map((c) => ({
      agent: agentName[String(c.user_id)] || "—",
      contact: c.lead_id
        ? leadName[String(c.lead_id)] || "Lead"
        : c.client_id
          ? clientName[String(c.client_id)] || "Customer"
          : "—",
      kind: c.lead_id ? "Lead" : c.client_id ? "Customer" : "—",
      at: c.created_at,
      outcome: c.metadata?.outcome || null, // "answered" | "not_answered" | null
      duration_seconds: Number(c.metadata?.duration_seconds) || 0,
    }));

    res.json({
      from: start.toISOString(),
      to: end.toISOString(),
      timezone: "UTC",
      source: "CRM logged call activities",
      rows,
      recent_calls,
    });
  }),
);

// ---------------- Employee performance ----------------
router.get(
  "/employee-performance",
  wrap(async (req, res) => {
    const u = req.user;
    const scope = scopeFilter(u);
    const since30 = new Date(Date.now() - 30 * 86400_000);
    const now = new Date();
    const people = await User.find(profileScope(u))
      .populate({ path: "department", select: "name" })
      .lean();

    const countBy = async (Model, match) => {
      const rows = await Model.aggregate([
        { $match: { ...scope, ...match } },
        { $group: { _id: "$assigned_to", n: { $sum: 1 } } },
      ]);
      return Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
    };
    const [
      leadsAssigned,
      leadsWon,
      leads30,
      clients,
      fuDone,
      fuOverdue,
      tasksDone,
      tasksOpen,
    ] = await Promise.all([
      countBy(Lead, {}),
      countBy(Lead, { status: "sale_done" }),
      countBy(Lead, { created_at: { $gte: since30 } }),
      countBy(Client, {}),
      countBy(FollowUp, { status: "done", completed_at: { $gte: since30 } }),
      countBy(FollowUp, { status: "pending", due_at: { $lt: now } }),
      countBy(Task, { status: "done", completed_at: { $gte: since30 } }),
      countBy(Task, { status: { $ne: "done" } }),
    ]);

    const visibleClients = await Client.find(scope)
      .select("_id assigned_to")
      .lean();
    const ownerOf = Object.fromEntries(
      visibleClients.map((c) => [String(c._id), String(c.assigned_to)]),
    );
    const paid = await Payment.aggregate([
      {
        $match: {
          status: "paid",
          client_id: { $in: visibleClients.map((c) => c._id) },
        },
      },
      { $group: { _id: "$client_id", s: { $sum: "$amount" } } },
    ]);
    const revenue = {};
    for (const p of paid) {
      const o = ownerOf[String(p._id)];
      if (o) revenue[o] = (revenue[o] || 0) + p.s;
    }

    const { leadIds, clientIds } = await visibleIds(u);
    const actMatch = leadIds
      ? {
          workspace_id: u.workspace_id,
          $or: [
            { lead_id: { $in: leadIds } },
            { client_id: { $in: clientIds } },
          ],
        }
      : { workspace_id: u.workspace_id };
    const lastAct = await Promise.all(
      people.map((p) =>
        Activity.findOne({ ...actMatch, user_id: p._id })
          .sort({ created_at: -1 })
          .select("created_at")
          .lean(),
      ),
    );
    const last = Object.fromEntries(
      people.map((p, i) => [String(p._id), lastAct[i]?.created_at || null]),
    );

    const rows = people.map((p) => {
      const id = String(p._id);
      return {
        id,
        full_name: p.full_name,
        email: p.email,
        role: p.role,
        department_id: p.department_id ? String(p.department_id) : null,
        department_name: p.department?.name ?? null,
        is_active: p.is_active,
        leads_assigned: leadsAssigned[id] || 0,
        leads_won: leadsWon[id] || 0,
        leads_last_30d: leads30[id] || 0,
        clients_assigned: clients[id] || 0,
        followups_done_30d: fuDone[id] || 0,
        followups_overdue: fuOverdue[id] || 0,
        tasks_done_30d: tasksDone[id] || 0,
        tasks_open: tasksOpen[id] || 0,
        revenue_collected: Math.round((revenue[id] || 0) * 100) / 100,
        last_activity_at: last[id] || null,
      };
    });
    rows.sort((a, b) => b.leads_won - a.leads_won);
    res.json(rows);
  }),
);

module.exports = router;
