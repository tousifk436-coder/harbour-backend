const router = require("express").Router();
const {
  Lead,
  LeadStage,
  Client,
  Activity,
  User,
  EMAIL_RE,
  digits,
} = require("../models");
const {
  wrap,
  bad,
  forbidden,
  idParam,
  oid,
  pick,
  blankToNull,
  escapeRegex,
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
const { logActivity } = require("../utils/activity");
const { deleteLeadCascade } = require("../utils/cascade");
const { emitChange } = require("../utils/realtime");
const { masterKeySet } = require("../utils/masters");

const FIELDS = [
  "name",
  "phone",
  "email",
  "company",
  "address",
  "source",
  "source_dataset",
  "status",
  "estimated_value",
  "notes",
  "assigned_to",
];
const TEXT = ["phone", "email", "company", "address", "notes"];
const SORTABLE = [
  "created_at",
  "updated_at",
  "name",
  "status",
  "source",
  "estimated_value",
  "company",
  "last_contacted_at",
  "email",
];
const ASSIGNEE = { path: "assignee", select: "full_name" };
const SHARED = { path: "shared_with", select: "full_name" };

// Stages are admin-managed per company (LeadStage). These helpers validate a
// lead's status against the company's stage list and find semantic stages.
async function stageKeySet(ws) {
  const rows = await LeadStage.find({ workspace_id: ws }).select("key").lean();
  return new Set(rows.map((r) => r.key));
}
async function defaultStageKey(ws) {
  const s =
    (await LeadStage.findOne({ workspace_id: ws, role: "new" })
      .select("key")
      .lean()) ||
    (await LeadStage.findOne({ workspace_id: ws })
      .sort({ position: 1 })
      .select("key")
      .lean());
  return s ? s.key : "new_lead";
}
async function wonStageKey(ws) {
  const s = await LeadStage.findOne({ workspace_id: ws, role: "won" })
    .select("key")
    .lean();
  return s ? s.key : "sale_done";
}

function clean(body, u) {
  const d = blankToNull(pick(body, [...FIELDS, "department_id"]), TEXT);
  if (!isSuper(u)) delete d.department_id;
  else if ("department_id" in d) d.department_id = oid(d.department_id);
  if ("assigned_to" in d) d.assigned_to = oid(d.assigned_to);
  if ("estimated_value" in d)
    d.estimated_value = Number(d.estimated_value) || 0;
  if ("name" in d) d.name = String(d.name || "").trim();
  return d;
}

// Normalise + permission-check the optional co-assignee list ("+1" sharing).
// Returns undefined when the caller didn't send shared_with (leave it untouched),
// otherwise an array of ObjectIds the caller is allowed to assign to.
async function resolveShared(u, body, primaryId) {
  if (!("shared_with" in body)) return undefined;
  const raw = Array.isArray(body.shared_with) ? body.shared_with : [];
  const ids = [...new Set(raw.map((x) => (x && x.id) || x).map(String))]
    .map(oid)
    .filter(Boolean)
    .filter((id) => !primaryId || String(id) !== String(primaryId));
  const ok = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await canAssignTo(u, id)))
      throw forbidden("You cannot share this lead with that person.");
    ok.push(id);
  }
  return ok;
}

function searchFilter(search, fields) {
  const s = String(search || "").trim();
  if (!s) return {};
  const re = new RegExp(escapeRegex(s), "i");
  return { $or: fields.map((f) => ({ [f]: re })) };
}

