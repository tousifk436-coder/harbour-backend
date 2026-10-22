/** Departments, profiles (employees) and employee performance. */
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { Department, User, Lead, Client, FollowUp, Task, Payment, Activity, ENUMS, EMAIL_RE } = require("../models");
const { wrap, bad, forbidden, notFound, idParam, oid, pick, sameId, json } = require("../utils/http");
const { isAdmin, isSuper, scopeFilter, requireAdmin, requireSuper, visibleIds } = require("../utils/access");
const { ensureDefaultChannels } = require("../utils/channels");
const { emitChange } = require("../utils/realtime");

// ---------------- Departments ----------------
router.get("/departments", wrap(async (_req, res) => {
  res.json((await Department.find().sort({ name: 1 })).map(json));
}));
router.post("/departments", wrap(async (req, res) => {
  requireSuper(req.user);
  const name = String(req.body.name || "").trim();
  if (!name) throw bad("Department name is required");
  const d = await Department.create({ name });
  await ensureDefaultChannels();
  emitChange("departments"); emitChange("chat_channels");
  res.status(201).json(json(d));
}));

// ---------------- Profiles ----------------
/** Admins see everyone; others see themselves and their department colleagues. */
function profileScope(u) {
  if (isAdmin(u)) return {};
  const or = [{ _id: u._id }];
  if (u.department_id) or.push({ department_id: u.department_id });
  return { $or: or };
}

router.get("/profiles", wrap(async (req, res) => {
  const rows = await User.find(profileScope(req.user)).populate({ path: "department", select: "name" }).sort({ full_name: 1 });
  res.json(rows.map(json));
}));

// Create an employee account (admins and super admins only)
router.post("/profiles", wrap(async (req, res) => {
  const me = req.user;
  requireAdmin(me);
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const full_name = String(req.body.full_name || "").trim();
  const phone = req.body.phone ? String(req.body.phone).trim() : null;
  const role = String(req.body.role || "employee");
  let department_id = oid(req.body.department_id);

  if (!EMAIL_RE.test(email)) throw bad("Valid email required");
  if (password.length < 8) throw bad("Password must be at least 8 characters");
  if (!full_name) throw bad("Full name required");
  if (!ENUMS.role.includes(role)) throw bad("Invalid role");
  if (me.role === "admin") {
    if (role === "super_admin") throw forbidden("Admins cannot create super admins");
    department_id = me.department_id || null;
  }
  if (department_id && !(await Department.exists({ _id: department_id }))) throw bad("Department not found");
  if (await User.exists({ email })) throw bad("A user with this email address has already been registered");

  const u = await User.create({ email, password_hash: await bcrypt.hash(password, 10), full_name, phone, role, department_id });
  await ensureDefaultChannels();
  emitChange("profiles"); emitChange("chat_channels");
  res.status(201).json({ ok: true, user_id: String(u._id) });
}));

// Update a profile. Self: name/phone/avatar. Admin: own department. Super admin: anyone.
router.patch("/profiles/:id", wrap(async (req, res) => {
  const me = req.user;
  const target = await User.findById(idParam(req.params.id));
  if (!target) throw notFound();
  const self = sameId(target._id, me._id);
  const adminOfDept = me.role === "admin" && target.department_id && sameId(target.department_id, me.department_id);
  if (!self && !isSuper(me) && !adminOfDept) throw forbidden();

  const patch = pick(req.body, ["full_name", "phone", "avatar_url", "role", "department_id", "is_active"]);
  if ("role" in patch && patch.role !== target.role) {
    if (!isSuper(me)) throw forbidden("Only a super admin can change roles");
    if (!ENUMS.role.includes(patch.role)) throw bad("Invalid role");
  }
  if ("department_id" in patch) {
    patch.department_id = oid(patch.department_id);
    if (!sameId(patch.department_id, target.department_id)) {
      if (!isAdmin(me)) throw forbidden("You cannot change departments");
      if (me.role === "admin" && !sameId(patch.department_id, me.department_id)) throw forbidden("Admins can only keep people in their own department");
    }
  }
  if ("is_active" in patch && Boolean(patch.is_active) !== target.is_active) {
    if (!isAdmin(me)) throw forbidden("You cannot activate/deactivate accounts");
    if (self) throw forbidden("You cannot deactivate your own account");
    patch.is_active = Boolean(patch.is_active);
  }
  if (me.role === "admin" && patch.role === "super_admin") throw forbidden("Admins cannot promote to super admin");
  if ("full_name" in patch) patch.full_name = String(patch.full_name || "").trim();
  if ("phone" in patch) patch.phone = patch.phone ? String(patch.phone).trim() : null;

  const membershipChanged = ["role", "department_id", "is_active"].some((k) => k in patch);
  target.set(patch);
  await target.save();
  if (membershipChanged) { await ensureDefaultChannels(); emitChange("chat_channels"); }
  emitChange("profiles");
  const out = await User.findById(target._id).populate({ path: "department", select: "name" });
  res.json(json(out));
}));

