/** Activities (history), documents (file uploads) and payments — all belong to a lead or client. */
const router = require("express").Router();
const multer = require("multer");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { Activity, Document, Payment, Client, ENUMS } = require("../models");
const {
  wrap,
  bad,
  forbidden,
  notFound,
  idParam,
  oid,
  pick,
  json,
} = require("../utils/http");
const { isAdmin, assertParent, parentDepartment } = require("../utils/access");
const { logActivity } = require("../utils/activity");
const { removeFiles } = require("../utils/cascade");
const { saveFile, openFile, deleteFiles } = require("../utils/files");
const { emitChange } = require("../utils/realtime");

// ---------------- Activities ----------------
router.get(
  "/activities",
  wrap(async (req, res) => {
    const lead = oid(req.query.lead_id),
      client = oid(req.query.client_id);
    if (!lead && !client) throw bad("lead_id or client_id is required");
    await assertParent(req.user, lead, client);
    const or = [];
    if (lead) or.push({ lead_id: lead });
    if (client) or.push({ client_id: client });
    const rows = await Activity.find({ $or: or })
      .sort({ created_at: -1 })
      .limit(200)
      .populate({ path: "user", select: "full_name" });
    res.json(rows.map(json));
  }),
);

router.post(
  "/activities",
  wrap(async (req, res) => {
    const lead = oid(req.body.lead_id),
      client = oid(req.body.client_id);
    if (!lead && !client) throw bad("lead_id or client_id is required");
    await assertParent(req.user, lead, client);
    const type = ENUMS.activityType.includes(req.body.type)
      ? req.body.type
      : "note";
    const title = String(req.body.title || "").trim();
    if (!title) throw bad("Title is required");
    const a = await logActivity({
      lead_id: lead,
      client_id: client,
      type,
      title,
      body: req.body.body || null,
      user_id: req.user._id,
    });
    res.status(201).json(json(a));
  }),
);

router.delete(
  "/activities/:id",
  wrap(async (req, res) => {
    const a = await Activity.findById(idParam(req.params.id));
    if (!a) throw notFound();
    await assertParent(req.user, a.lead_id, a.client_id);
    if (!isAdmin(req.user) && String(a.user_id) !== String(req.user._id))
      throw forbidden();
    await a.deleteOne();
    emitChange("activities");
    res.json({ ok: true });
  }),
);

// ---------------- Documents ----------------
const safeName = (n) =>
  String(n || "file")
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(0, 150);

// Files are kept in memory only while uploading, then saved inside MongoDB (see utils/files.js).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 10 },
});
const MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  mp4: "video/mp4",
  mov: "video/quicktime",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const mimeFor = (name, given) =>
  given && given !== "application/octet-stream"
    ? given
    : MIME[String(name).split(".").pop().toLowerCase()] ||
      given ||
      "application/octet-stream";

router.get(
  "/documents",
  wrap(async (req, res) => {
    const lead = oid(req.query.lead_id),
      client = oid(req.query.client_id);
    if (!lead && !client) throw bad("lead_id or client_id is required");
    await assertParent(req.user, lead, client);
    const filter = {};
    if (lead) filter.lead_id = lead;
    if (client) filter.client_id = client;
    const rows = await Document.find(filter)
      .sort({ created_at: -1 })
      .populate({ path: "uploader", select: "full_name" });
    res.json(rows.map(json));
  }),
);

// POST /api/documents?kind=lead|client&record_id=<id>   multipart field "file"
router.post(
  "/documents",
  wrap(async (req, _res, next) => {
    const kind = req.query.kind;
    const rid = oid(req.query.record_id);
    if (!["lead", "client"].includes(kind) || !rid)
      throw bad("kind and record_id are required");
    await assertParent(
      req.user,
      kind === "lead" ? rid : null,
      kind === "client" ? rid : null,
    );
    req.docKind = kind;
    req.docRecord = rid;
    next();
  }),
  (req, res, next) => upload.single("file")(req, res, next),
  wrap(async (req, res) => {
    const f = req.file;
    if (!f) throw bad("No file received");
    // The app may send a short, friendly name (?name=Photo 24 Oct.jpg); otherwise keep the file's own name.
    // multer gives latin1-decoded names; restore UTF-8
    const wanted =
      typeof req.query.name === "string"
        ? req.query.name.trim().slice(0, 120)
        : "";
    const name =
      wanted || Buffer.from(f.originalname, "latin1").toString("utf8");
    const mime = mimeFor(name, f.mimetype);
    const lead_id = req.docKind === "lead" ? req.docRecord : null;
    const client_id = req.docKind === "client" ? req.docRecord : null;
    const storage_path = await saveFile(f.buffer, {
      filename: safeName(name),
      contentType: mime,
      metadata: { lead_id, client_id, uploaded_by: req.user._id },
    });
    let doc;
    try {
      doc = await Document.create({
        lead_id,
        client_id,
        name,
        storage_path,
        mime_type: mime,
        size_bytes: f.size,
        department_id: await parentDepartment(lead_id, client_id),
        uploaded_by: req.user._id,
      });
    } catch (e) {
      await deleteFiles([{ storage_path }]);
      throw e;
    }
    await logActivity({
      lead_id,
      client_id,
      type: "document",
      title: `Uploaded ${name}`,
      user_id: req.user._id,
    });
    emitChange("documents");
    res.status(201).json(json(doc));
  }),
);

