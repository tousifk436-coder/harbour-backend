const router = require("express").Router();
const { Client, Activity } = require("../models");
const {
  wrap,
  bad,
  forbidden,
  idParam,
  oid,
  pick,
  blankToNull,
  sameId,
  json,
} = require("../utils/http");
const {
  isAdmin,
  isSuper,
  scopeFilter,
  canAssignTo,
  stampOwnership,
  loadAccessible,
} = require("../utils/access");
const { deleteClientCascade } = require("../utils/cascade");
const { logActivity } = require("../utils/activity");
const { emitChange } = require("../utils/realtime");
const { searchFilter } = require("./leads");

const FIELDS = [
  "name",
  "phone",
  "email",
  "company",
  "address",
  "service_status",
  "service_name",
  "contract_value",
  "notes",
  "assigned_to",
  "lead_id",
];
const TEXT = ["phone", "email", "company", "address", "notes", "service_name"];
const ASSIGNEE = { path: "assignee", select: "full_name" };

function clean(body, u) {
  const d = blankToNull(pick(body, [...FIELDS, "department_id"]), TEXT);
  if (!isSuper(u)) delete d.department_id;
  else if ("department_id" in d) d.department_id = oid(d.department_id);
  if ("assigned_to" in d) d.assigned_to = oid(d.assigned_to);
  if ("lead_id" in d) d.lead_id = oid(d.lead_id);
  if ("contract_value" in d) d.contract_value = Number(d.contract_value) || 0;
  if ("name" in d) d.name = String(d.name || "").trim();
  return d;
}

const NO_PHONE_C = {
  $or: [{ phone: { $in: [null, ""] } }, { phone: { $exists: false } }],
};
const NO_EMAIL_C = {
  $or: [{ email: { $in: [null, ""] } }, { email: { $exists: false } }],
};
const truthy = (v) => v === true || v === "1" || v === "true";

// Centralized customer filtering, shared by the list and the bulk actions.
// p: { search, status, assigned_to, created_by, no_phone, no_email,
//      date_from, date_to, min_value, max_value }
function buildClientAnd(user, p = {}) {
  const and = [
    scopeFilter(user),
    searchFilter(p.search, ["name", "email", "phone", "company"]),
  ];
  if (p.status) and.push({ service_status: p.status });
  if (truthy(p.no_phone)) and.push(NO_PHONE_C);
  if (truthy(p.no_email)) and.push(NO_EMAIL_C);
  if (p.created_by) {
    const cid = oid(p.created_by);
    if (cid) and.push({ created_by: cid });
  }
  const df = p.date_from ? new Date(p.date_from) : null;
  if (df && !Number.isNaN(+df)) and.push({ created_at: { $gte: df } });
  const dt = p.date_to ? new Date(p.date_to) : null;
  if (dt && !Number.isNaN(+dt)) {
    dt.setHours(23, 59, 59, 999);
    and.push({ created_at: { $lte: dt } });
  }
  if (
    p.min_value !== undefined &&
    p.min_value !== "" &&
    !Number.isNaN(Number(p.min_value))
  )
    and.push({ contract_value: { $gte: Number(p.min_value) } });
  if (
    p.max_value !== undefined &&
    p.max_value !== "" &&
    !Number.isNaN(Number(p.max_value))
  )
    and.push({ contract_value: { $lte: Number(p.max_value) } });
  if (p.assigned_to === "unassigned") and.push({ assigned_to: null });
  else if (p.assigned_to) {
    const aid = oid(p.assigned_to);
    and.push({ $or: [{ assigned_to: aid }, { created_by: aid }] });
  }
  return and;
}

router.get(
  "/",
  wrap(async (req, res) => {
    const and = buildClientAnd(req.user, req.query);
    const rows = await Client.find({ $and: and })
      .sort({ created_at: -1 })
      .limit(2000)
      .populate(ASSIGNEE);
    res.json(rows.map(json));
  }),
);