// ---------------- Employee performance ----------------
router.get("/employee-performance", wrap(async (req, res) => {
  const u = req.user;
  const scope = scopeFilter(u);
  const since30 = new Date(Date.now() - 30 * 86400_000);
  const now = new Date();
  const people = await User.find(profileScope(u)).populate({ path: "department", select: "name" }).lean();

  const countBy = async (Model, match) => {
    const rows = await Model.aggregate([{ $match: { ...scope, ...match } }, { $group: { _id: "$assigned_to", n: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
  };
  const [leadsAssigned, leadsWon, leads30, clients, fuDone, fuOverdue, tasksDone, tasksOpen] = await Promise.all([
    countBy(Lead, {}), countBy(Lead, { status: "won" }), countBy(Lead, { created_at: { $gte: since30 } }),
    countBy(Client, {}),
    countBy(FollowUp, { status: "done", completed_at: { $gte: since30 } }),
    countBy(FollowUp, { status: "pending", due_at: { $lt: now } }),
    countBy(Task, { status: "done", completed_at: { $gte: since30 } }),
    countBy(Task, { status: { $ne: "done" } }),
  ]);

  // revenue collected on each person's visible clients
  const visibleClients = await Client.find(scope).select("_id assigned_to").lean();
  const ownerOf = Object.fromEntries(visibleClients.map((c) => [String(c._id), String(c.assigned_to)]));
  const paid = await Payment.aggregate([{ $match: { status: "paid", client_id: { $in: visibleClients.map((c) => c._id) } } }, { $group: { _id: "$client_id", s: { $sum: "$amount" } } }]);
  const revenue = {};
  for (const p of paid) { const o = ownerOf[String(p._id)]; if (o) revenue[o] = (revenue[o] || 0) + p.s; }

  // last activity on records the caller can see
  const { leadIds, clientIds } = await visibleIds(u);
  const actMatch = leadIds ? { $or: [{ lead_id: { $in: leadIds } }, { client_id: { $in: clientIds } }] } : {};
  const lastAct = await Promise.all(people.map((p) => Activity.findOne({ ...actMatch, user_id: p._id }).sort({ created_at: -1 }).select("created_at").lean()));
  const last = Object.fromEntries(people.map((p, i) => [String(p._id), lastAct[i]?.created_at || null]));

  const rows = people.map((p) => {
    const id = String(p._id);
    return {
      id, full_name: p.full_name, email: p.email, role: p.role,
      department_id: p.department_id ? String(p.department_id) : null,
      department_name: p.department?.name ?? null, is_active: p.is_active,
      leads_assigned: leadsAssigned[id] || 0, leads_won: leadsWon[id] || 0, leads_last_30d: leads30[id] || 0,
      clients_assigned: clients[id] || 0, followups_done_30d: fuDone[id] || 0, followups_overdue: fuOverdue[id] || 0,
      tasks_done_30d: tasksDone[id] || 0, tasks_open: tasksOpen[id] || 0,
      revenue_collected: Math.round((revenue[id] || 0) * 100) / 100,
      last_activity_at: last[id] || null,
    };
  });
  rows.sort((a, b) => b.leads_won - a.leads_won);
  res.json(rows);
}));

module.exports = router;
