const router = require("express").Router();
const { Lead, Client, Activity, ENUMS } = require("../models");
const { wrap, bad, forbidden, idParam, oid, pick, blankToNull, escapeRegex, sameId, json } = require("../utils/http");
const { isAdmin, isSuper, scopeFilter, canAssignTo, stampOwnership, loadAccessible } = require("../utils/access");
const { logActivity } = require("../utils/activity");
const { deleteLeadCascade } = require("../utils/cascade");
const { emitChange } = require("../utils/realtime");

const FIELDS = ["name", "phone", "email", "company", "address", "source", "status", "estimated_value", "notes", "assigned_to"];
const TEXT = ["phone", "email", "company", "address", "notes"];
const SORTABLE = ["created_at", "updated_at", "name", "status", "source", "estimated_value", "company", "last_contacted_at", "email"];
const ASSIGNEE = { path: "assignee", select: "full_name" };

function clean(body, u) {
  const d = blankToNull(pick(body, [...FIELDS, "department_id"]), TEXT);
  if (!isSuper(u)) delete d.department_id; else if ("department_id" in d) d.department_id = oid(d.department_id);
  if ("assigned_to" in d) d.assigned_to = oid(d.assigned_to);
  if ("estimated_value" in d) d.estimated_value = Number(d.estimated_value) || 0;
  if ("name" in d) d.name = String(d.name || "").trim();
  return d;
}

function searchFilter(search, fields) {
  const s = String(search || "").trim();
  if (!s) return {};
  const re = new RegExp(escapeRegex(s), "i");
  return { $or: fields.map((f) => ({ [f]: re })) };
}

// GET /api/leads?search&status&source&assigned_to&sort&dir&page&pageSize -> { rows, count }
router.get("/", wrap(async (req, res) => {
  const q = req.query;
  const page = Math.max(0, Number(q.page) || 0);
  const size = Math.min(500, Math.max(1, Number(q.pageSize) || 25));
  const and = [scopeFilter(req.user), searchFilter(q.search, ["name", "email", "phone", "company"])];
  if (q.status) and.push({ status: q.status });
  if (q.source) and.push({ source: q.source });
  if (q.assigned_to) and.push({ assigned_to: oid(q.assigned_to) });
  const filter = { $and: and };
  const sortField = SORTABLE.includes(q.sort) ? q.sort : "created_at";
  const [rows, count] = await Promise.all([
    Lead.find(filter).sort({ [sortField]: q.dir === "asc" ? 1 : -1, _id: -1 }).skip(page * size).limit(size).populate(ASSIGNEE),
    Lead.countDocuments(filter),
  ]);
  res.json({ rows: rows.map(json), count });
}));

// GET /api/leads/export -> all visible leads (max 5000)
router.get("/export", wrap(async (req, res) => {
  const rows = await Lead.find(scopeFilter(req.user)).sort({ created_at: -1 }).limit(5000).populate(ASSIGNEE);
  res.json(rows.map(json));
}));

// POST /api/leads/import { rows: [...] } -> { count }
router.post("/import", wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (rows.length > 5000) throw bad("Import at most 5000 rows at a time");
  let count = 0;
  for (const r of rows) {
    const name = String(r.name || "").trim();
    if (!name) continue;
    let assigned = oid(r.assigned_to);
    if (assigned && !(await canAssignTo(req.user, assigned))) assigned = null;
    const data = {
      name, phone: r.phone || null, email: r.email || null, company: r.company || null, address: r.address || null,
      source: ENUMS.leadSource.includes(r.source) ? r.source : "other",
      status: ENUMS.leadStatus.includes(r.status) ? r.status : "new",
      estimated_value: Number(r.estimated_value) > 0 ? Number(r.estimated_value) : 0,
      notes: r.notes || null, assigned_to: assigned,
    };
    await stampOwnership(req.user, data);
    try {
      const lead = await Lead.create(data);
      await Activity.create({ lead_id: lead._id, type: "created", title: "Lead created", user_id: req.user._id, department_id: lead.department_id });
      count++;
    } catch (e) {
      if (e.name !== "ValidationError") throw e;   // skip invalid rows (e.g. bad email)
    }
  }
  emitChange("leads"); emitChange("activities");
  res.json({ count });
}));