// GET /api/leads?search&status&source&assigned_to&sort&dir&page&pageSize -> { rows, count }
router.get(
  "/",
  wrap(async (req, res) => {
    const q = req.query;
    const page = Math.max(0, Number(q.page) || 0);
    const size = Math.min(500, Math.max(1, Number(q.pageSize) || 25));
    const and = [
      scopeFilter(req.user),
      searchFilter(q.search, ["name", "email", "phone", "company"]),
    ];
    if (q.status) and.push({ status: q.status });
    if (q.source) and.push({ source: q.source });
    if (q.source_dataset) and.push({ source_dataset: q.source_dataset });
    // Filter by a person = leads they OWN, are CO-ASSIGNED (shared) on, or
    // CREATED/IMPORTED. So the person who imported a batch can filter to it even
    // before anyone is assigned. The special value "unassigned" lists leads with
    // no owner yet, so admins can find and distribute them.
    if (q.assigned_to === "unassigned") {
      and.push({ assigned_to: null });
    } else if (q.assigned_to) {
      const aid = oid(q.assigned_to);
      and.push({
        $or: [{ assigned_to: aid }, { shared_with: aid }, { created_by: aid }],
      });
    }
    const filter = { $and: and };
    const sortField = SORTABLE.includes(q.sort) ? q.sort : "created_at";
    // Speed: the list rows don't use notes/address, so skip those big fields;
    // and only count the total on the FIRST page (the app reads count from page 0
    // only — counting on every scroll page was wasted work).
    const [rows, count] = await Promise.all([
      Lead.find(filter)
        .sort({ [sortField]: q.dir === "asc" ? 1 : -1, _id: -1 })
        .skip(page * size)
        .limit(size)
        .select("-notes -address")
        .populate(ASSIGNEE)
        .populate(SHARED),
      page === 0 ? Lead.countDocuments(filter) : Promise.resolve(undefined),
    ]);
    res.json({ rows: rows.map(json), count });
  }),
);

// GET /api/leads/export -> all visible leads (max 5000)
router.get(
  "/export",
  wrap(async (req, res) => {
    const rows = await Lead.find(scopeFilter(req.user))
      .sort({ created_at: -1 })
      .limit(5000)
      .populate(ASSIGNEE);
    res.json(rows.map(json));
  }),
);

// POST /api/leads/bulk-assign
//   body: { ids?: string[], all?: boolean,
//           filter?: { search, status, source, assigned_to },
//           assigned_to: string, mode: "transfer" | "share" }
router.post(
  "/bulk-assign",
  wrap(async (req, res) => {
    const { ids, all, filter: f = {}, assigned_to, mode } = req.body || {};
    const target = oid(assigned_to);
    if (!target) throw bad("Pick an agent to assign to.");
    if (mode !== "transfer" && mode !== "share")
      throw bad("Invalid assign mode.");
    if (!(await canAssignTo(req.user, target)))
      throw forbidden("You cannot assign leads to that person.");

    // Always limited to the leads this user is allowed to see (company + role).
    const and = [scopeFilter(req.user)];
    if (all) {
      and.push(searchFilter(f.search, ["name", "email", "phone", "company"]));
      if (f.status) and.push({ status: f.status });
      if (f.source) and.push({ source: f.source });
      if (f.source_dataset) and.push({ source_dataset: f.source_dataset });
      if (f.assigned_to === "unassigned") {
        and.push({ assigned_to: null });
      } else if (f.assigned_to) {
        const aid = oid(f.assigned_to);
        and.push({
          $or: [
            { assigned_to: aid },
            { shared_with: aid },
            { created_by: aid },
          ],
        });
      }
    } else {
      const list = (Array.isArray(ids) ? ids : []).map(oid).filter(Boolean);
      if (!list.length) throw bad("No leads selected.");
      and.push({ _id: { $in: list } });
    }

    let result;
    if (mode === "transfer") {
      // Move ownership to the target. Stage/history untouched.
      // Also drop the target from the co-assignee list if present.
      result = await Lead.updateMany(
        { $and: and },
        { $set: { assigned_to: target }, $pull: { shared_with: target } },
      );
    } else {
      // "Keep in both": a lead needs a real owner before it can be "shared".
      //  - Leads with no owner yet (e.g. just imported): this is their FIRST
      //    assignment, so simply set the owner — no phantom "+1" on an
      //    otherwise-unassigned lead.
      //  - Leads that already have a different owner: keep that owner and add
      //    the target as a co-assignee.
      const firstAssign = await Lead.updateMany(
        { $and: [...and, { assigned_to: null }] },
        { $set: { assigned_to: target }, $pull: { shared_with: target } },
      );
      const coAssign = await Lead.updateMany(
        {
          $and: [
            ...and,
            { assigned_to: { $ne: null } },
            { assigned_to: { $ne: target } },
          ],
        },
        { $addToSet: { shared_with: target } },
      );
      result = {
        modifiedCount:
          (firstAssign.modifiedCount ?? firstAssign.nModified ?? 0) +
          (coAssign.modifiedCount ?? coAssign.nModified ?? 0),
      };
    }

    emitChange("leads");
    res.json({
      ok: true,
      modified: result.modifiedCount ?? result.nModified ?? 0,
    });
  }),
);

