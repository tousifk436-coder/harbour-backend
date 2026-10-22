/** To-dos, notes, calendar, dashboard statistics and home-screen counters. */
const router = require("express").Router();
const { Todo, Note, Lead, Client, FollowUp, Task, Payment, ENUMS } = require("../models");
const { wrap, bad, forbidden, idParam, oid, pick, escapeRegex, notFound, startOfDay, endOfDay, ymd, json } = require("../utils/http");
const { scopeFilter, stampOwnership, loadAccessible, canAccessParent } = require("../utils/access");
const { myChannels } = require("../utils/chat");
const { emitChange } = require("../utils/realtime");

// ================= To-do (private to each user) =================
const TODO_FIELDS = ["title", "done", "due_at", "priority", "position"];

router.get("/todos", wrap(async (req, res) => {
  const rows = await Todo.find({ user_id: req.user._id }).sort({ done: 1, position: 1, created_at: 1 });
  res.json(rows.map(json));
}));
router.post("/todos", wrap(async (req, res) => {
  const d = pick(req.body, TODO_FIELDS);
  d.title = String(d.title || "").trim();
  if (!d.title) throw bad("Title is required");
  if (!d.due_at) d.due_at = null;
  if (d.position === undefined) d.position = await Todo.countDocuments({ user_id: req.user._id });
  const t = await Todo.create({ ...d, user_id: req.user._id });
  emitChange("todos", {}, [req.user._id]);
  res.status(201).json(json(t));
}));
router.patch("/todos/:id", wrap(async (req, res) => {
  const t = await Todo.findOne({ _id: idParam(req.params.id), user_id: req.user._id });
  if (!t) throw notFound();
  const d = pick(req.body, TODO_FIELDS);
  if ("title" in d) { d.title = String(d.title || "").trim(); if (!d.title) throw bad("Title is required"); }
  if ("due_at" in d && !d.due_at) d.due_at = null;
  t.set(d); await t.save();
  emitChange("todos", {}, [req.user._id]);
  res.json(json(t));
}));
router.delete("/todos/:id", wrap(async (req, res) => {
  await Todo.deleteOne({ _id: idParam(req.params.id), user_id: req.user._id });
  emitChange("todos", {}, [req.user._id]);
  res.json({ ok: true });
}));

// ================= Notes =================
const NOTE_FIELDS = ["title", "body", "color", "pinned", "lead_id", "client_id", "assigned_to"];
const NOTE_POP = [{ path: "lead", select: "name" }, { path: "client", select: "name" }, { path: "owner", select: "full_name" }];

function cleanNote(body) {
  const d = pick(body, NOTE_FIELDS);
  for (const k of ["lead_id", "client_id", "assigned_to"]) if (k in d) d[k] = oid(d[k]);
  if ("title" in d) d.title = String(d.title ?? "");
  if ("body" in d) d.body = String(d.body ?? "");
  if ("color" in d && !ENUMS.noteColor.includes(d.color)) d.color = "yellow";
  return d;
}

router.get("/notes", wrap(async (req, res) => {
  const q = req.query;
  const and = [scopeFilter(req.user)];
  if (q.lead_id) and.push({ lead_id: oid(q.lead_id) });
  if (q.client_id) and.push({ client_id: oid(q.client_id) });
  if (q.search && String(q.search).trim()) { const re = new RegExp(escapeRegex(String(q.search).trim()), "i"); and.push({ $or: [{ title: re }, { body: re }] }); }
  const rows = await Note.find({ $and: and }).sort({ pinned: -1, updated_at: -1 }).limit(500).populate(NOTE_POP);
  res.json(rows.map(json));
}));
router.post("/notes", wrap(async (req, res) => {
  const d = cleanNote(req.body);
  if ((d.lead_id || d.client_id) && !(await canAccessParent(req.user, d.lead_id, d.client_id))) throw forbidden("You cannot attach a note to that record.");
  if (req.user.role === "employee") d.assigned_to = req.user._id;
  await stampOwnership(req.user, d);
  const n = await Note.create(d);
  emitChange("notes");
  await n.populate(NOTE_POP);
  res.status(201).json(json(n));
}));
router.patch("/notes/:id", wrap(async (req, res) => {
  const n = await loadAccessible(Note, req.user, idParam(req.params.id));
  const d = cleanNote(req.body);
  delete d.assigned_to;
  if ((d.lead_id || d.client_id) && !(await canAccessParent(req.user, d.lead_id, d.client_id))) throw forbidden("You cannot attach a note to that record.");
  n.set(d); await n.save();
  emitChange("notes");
  await n.populate(NOTE_POP);
  res.json(json(n));
}));
router.delete("/notes/:id", wrap(async (req, res) => {
  const n = await loadAccessible(Note, req.user, idParam(req.params.id));
  await n.deleteOne();
  emitChange("notes");
  res.json({ ok: true });
}));

// ================= Calendar =================
async function calendarEvents(u, from, to) {
  const scope = scopeFilter(u);
  const [fus, tasks, todos] = await Promise.all([
    FollowUp.find({ $and: [scope, { due_at: { $gte: from, $lte: to } }] }).lean(),
    Task.find({ $and: [scope, { due_at: { $gte: from, $lte: to } }] }).lean(),
    Todo.find({ user_id: u._id, due_at: { $gte: from, $lte: to } }).lean(),
  ]);
  const s = (v) => (v ? String(v) : null);
  const rows = [
    ...fus.map((f) => ({ id: s(f._id), kind: f.type === "meeting" ? "meeting" : f.type === "reminder" ? "reminder" : "followup", title: f.title, starts_at: f.due_at, ends_at: f.ends_at || null, status: f.status, ref_id: s(f._id), lead_id: s(f.lead_id), client_id: s(f.client_id), assigned_to: s(f.assigned_to) })),
    ...tasks.map((t) => ({ id: s(t._id), kind: "task", title: t.title, starts_at: t.due_at, ends_at: null, status: t.status, ref_id: s(t._id), lead_id: s(t.lead_id), client_id: s(t.client_id), assigned_to: s(t.assigned_to) })),
    ...todos.map((d) => ({ id: s(d._id), kind: "todo", title: d.title, starts_at: d.due_at, ends_at: null, status: d.done ? "done" : "pending", ref_id: s(d._id), lead_id: null, client_id: null, assigned_to: s(d.user_id) })),
  ];
  rows.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  return rows;
}