// GET /api/documents/:id/url -> { url } signed link valid for 10 minutes (opens in a new tab / browser)
router.get(
  "/documents/:id/url",
  wrap(async (req, res) => {
    const d = await Document.findById(idParam(req.params.id));
    if (!d) throw notFound();
    await assertParent(req.user, d.lead_id, d.client_id);
    const token = jwt.sign(
      { doc: String(d._id), purpose: "file" },
      config.jwtSecret,
      { expiresIn: "10m" },
    );
    const base = config.publicApiUrl || `${req.protocol}://${req.get("host")}`;
    res.json({ url: `${base}/api/files/${d._id}?token=${token}` });
  }),
);

router.delete(
  "/documents/:id",
  wrap(async (req, res) => {
    const d = await Document.findById(idParam(req.params.id));
    if (!d) throw notFound();
    await assertParent(req.user, d.lead_id, d.client_id);
    if (!isAdmin(req.user) && String(d.uploaded_by) !== String(req.user._id))
      throw forbidden("Only admins or the uploader can delete this document.");
    await removeFiles([d]);
    await d.deleteOne();
    emitChange("documents");
    res.json({ ok: true });
  }),
);

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const missingPage = (
  name,
) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>File not available</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F1F4F8;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0F2F58}
.c{background:#fff;border:1px solid #E4E9F0;border-radius:18px;padding:32px;max-width:440px;margin:16px;text-align:center;box-shadow:0 10px 30px -12px rgba(15,47,88,.22)}
h1{font-size:20px;margin:12px 0 6px}p{color:#64748B;font-size:14px;line-height:1.5;margin:0}b{color:#0F2F58;word-break:break-all}</style></head>
<body><div class="c"><div style="font-size:40px">&#128196;</div><h1>This file is no longer available</h1><p><b>${esc(name)}</b> was saved on an older server copy and has been removed. Please upload it again from the CRM.</p></div></body></html>`;

/** Public file route used by signed URLs (mounted without requireAuth). */
const fileRouter = require("express").Router();
fileRouter.get(
  "/:id",
  wrap(async (req, res) => {
    let payload;
    try {
      payload = jwt.verify(String(req.query.token || ""), config.jwtSecret);
    } catch {
      throw forbidden(
        "This link has expired. Open the document again from the CRM.",
      );
    }
    if (payload.purpose !== "file" || payload.doc !== req.params.id)
      throw forbidden();
    const d = await Document.findById(idParam(req.params.id));
    if (!d) throw notFound();
    const file = await openFile(d.storage_path);
    if (!file) {
      // Old uploads were kept on the server's disk; on hosts like Render that folder is wiped on restart.
      res.status(404);
      if ((req.headers.accept || "").includes("text/html"))
        return res.type("html").send(missingPage(d.name));
      return res.json({
        error:
          "This file is no longer available on the server. Please upload it again.",
        code: "file_missing",
      });
    }
    const download = req.query.download === "1";
    res.setHeader("Content-Type", mimeFor(d.name, d.mime_type));
    if (file.length) res.setHeader("Content-Length", String(file.length));
    res.setHeader(
      "Content-Disposition",
      `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(d.name)}`,
    );
    res.setHeader("Cache-Control", "private, max-age=600");
    // let the website (on another domain) show images / PDFs in its preview
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    file.stream.on("error", () => res.destroy());
    file.stream.pipe(res);
  }),
);

// ---------------- Payments ----------------
const PAY_FIELDS = [
  "amount",
  "currency",
  "status",
  "description",
  "due_at",
  "paid_at",
];

router.get(
  "/payments",
  wrap(async (req, res) => {
    const client = oid(req.query.client_id);
    if (!client) throw bad("client_id is required");
    await assertParent(req.user, null, client);
    res.json(
      (await Payment.find({ client_id: client }).sort({ created_at: -1 })).map(
        json,
      ),
    );
  }),
);

router.post(
  "/payments",
  wrap(async (req, res) => {
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
    const p = await Payment.create({
      ...data,
      client_id: client,
      department_id: c?.department_id ?? null,
      created_by: req.user._id,
    });
    await logActivity({
      client_id: client,
      type: "payment",
      title: `Payment recorded: ${p.currency} ${p.amount} (${p.status})`,
      user_id: req.user._id,
    });
    emitChange("payments");
    res.status(201).json(json(p));
  }),
);

router.patch(
  "/payments/:id",
  wrap(async (req, res) => {
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
  }),
);

router.delete(
  "/payments/:id",
  wrap(async (req, res) => {
    if (!isAdmin(req.user)) throw forbidden();
    const p = await Payment.findById(idParam(req.params.id));
    if (!p) throw notFound();
    await assertParent(req.user, null, p.client_id);
    await p.deleteOne();
    emitChange("payments");
    res.json({ ok: true });
  }),
);

module.exports = router;
module.exports.fileRouter = fileRouter;