router.get("/:id", wrap(async (req, res) => {
  const lead = await loadAccessible(Lead, req.user, idParam(req.params.id));
  await lead.populate(ASSIGNEE);
  res.json(json(lead));
}));

router.post("/", wrap(async (req, res) => {
  const data = clean(req.body, req.user);
  if (!data.name) throw bad("Name is required");
  if (data.assigned_to && !(await canAssignTo(req.user, data.assigned_to))) throw forbidden("You cannot assign this lead to that person.");
  await stampOwnership(req.user, data);
  const lead = await Lead.create(data);
  await logActivity({ lead_id: lead._id, type: "created", title: "Lead created", user_id: lead.created_by, department_id: lead.department_id });
  emitChange("leads");
  await lead.populate(ASSIGNEE);
  res.status(201).json(json(lead));
}));

router.patch("/:id", wrap(async (req, res) => {
  const lead = await loadAccessible(Lead, req.user, idParam(req.params.id));
  const data = clean(req.body, req.user);
  if ("name" in data && !data.name) throw bad("Name is required");
  const old = { status: lead.status, assigned_to: lead.assigned_to };
  if ("assigned_to" in data && !sameId(data.assigned_to, lead.assigned_to) && !(await canAssignTo(req.user, data.assigned_to))) {
    throw forbidden("You cannot assign this lead to that person.");
  }
  lead.set(data);
  await lead.save();
  if ("status" in data && data.status !== old.status) {
    await logActivity({ lead_id: lead._id, type: "status_change", title: `Status changed from ${old.status} to ${lead.status}`, metadata: { from: old.status, to: lead.status }, user_id: req.user._id, department_id: lead.department_id });
  }
  if ("assigned_to" in data && !sameId(old.assigned_to, lead.assigned_to)) {
    await logActivity({ lead_id: lead._id, type: "assignment", title: "Lead reassigned", metadata: { from: old.assigned_to ? String(old.assigned_to) : null, to: lead.assigned_to ? String(lead.assigned_to) : null }, user_id: req.user._id, department_id: lead.department_id });
  }
  emitChange("leads");
  await lead.populate(ASSIGNEE);
  res.json(json(lead));
}));

router.delete("/:id", wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw forbidden("You do not have permission to delete this lead.");
  const lead = await loadAccessible(Lead, req.user, idParam(req.params.id));
  await deleteLeadCascade(lead._id);
  emitChange("leads"); emitChange("follow_ups"); emitChange("documents");
  res.json({ ok: true, count: 1 });
}));

// POST /api/leads/:id/convert { service_name, contract_value } -> client
router.post("/:id/convert", wrap(async (req, res) => {
  const lead = await loadAccessible(Lead, req.user, idParam(req.params.id));
  if (lead.converted_client_id) throw bad("Lead has already been converted");
  const cv = req.body.contract_value;
  const client = await Client.create({
    lead_id: lead._id, name: lead.name, phone: lead.phone, email: lead.email, company: lead.company, address: lead.address,
    service_name: req.body.service_name || null,
    contract_value: cv !== undefined && cv !== null && cv !== "" && !Number.isNaN(Number(cv)) ? Number(cv) : lead.estimated_value,
    notes: lead.notes, assigned_to: lead.assigned_to, department_id: lead.department_id, created_by: req.user._id,
  });
  // atomic guard against double conversion
  const updated = await Lead.findOneAndUpdate({ _id: lead._id, converted_client_id: null }, { $set: { status: "won", converted_client_id: client._id } }, { new: true });
  if (!updated) { await Client.deleteOne({ _id: client._id }); throw bad("Lead has already been converted"); }
  if (lead.status !== "won") {
    await logActivity({ lead_id: lead._id, type: "status_change", title: `Status changed from ${lead.status} to won`, metadata: { from: lead.status, to: "won" }, user_id: req.user._id, department_id: lead.department_id });
  }
  await logActivity({ lead_id: lead._id, client_id: client._id, type: "converted", title: "Lead converted to client", user_id: req.user._id, department_id: lead.department_id });
  emitChange("leads"); emitChange("clients");
  res.json(json(client));
}));

module.exports = router;
module.exports.searchFilter = searchFilter;