// POST /api/leads/import { rows: [...] } -> { count }
router.post(
  "/import",
  wrap(async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length > 5000) throw bad("Import at most 5000 rows at a time");
    const me = req.user;
    const ws = me.workspace_id;
    const stageKeys = await stageKeySet(ws);
    const defKey = await defaultStageKey(ws);
    const sourceKeys = await masterKeySet(ws, "lead_source");
    const dataset =
      String(req.body.dataset_name || "")
        .trim()
        .slice(0, 160) || null;

    // Load every assigned user once, so the loop below does no per-row DB calls.
    const wantedIds = [
      ...new Set(
        rows
          .map((r) => oid(r.assigned_to))
          .filter(Boolean)
          .map(String),
      ),
    ];
    const users = wantedIds.length
      ? await User.find({ _id: { $in: wantedIds }, workspace_id: ws })
          .select("department_id role")
          .lean()
      : [];
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const canAssign = (target) => {
      const u = target && userMap.get(String(target));
      if (!u) return false;
      if (me.role === "super_admin") return true;
      if (sameId(target, me._id)) return true;
      if (me.role === "admin")
        return (
          u.department_id != null && sameId(u.department_id, me.department_id)
        );
      return false;
    };

    // Build all lead documents in memory (phone_digits/email handled manually
    // because insertMany bypasses the save hook).
    const docs = [];
    for (const r of rows) {
      const name = String(r.name || "")
        .trim()
        .slice(0, 200);
      if (!name) continue;
      let assigned = oid(r.assigned_to);
      if (assigned && !canAssign(assigned)) assigned = null;
      if (me.role === "employee") assigned = me._id;
      const au = assigned ? userMap.get(String(assigned)) : null;
      let email = r.email ? String(r.email).trim() : null;
      if (email && !EMAIL_RE.test(email)) email = null; // keep the lead, drop the bad email
      const phone = r.phone || null;
      docs.push({
        workspace_id: ws,
        name,
        phone,
        phone_digits: digits(phone),
        email,
        company: r.company || null,
        address: r.address || null,
        source: sourceKeys.has(r.source) ? r.source : "other",
        source_dataset:
          dataset ||
          String(r.source_dataset || "")
            .trim()
            .slice(0, 160) ||
          null,
        status: stageKeys.has(r.status) ? r.status : defKey,
        estimated_value:
          Number(r.estimated_value) > 0 ? Number(r.estimated_value) : 0,
        notes: r.notes || null,
        assigned_to: assigned,
        department_id: (au && au.department_id) || me.department_id || null,
        created_by: me._id,
      });
    }

    // Two bulk writes instead of thousands of single inserts.
    let inserted = [];
    if (docs.length) {
      try {
        inserted = await Lead.insertMany(docs, { ordered: false });
      } catch (e) {
        inserted = e.insertedDocs || []; // ordered:false still inserts the good rows
        if (!inserted.length && !e.insertedDocs) throw e;
      }
    }
    if (inserted.length) {
      await Activity.insertMany(
        inserted.map((lead) => ({
          workspace_id: lead.workspace_id,
          lead_id: lead._id,
          type: "created",
          title: "Lead created",
          user_id: me._id,
          department_id: lead.department_id,
        })),
        { ordered: false },
      );
    }

    emitChange("leads");
    emitChange("activities");
    res.json({ count: inserted.length });
  }),
);

router.get(
  "/:id",
  wrap(async (req, res) => {
    const lead = await loadAccessible(Lead, req.user, idParam(req.params.id));
    await lead.populate(ASSIGNEE);
    await lead.populate(SHARED);
    res.json(json(lead));
  }),
);