// POST /api/clients/bulk-assign { ids?|all, filter?, assigned_to }
router.post(
  "/bulk-assign",
  wrap(async (req, res) => {
    if (!isAdmin(req.user)) throw forbidden("You do not have permission.");
    const { ids, all, filter: f = {}, assigned_to } = req.body || {};
    const target = oid(assigned_to);
    if (!target) throw bad("Pick a person to assign to.");
    if (!(await canAssignTo(req.user, target)))
      throw forbidden("You cannot assign to that person.");
    let and;
    if (all) and = buildClientAnd(req.user, f);
    else {
      const list = (Array.isArray(ids) ? ids : []).map(oid).filter(Boolean);
      if (!list.length) throw bad("No customers selected.");
      and = [scopeFilter(req.user), { _id: { $in: list } }];
    }
    const result = await Client.updateMany(
      { $and: and },
      { $set: { assigned_to: target } },
    );
    emitChange("clients");
    res.json({
      ok: true,
      modified: result.modifiedCount ?? result.nModified ?? 0,
    });
  }),
);

// POST /api/clients/bulk-delete { ids?|all, filter? } — cascades payments/follow-ups.
router.post(
  "/bulk-delete",
  wrap(async (req, res) => {
    if (!isAdmin(req.user))
      throw forbidden("You do not have permission to delete customers.");
    const { ids, all, filter: f = {} } = req.body || {};
    let and;
    if (all) and = buildClientAnd(req.user, f);
    else {
      const list = (Array.isArray(ids) ? ids : []).map(oid).filter(Boolean);
      if (!list.length) throw bad("No customers selected.");
      and = [scopeFilter(req.user), { _id: { $in: list } }];
    }
    const docs = await Client.find({ $and: and }).select("_id").lean();
    for (const d of docs) await deleteClientCascade(d._id);
    emitChange("clients");
    emitChange("payments");
    emitChange("follow_ups");
    res.json({ ok: true, deleted: docs.length });
  }),
);

router.get(
  "/:id",
  wrap(async (req, res) => {
    const c = await loadAccessible(Client, req.user, idParam(req.params.id));
    await c.populate(ASSIGNEE);
    res.json(json(c));
  }),
);

router.post(
  "/",
  wrap(async (req, res) => {
    const data = clean(req.body, req.user);
    if (!data.name) throw bad("Name is required");
    if (data.assigned_to && !(await canAssignTo(req.user, data.assigned_to)))
      throw forbidden("You cannot assign this client to that person.");
    await stampOwnership(req.user, data);
    const c = await Client.create(data);
    emitChange("clients");
    await c.populate(ASSIGNEE);
    res.status(201).json(json(c));
  }),
);

router.patch(
  "/:id",
  wrap(async (req, res) => {
    const c = await loadAccessible(Client, req.user, idParam(req.params.id));
    const data = clean(req.body, req.user);
    if ("name" in data && !data.name) throw bad("Name is required");
    if (
      "assigned_to" in data &&
      !sameId(data.assigned_to, c.assigned_to) &&
      !(await canAssignTo(req.user, data.assigned_to))
    ) {
      throw forbidden("You cannot assign this client to that person.");
    }
    c.set(data);
    await c.save();
    emitChange("clients");
    await c.populate(ASSIGNEE);
    res.json(json(c));
  }),
);

router.delete(
  "/:id",
  wrap(async (req, res) => {
    if (!isAdmin(req.user))
      throw forbidden("You do not have permission to delete this client.");
    const c = await loadAccessible(Client, req.user, idParam(req.params.id));
    await deleteClientCascade(c._id);
    emitChange("clients");
    emitChange("payments");
    emitChange("follow_ups");
    res.json({ ok: true, count: 1 });
  }),
);

// POST /api/clients/:id/log-call  { outcome?, duration_seconds? }
// Record an outbound call to a customer (with optional answered/talk-time from
// the Android call log), exactly like a lead call.
const { callFields } = require("./leads");
router.post(
  "/:id/log-call",
  wrap(async (req, res) => {
    const c = await loadAccessible(Client, req.user, idParam(req.params.id));
    const { title, metadata } = callFields(req.body);
    // De-duplicate the same physical call (background receiver + on-open reconcile).
    if (metadata.call_ts) {
      const dup = await Activity.findOne({
        workspace_id: c.workspace_id,
        client_id: c._id,
        user_id: req.user._id,
        type: "call",
        "metadata.call_ts": metadata.call_ts,
      })
        .select("_id")
        .lean();
      if (dup) return res.json({ ok: true, duplicate: true });
    }
    await logActivity({
      client_id: c._id,
      type: "call",
      title,
      metadata,
      user_id: req.user._id,
      department_id: c.department_id,
      workspace_id: c.workspace_id,
    });
    c.last_contacted_at = new Date();
    await c.save();
    emitChange("clients");
    res.json({ ok: true });
  }),
);

module.exports = router;
