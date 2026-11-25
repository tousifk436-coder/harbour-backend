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

router.get(
  "/",
  wrap(async (req, res) => {
    const q = req.query;
    const and = [
      scopeFilter(req.user),
      searchFilter(q.search, ["name", "email", "phone", "company"]),
    ];
    if (q.status) and.push({ service_status: q.status });
    if (q.assigned_to) and.push({ assigned_to: oid(q.assigned_to) });
    const rows = await Client.find({ $and: and })
      .sort({ created_at: -1 })
      .limit(2000)
      .populate(ASSIGNEE);
    res.json(rows.map(json));
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