router.post(
  "/",
  wrap(async (req, res) => {
    const data = clean(req.body, req.user);
    if (!data.name) throw bad("Name is required");
    if (data.status) {
      const keys = await stageKeySet(req.user.workspace_id);
      if (!keys.has(data.status)) throw bad("Unknown lead stage.");
    } else {
      data.status = await defaultStageKey(req.user.workspace_id);
    }
    if (data.assigned_to && !(await canAssignTo(req.user, data.assigned_to)))
      throw forbidden("You cannot assign this lead to that person.");
    await stampOwnership(req.user, data);
    const shared = await resolveShared(req.user, req.body, data.assigned_to);
    if (shared !== undefined) data.shared_with = shared;
    const lead = await Lead.create(data);
    await logActivity({
      lead_id: lead._id,
      type: "created",
      title: "Lead created",
      user_id: lead.created_by,
      department_id: lead.department_id,
    });
    emitChange("leads");
    await lead.populate(ASSIGNEE);
    await lead.populate(SHARED);
    res.status(201).json(json(lead));
  }),
);

router.patch(
  "/:id",
  wrap(async (req, res) => {
    const lead = await loadAccessible(Lead, req.user, idParam(req.params.id));
    const data = clean(req.body, req.user);
    if ("name" in data && !data.name) throw bad("Name is required");
    if ("status" in data && data.status) {
      const keys = await stageKeySet(req.user.workspace_id);
      if (!keys.has(data.status)) throw bad("Unknown lead stage.");
    }
    const old = { status: lead.status, assigned_to: lead.assigned_to };
    if (
      "assigned_to" in data &&
      !sameId(data.assigned_to, lead.assigned_to) &&
      !(await canAssignTo(req.user, data.assigned_to))
    ) {
      throw forbidden("You cannot assign this lead to that person.");
    }
    lead.set(data);
    const shared = await resolveShared(req.user, req.body, lead.assigned_to);
    if (shared !== undefined) lead.shared_with = shared;
    await lead.save();
    // Speed: run the history log(s) and both populates together instead of one
    // after another — fewer sequential round-trips, so a stage change returns faster.
    const after = [];
    if ("status" in data && data.status !== old.status) {
      after.push(
        logActivity({
          lead_id: lead._id,
          type: "status_change",
          title: `Status changed from ${old.status} to ${lead.status}`,
          metadata: { from: old.status, to: lead.status },
          user_id: req.user._id,
          department_id: lead.department_id,
        }),
      );
    }
    if ("assigned_to" in data && !sameId(old.assigned_to, lead.assigned_to)) {
      after.push(
        logActivity({
          lead_id: lead._id,
          type: "assignment",
          title: "Lead reassigned",
          metadata: {
            from: old.assigned_to ? String(old.assigned_to) : null,
            to: lead.assigned_to ? String(lead.assigned_to) : null,
          },
          user_id: req.user._id,
          department_id: lead.department_id,
        }),
      );
    }
    after.push(lead.populate(ASSIGNEE));
    after.push(lead.populate(SHARED));
    emitChange("leads");
    await Promise.all(after);
    res.json(json(lead));
  }),
);

router.delete(
  "/:id",
  wrap(async (req, res) => {
    if (!isAdmin(req.user))
      throw forbidden("You do not have permission to delete this lead.");
    const lead = await loadAccessible(Lead, req.user, idParam(req.params.id));
    await deleteLeadCascade(lead._id);
    emitChange("leads");
    emitChange("follow_ups");
    emitChange("documents");
    res.json({ ok: true, count: 1 });
  }),
);

