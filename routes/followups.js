/** Follow-ups, reminders and meetings (one collection, distinguished by `type`). */
const router = require("express").Router();
const { FollowUp, Lead } = require("../models");
const { wrap, bad, forbidden, idParam, oid, pick, blankToNull, sameId, startOfDay, endOfDay, json } = require("../utils/http");
const { scopeFilter, canAssignTo, stampOwnership, loadAccessible, assertParent } = require("../utils/access");
const { logActivity, cap } = require("../utils/activity");
const { emitChange } = require("../utils/realtime");

const FIELDS = ["lead_id", "client_id", "type", "title", "due_at", "ends_at", "status", "notes", "outcome", "location", "meeting_link", "attendees", "assigned_to"];
const TEXT = ["notes", "outcome", "location", "meeting_link"];
const POP = [{ path: "lead", select: "name phone" }, { path: "client", select: "name phone" }, { path: "assignee", select: "full_name" }];

function clean(body) {
  const d = blankToNull(pick(body, FIELDS), TEXT);
  for (const k of ["lead_id", "client_id", "assigned_to"]) if (k in d) d[k] = oid(d[k]);
  if ("attendees" in d) d.attendees = (Array.isArray(d.attendees) ? d.attendees : []).map(oid).filter(Boolean);
  if ("ends_at" in d && !d.ends_at) d.ends_at = null;
  if ("title" in d) d.title = String(d.title || "").trim();
  return d;
}
const changed = () => { emitChange("follow_ups"); };

// GET /api/follow-ups?scope=upcoming|overdue|today|done|all&lead_id&client_id&type
router.get("/", wrap(async (req, res) => {
  const q = req.query;
  const and = [scopeFilter(req.user)];
  const now = new Date();
  switch (q.scope) {
    case "upcoming": and.push({ status: "pending", due_at: { $gte: now } }); break;
    case "overdue": and.push({ status: "pending", due_at: { $lt: now } }); break;
    case "today": and.push({ status: "pending", due_at: { $gte: startOfDay(), $lte: endOfDay() } }); break;
    case "done": and.push({ status: "done" }); break;
    default: break;
  }
  if (q.lead_id) and.push({ lead_id: oid(q.lead_id) });
  if (q.client_id) and.push({ client_id: oid(q.client_id) });
  if (q.type) and.push({ type: q.type });
  const rows = await FollowUp.find({ $and: and }).sort(q.scope === "done" ? { completed_at: -1, due_at: 1 } : { due_at: 1 }).limit(500).populate(POP);
  res.json(rows.map(json));
}));

router.get("/:id", wrap(async (req, res) => {
  const f = await loadAccessible(FollowUp, req.user, idParam(req.params.id));
  await f.populate(POP);
  res.json(json(f));
}));

router.post("/", wrap(async (req, res) => {
  const data = clean(req.body);
  if (!data.title) throw bad("Title is required");
  if (!data.due_at) throw bad("Date is required");
  if (data.lead_id || data.client_id) await assertParent(req.user, data.lead_id, data.client_id);
  if (data.assigned_to && !(await canAssignTo(req.user, data.assigned_to))) throw forbidden("You cannot assign this to that person.");
  delete data.outcome;
  if (data.status === "done") data.completed_at = new Date();
  await stampOwnership(req.user, data);
  const f = await FollowUp.create(data);
  changed();
  await f.populate(POP);
  res.status(201).json(json(f));
}));

router.patch("/:id", wrap(async (req, res) => {
  const f = await loadAccessible(FollowUp, req.user, idParam(req.params.id));
  const data = clean(req.body);
  delete data.lead_id; delete data.client_id;
  if ("title" in data && !data.title) throw bad("Title is required");
  if ("assigned_to" in data && !sameId(data.assigned_to, f.assigned_to) && !(await canAssignTo(req.user, data.assigned_to))) {
    throw forbidden("You cannot assign this to that person.");
  }
  const wasDone = f.status === "done";
  const oldDue = f.due_at ? f.due_at.getTime() : null;
  f.set(data);
  if (data.due_at && new Date(data.due_at).getTime() !== oldDue) f.notified_at = null;   // re-arm push reminder
  const nowDone = f.status === "done" && !wasDone;
  if (nowDone) f.completed_at = new Date();
  if (f.status !== "done") f.completed_at = null;
  await f.save();

  if (nowDone && (f.lead_id || f.client_id)) {
    const actType = ["call", "meeting", "email"].includes(f.type) ? f.type : "note";
    await logActivity({ lead_id: f.lead_id, client_id: f.client_id, type: actType, title: `${cap(f.type)} completed: ${f.title}`, body: f.outcome || f.notes || null, user_id: req.user._id, department_id: f.department_id });
    if (f.lead_id) { await Lead.updateOne({ _id: f.lead_id }, { $set: { last_contacted_at: new Date() } }); emitChange("leads"); }
  }
  changed();
  await f.populate(POP);
  res.json(json(f));
}));

router.delete("/:id", wrap(async (req, res) => {
  const f = await loadAccessible(FollowUp, req.user, idParam(req.params.id));
  await f.deleteOne();
  changed();
  res.json({ ok: true });
}));

module.exports = router;
