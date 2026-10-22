/** Activities (history), documents (file uploads) and payments — all belong to a lead or client. */
const router = require("express").Router();
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { Activity, Document, Payment, Client, ENUMS } = require("../models");
const { wrap, bad, forbidden, notFound, idParam, oid, pick, json } = require("../utils/http");
const { isAdmin, assertParent, parentDepartment } = require("../utils/access");
const { logActivity } = require("../utils/activity");
const { removeFiles } = require("../utils/cascade");
const { emitChange } = require("../utils/realtime");

// ---------------- Activities ----------------
router.get("/activities", wrap(async (req, res) => {
  const lead = oid(req.query.lead_id), client = oid(req.query.client_id);
  if (!lead && !client) throw bad("lead_id or client_id is required");
  await assertParent(req.user, lead, client);
  const or = [];
  if (lead) or.push({ lead_id: lead });
  if (client) or.push({ client_id: client });
  const rows = await Activity.find({ $or: or }).sort({ created_at: -1 }).limit(200).populate({ path: "user", select: "full_name" });
  res.json(rows.map(json));
}));

router.post("/activities", wrap(async (req, res) => {
  const lead = oid(req.body.lead_id), client = oid(req.body.client_id);
  if (!lead && !client) throw bad("lead_id or client_id is required");
  await assertParent(req.user, lead, client);
  const type = ENUMS.activityType.includes(req.body.type) ? req.body.type : "note";
  const title = String(req.body.title || "").trim();
  if (!title) throw bad("Title is required");
  const a = await logActivity({ lead_id: lead, client_id: client, type, title, body: req.body.body || null, user_id: req.user._id });
  res.status(201).json(json(a));
}));

router.delete("/activities/:id", wrap(async (req, res) => {
  const a = await Activity.findById(idParam(req.params.id));
  if (!a) throw notFound();
  await assertParent(req.user, a.lead_id, a.client_id);
  if (!isAdmin(req.user) && String(a.user_id) !== String(req.user._id)) throw forbidden();
  await a.deleteOne();
  emitChange("activities");
  res.json({ ok: true });
}));

// ---------------- Documents ----------------
const safeName = (n) => String(n || "file").replace(/[^\w.\-() ]+/g, "_").slice(0, 150);

const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const dir = path.join(config.uploadDir, req.docKind, String(req.docRecord));
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(_req, file, cb) {
      // multer gives latin1-decoded names; restore UTF-8
      file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
      cb(null, `${Date.now()}_${safeName(file.originalname)}`);
    },
  }),
  limits: { fileSize: config.maxUploadBytes, files: 10 },
});

router.get("/documents", wrap(async (req, res) => {
  const lead = oid(req.query.lead_id), client = oid(req.query.client_id);
  if (!lead && !client) throw bad("lead_id or client_id is required");
  await assertParent(req.user, lead, client);
  const filter = {};
  if (lead) filter.lead_id = lead;
  if (client) filter.client_id = client;
  const rows = await Document.find(filter).sort({ created_at: -1 }).populate({ path: "uploader", select: "full_name" });
  res.json(rows.map(json));
}));

// POST /api/documents?kind=lead|client&record_id=<id>   multipart field "file"
router.post("/documents",
  wrap(async (req, _res, next) => {
    const kind = req.query.kind;
    const rid = oid(req.query.record_id);
    if (!["lead", "client"].includes(kind) || !rid) throw bad("kind and record_id are required");
    await assertParent(req.user, kind === "lead" ? rid : null, kind === "client" ? rid : null);
    req.docKind = kind; req.docRecord = rid;
    next();
  }),
  (req, res, next) => upload.single("file")(req, res, next),
  wrap(async (req, res) => {
    const f = req.file;
    if (!f) throw bad("No file received");
    const rel = path.relative(config.uploadDir, f.path).split(path.sep).join("/");
    const lead_id = req.docKind === "lead" ? req.docRecord : null;
    const client_id = req.docKind === "client" ? req.docRecord : null;
    let doc;
    try {
      doc = await Document.create({
        lead_id, client_id, name: f.originalname, storage_path: rel, mime_type: f.mimetype || null, size_bytes: f.size,
        department_id: await parentDepartment(lead_id, client_id), uploaded_by: req.user._id,
      });
    } catch (e) { fs.unlink(f.path, () => {}); throw e; }
    await logActivity({ lead_id, client_id, type: "document", title: `Uploaded ${f.originalname}`, user_id: req.user._id });
    emitChange("documents");
    res.status(201).json(json(doc));
  }));