// POST /api/leads/:id/convert { service_name, contract_value } -> client
router.post(
  "/:id/convert",
  wrap(async (req, res) => {
    const lead = await loadAccessible(Lead, req.user, idParam(req.params.id));
    if (lead.converted_client_id) throw bad("Lead has already been converted");
    const cv = req.body.contract_value;
    const client = await Client.create({
      workspace_id: lead.workspace_id,
      lead_id: lead._id,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      company: lead.company,
      address: lead.address,
      service_name: req.body.service_name || null,
      contract_value:
        cv !== undefined &&
        cv !== null &&
        cv !== "" &&
        !Number.isNaN(Number(cv))
          ? Number(cv)
          : lead.estimated_value,
      notes: lead.notes,
      assigned_to: lead.assigned_to,
      department_id: lead.department_id,
      created_by: req.user._id,
    });
    // atomic guard against double conversion
    const won = await wonStageKey(req.user.workspace_id);
    const updated = await Lead.findOneAndUpdate(
      { _id: lead._id, converted_client_id: null },
      { $set: { status: won, converted_client_id: client._id } },
      { new: true },
    );
    if (!updated) {
      await Client.deleteOne({ _id: client._id });
      throw bad("Lead has already been converted");
    }
    if (lead.status !== won) {
      await logActivity({
        lead_id: lead._id,
        type: "status_change",
        title: `Status changed from ${lead.status} to ${won}`,
        metadata: { from: lead.status, to: won },
        user_id: req.user._id,
        department_id: lead.department_id,
      });
    }
    await logActivity({
      lead_id: lead._id,
      client_id: client._id,
      type: "converted",
      title: "Lead converted to client",
      user_id: req.user._id,
      department_id: lead.department_id,
    });
    emitChange("leads");
    emitChange("clients");
    res.json(json(client));
  }),
);

// Format a call's talk time for the activity title, e.g. 134 -> "2m 14s".
function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}
const CALL_OUTCOMES = new Set(["answered", "not_answered"]);

// Build the title + metadata for a logged call from optional outcome/duration.
function callFields(body) {
  const outcome = CALL_OUTCOMES.has(body.outcome) ? body.outcome : null;
  let dur = Number(body.duration_seconds);
  if (!Number.isFinite(dur) || dur < 0) dur = 0;
  // not-answered calls have no talk time
  if (outcome !== "answered") dur = outcome === "not_answered" ? 0 : dur;
  let title = "Outbound call";
  if (outcome === "answered")
    title = dur
      ? `Outbound call — Answered (${fmtDur(dur)})`
      : "Outbound call — Answered";
  else if (outcome === "not_answered") title = "Outbound call — Not answered";
  // call_ts = the device call-log entry's own timestamp (ms). Used to de-duplicate
  // the same physical call when it arrives from more than one source
  // (background receiver + on-open reconcile).
  const callTs = Number(body.call_ts);
  const metadata = {
    outcome,
    duration_seconds: outcome === "answered" ? dur : 0,
  };
  if (Number.isFinite(callTs) && callTs > 0) metadata.call_ts = callTs;
  return { title, metadata };
}

// POST /api/leads/:id/log-call  { outcome?, duration_seconds? }
// Records an outbound call so the agent-outreach report has real data. Called
// when an agent taps "Call". On Android the app can also send the call outcome
// (answered / not_answered) and talk time read from the device call log; iPhone
// and web just record that a call was placed.
router.post(
  "/:id/log-call",
  wrap(async (req, res) => {
    const lead = await loadAccessible(Lead, req.user, idParam(req.params.id));
    const { title, metadata } = callFields(req.body);
    // De-duplicate: if this exact call (same lead + caller + call_ts) was already
    // logged, don't log it again. Covers the background receiver and the on-open
    // reconcile both reporting the same physical call.
    if (metadata.call_ts) {
      const dup = await Activity.findOne({
        workspace_id: lead.workspace_id,
        lead_id: lead._id,
        user_id: req.user._id,
        type: "call",
        "metadata.call_ts": metadata.call_ts,
      })
        .select("_id")
        .lean();
      if (dup) return res.json({ ok: true, duplicate: true });
    }
    await logActivity({
      lead_id: lead._id,
      type: "call",
      title,
      metadata,
      user_id: req.user._id,
      department_id: lead.department_id,
      workspace_id: lead.workspace_id,
    });
    lead.last_contacted_at = new Date();
    await lead.save();
    emitChange("leads");
    res.json({ ok: true });
  }),
);

module.exports = router;
module.exports.searchFilter = searchFilter;
module.exports.callFields = callFields;
