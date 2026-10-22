const router = require("express").Router();
const { Task } = require("../models");
const { wrap, bad, forbidden, idParam, oid, pick, blankToNull, sameId, json } = require("../utils/http");
const { isAdmin, scopeFilter, canAssignTo, stampOwnership, loadAccessible, assertParent } = require("../utils/access");
const { emitChange } = require("../utils/realtime");

const FIELDS = ["title", "description", "status", "priority", "due_at", "lead_id", "client_id", "assigned_to", "completed_at"];
const POP = [{ path: "lead", select: "name" }, { path: "client", select: "name" }, { path: "assignee", select: "full_name" }];
const STATUS_ORDER = { todo: 0, in_progress: 1, done: 2 };

function clean(body) {
  const d = blankToNull(pick(body, FIELDS), ["description"]);
  for (const k of ["lead_id", "client_id", "assigned_to"]) if (k in d) d[k] = oid(d[k]);
  if ("due_at" in d && !d.due_at) d.due_at = null;
  if ("title" in d) d.title = String(d.title || "").trim();
  return d;
}

router.get("/", wrap(async (req, res) => {
  const q = req.query;
  const and = [scopeFilter(req.user)];
  if (q.status) and.push({ status: q.status });
  if (q.assigned_to) and.push({ assigned_to: oid(q.assigned_to) });
  if (q.lead_id) and.push({ lead_id: oid(q.lead_id) });
  if (q.client_id) and.push({ client_id: oid(q.client_id) });
  const rows = await Task.find({ $and: and }).limit(500).populate(POP);
  // status (todo → in progress → done), then due date with empty dates last
  rows.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    || ((a.due_at ? a.due_at.getTime() : Infinity) - (b.due_at ? b.due_at.getTime() : Infinity)));
  res.json(rows.map(json));
}));

router.post("/", wrap(async (req, res) => {
  const data = clean(req.body);
  if (!data.title) throw bad("Title is required");
  if (data.lead_id || data.client_id) await assertParent(req.user, data.lead_id, data.client_id);
  if (data.assigned_to && !(await canAssignTo(req.user, data.assigned_to))) throw forbidden("You cannot assign this task to that person.");
  data.completed_at = data.status === "done" ? new Date() : null;
  await stampOwnership(req.user, data);
  const t = await Task.create(data);
  emitChange("tasks");
  await t.populate(POP);
  res.status(201).json(json(t));
}));

router.patch("/:id", wrap(async (req, res) => {
  const t = await loadAccessible(Task, req.user, idParam(req.params.id));
  const data = clean(req.body);
  if ("title" in data && !data.title) throw bad("Title is required");
  if ("assigned_to" in data && !sameId(data.assigned_to, t.assigned_to) && !(await canAssignTo(req.user, data.assigned_to))) {
    throw forbidden("You cannot assign this task to that person.");
  }
  t.set(data);
  if (t.status === "done" && !t.completed_at) t.completed_at = new Date();
  if (t.status !== "done") t.completed_at = null;
  await t.save();
  emitChange("tasks");
  await t.populate(POP);
  res.json(json(t));
}));

router.delete("/:id", wrap(async (req, res) => {
  const t = await loadAccessible(Task, req.user, idParam(req.params.id));
  if (!isAdmin(req.user) && !sameId(t.created_by, req.user._id)) throw forbidden("Only admins or the person who created the task can delete it.");
  await t.deleteOne();
  emitChange("tasks");
  res.json({ ok: true });
}));

module.exports = router;
