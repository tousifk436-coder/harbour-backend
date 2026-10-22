const router = require("express").Router();
const { Client } = require("../models");
const { wrap, bad, forbidden, idParam, oid, pick, blankToNull, sameId, json } = require("../utils/http");
const { isAdmin, isSuper, scopeFilter, canAssignTo, stampOwnership, loadAccessible } = require("../utils/access");
const { deleteClientCascade } = require("../utils/cascade");
const { emitChange } = require("../utils/realtime");
const { searchFilter } = require("./leads");

const FIELDS = ["name", "phone", "email", "company", "address", "service_status", "service_name", "contract_value", "notes", "assigned_to", "lead_id"];
const TEXT = ["phone", "email", "company", "address", "notes", "service_name"];
const ASSIGNEE = { path: "assignee", select: "full_name" };

function clean(body, u) {
  const d = blankToNull(pick(body, [...FIELDS, "department_id"]), TEXT);
  if (!isSuper(u)) delete d.department_id; else if ("department_id" in d) d.department_id = oid(d.department_id);
  if ("assigned_to" in d) d.assigned_to = oid(d.assigned_to);
  if ("lead_id" in d) d.lead_id = oid(d.lead_id);
  if ("contract_value" in d) d.contract_value = Number(d.contract_value) || 0;
  if ("name" in d) d.name = String(d.name || "").trim();
  return d;
}

router.get("/", wrap(async (req, res) => {
  const q = req.query;
  const and = [scopeFilter(req.user), searchFilter(q.search, ["name", "email", "phone", "company"])];
  if (q.status) and.push({ service_status: q.status });
  if (q.assigned_to) and.push({ assigned_to: oid(q.assigned_to) });
  const rows = await Client.find({ $and: and }).sort({ created_at: -1 }).limit(2000).populate(ASSIGNEE);
  res.json(rows.map(json));
}));

router.get("/:id", wrap(async (req, res) => {
  const c = await loadAccessible(Client, req.user, idParam(req.params.id));
  await c.populate(ASSIGNEE);
  res.json(json(c));
}));

router.post("/", wrap(async (req, res) => {
  const data = clean(req.body, req.user);
  if (!data.name) throw bad("Name is required");
  if (data.assigned_to && !(await canAssignTo(req.user, data.assigned_to))) throw forbidden("You cannot assign this client to that person.");
  await stampOwnership(req.user, data);
  const c = await Client.create(data);
  emitChange("clients");
  await c.populate(ASSIGNEE);
  res.status(201).json(json(c));
}));

router.patch("/:id", wrap(async (req, res) => {
  const c = await loadAccessible(Client, req.user, idParam(req.params.id));
  const data = clean(req.body, req.user);
  if ("name" in data && !data.name) throw bad("Name is required");
  if ("assigned_to" in data && !sameId(data.assigned_to, c.assigned_to) && !(await canAssignTo(req.user, data.assigned_to))) {
    throw forbidden("You cannot assign this client to that person.");
  }
  c.set(data);
  await c.save();
  emitChange("clients");
  await c.populate(ASSIGNEE);
  res.json(json(c));
}));

router.delete("/:id", wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw forbidden("You do not have permission to delete this client.");
  const c = await loadAccessible(Client, req.user, idParam(req.params.id));
  await deleteClientCascade(c._id);
  emitChange("clients"); emitChange("payments"); emitChange("follow_ups");
  res.json({ ok: true, count: 1 });
}));

module.exports = router;