router.get("/calendar", wrap(async (req, res) => {
  const from = new Date(String(req.query.from || ""));
  const to = new Date(String(req.query.to || ""));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw bad("from and to are required (ISO dates)");
  res.json(await calendarEvents(req.user, from, to));
}));

// ================= Dashboard =================
router.get("/dashboard", wrap(async (req, res) => {
  const u = req.user;
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400_000);
  const now = new Date();
  const scope = scopeFilter(u);
  const m = (extra) => ({ $and: [scope, extra] });

  const visibleClientIds = await Client.find(scope).distinct("_id");
  const payMatch = { client_id: { $in: visibleClientIds } };
  const sumPay = async (extra) => (await Payment.aggregate([{ $match: { ...payMatch, ...extra } }, { $group: { _id: null, s: { $sum: "$amount" } } }]))[0]?.s || 0;
  const groupCount = async (field) => Object.fromEntries((await Lead.aggregate([{ $match: scope }, { $group: { _id: `$${field}`, c: { $sum: 1 } } }])).map((r) => [r._id, r.c]));

  const [total_leads, new_leads, active_clients, total_clients, followups_pending, followups_overdue, followups_today, converted_leads,
    revenue_paid, revenue_pending, pipeline, leads_by_status, leads_by_source, perDay, perMonth] = await Promise.all([
    Lead.countDocuments(scope),
    Lead.countDocuments(m({ created_at: { $gte: since } })),
    Client.countDocuments(m({ service_status: { $in: ["onboarding", "in_progress"] } })),
    Client.countDocuments(scope),
    FollowUp.countDocuments(m({ status: "pending" })),
    FollowUp.countDocuments(m({ status: "pending", due_at: { $lt: now } })),
    FollowUp.countDocuments(m({ status: "pending", due_at: { $gte: startOfDay(), $lte: endOfDay() } })),
    Lead.countDocuments(m({ status: "won" })),
    sumPay({ status: "paid" }),
    sumPay({ status: { $in: ["pending", "overdue"] } }),
    Lead.aggregate([{ $match: m({ status: { $nin: ["won", "lost"] } }) }, { $group: { _id: null, s: { $sum: "$estimated_value" } } }]),
    groupCount("status"),
    groupCount("source"),
    Lead.find(m({ created_at: { $gte: since } })).select("created_at").lean(),
    Payment.find({ ...payMatch, status: "paid", paid_at: { $gte: new Date(Date.now() - 365 * 86400_000) } }).select("paid_at amount").lean(),
  ]);

  // bucket by day / month in the business timezone (TIMEZONE in .env)
  const byDay = {};
  for (const l of perDay) { const k = ymd(l.created_at); byDay[k] = (byDay[k] || 0) + 1; }
  const byMonth = {};
  for (const p of perMonth) { const k = ymd(p.paid_at).slice(0, 7); byMonth[k] = (byMonth[k] || 0) + p.amount; }

  res.json({
    total_leads, new_leads, active_clients, total_clients, followups_pending, followups_overdue, followups_today, converted_leads,
    conversion_rate: total_leads ? Math.round((1000 * converted_leads) / total_leads) / 10 : 0,
    revenue_paid, revenue_pending, pipeline_value: pipeline[0]?.s || 0,
    leads_by_status, leads_by_source,
    leads_per_day: Object.keys(byDay).sort().map((day) => ({ day, count: byDay[day] })),
    revenue_per_month: Object.keys(byMonth).sort().map((month) => ({ month, amount: Math.round(byMonth[month] * 100) / 100 })),
  });
}));

// ================= Home module counters =================
router.get("/module-counts", wrap(async (req, res) => {
  const u = req.user;
  const scope = scopeFilter(u);
  const m = (extra) => ({ $and: [scope, extra] });
  const now = new Date();
  const [leads, tasks, reminders, meetings, todos, notes, channels, today, clients, followups_overdue] = await Promise.all([
    Lead.countDocuments(m({ status: { $nin: ["won", "lost"] } })),
    Task.countDocuments(m({ status: { $ne: "done" } })),
    FollowUp.countDocuments(m({ type: "reminder", status: "pending" })),
    FollowUp.countDocuments(m({ type: "meeting", status: "pending", due_at: { $gte: now } })),
    Todo.countDocuments({ user_id: u._id, done: false }),
    Note.countDocuments(scope),
    myChannels(u._id),
    calendarEvents(u, startOfDay(), new Date(startOfDay().getTime() + 86400_000)),
    Client.countDocuments(m({ service_status: { $in: ["onboarding", "in_progress"] } })),
    FollowUp.countDocuments(m({ status: "pending", due_at: { $lt: now } })),
  ]);
  res.json({ leads, tasks, reminders, meetings, todos, notes, chat: channels.reduce((a, c) => a + c.unread, 0), calendar: today.length, clients, followups_overdue });
}));

module.exports = router;