// GET /api/documents/:id/url -> { url } signed link valid for 10 minutes (opens in a new tab / browser)
router.get("/documents/:id/url", wrap(async (req, res) => {
  const d = await Document.findById(idParam(req.params.id));
  if (!d) throw notFound();
  await assertParent(req.user, d.lead_id, d.client_id);
  const token = jwt.sign({ doc: String(d._id), purpose: "file" }, config.jwtSecret, { expiresIn: "10m" });
  const base = config.publicApiUrl || `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base}/api/files/${d._id}?token=${token}` });
}));

router.delete("/documents/:id", wrap(async (req, res) => {
  const d = await Document.findById(idParam(req.params.id));
  if (!d) throw notFound();
  await assertParent(req.user, d.lead_id, d.client_id);
  if (!isAdmin(req.user) && String(d.uploaded_by) !== String(req.user._id)) throw forbidden("Only admins or the uploader can delete this document.");
  await removeFiles([d]);
  await d.deleteOne();
  emitChange("documents");
  res.json({ ok: true });
}));

/** Public file route used by signed URLs (mounted without requireAuth). */
const fileRouter = require("express").Router();
fileRouter.get("/:id", wrap(async (req, res) => {
  let payload;
  try { payload = jwt.verify(String(req.query.token || ""), config.jwtSecret); } catch { throw forbidden("This link has expired. Open the document again from the CRM."); }
  if (payload.purpose !== "file" || payload.doc !== req.params.id) throw forbidden();
  const d = await Document.findById(idParam(req.params.id));
  if (!d) throw notFound();
  const full = path.join(config.uploadDir, d.storage_path);
  if (!full.startsWith(config.uploadDir) || !fs.existsSync(full)) throw notFound("File missing on server");
  res.setHeader("Content-Type", d.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(d.name)}`);
  res.setHeader("Cache-Control", "private, max-age=600");
  fs.createReadStream(full).pipe(res);
}));

// ---------------- Payments ----------------
const PAY_FIELDS = ["amount", "currency", "status", "description", "due_at", "paid_at"];

router.get("/payments", wrap(async (req, res) => {
  const client = oid(req.query.client_id);
  if (!client) throw bad("client_id is required");
  await assertParent(req.user, null, client);
  res.json((await Payment.find({ client_id: client }).sort({ created_at: -1 })).map(json));
}));

router.post("/payments", wrap(async (req, res) => {
  const client = oid(req.body.client_id);
  if (!client) throw bad("client_id is required");
  await assertParent(req.user, null, client);
  const data = pick(req.body, PAY_FIELDS);
  data.amount = Number(data.amount);
  if (!(data.amount > 0)) throw bad("Amount must be greater than 0");
  if (!data.due_at) data.due_at = null;
  if (!data.description) data.description = null;
  if (data.status === "paid" && !data.paid_at) data.paid_at = new Date();
  const c = await Client.findById(client).select("department_id").lean();
  const p = await Payment.create({ ...data, client_id: client, department_id: c?.department_id ?? null, created_by: req.user._id });
  await logActivity({ client_id: client, type: "payment", title: `Payment recorded: ${p.currency} ${p.amount} (${p.status})`, user_id: req.user._id });
  emitChange("payments");
  res.status(201).json(json(p));
}));

router.patch("/payments/:id", wrap(async (req, res) => {
  const p = await Payment.findById(idParam(req.params.id));
  if (!p) throw notFound();
  await assertParent(req.user, null, p.client_id);
  const data = pick(req.body, PAY_FIELDS);
  if ("amount" in data) data.amount = Number(data.amount);
  if ("due_at" in data && !data.due_at) data.due_at = null;
  p.set(data);
  if (p.status === "paid" && !p.paid_at) p.paid_at = new Date();
  await p.save();
  emitChange("payments");
  res.json(json(p));
}));

router.delete("/payments/:id", wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw forbidden();
  const p = await Payment.findById(idParam(req.params.id));
  if (!p) throw notFound();
  await assertParent(req.user, null, p.client_id);
  await p.deleteOne();
  emitChange("payments");
  res.json({ ok: true });
}));

module.exports = router;
module.exports.fileRouter = fileRouter;
