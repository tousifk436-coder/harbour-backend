const router = require("express").Router();
const crypto = require("crypto");
const { Integration, IntegrationEvent } = require("../models");
const { wrap, bad, notFound, idParam, oid, pick, json } = require("../utils/http");
const { requireSuper } = require("../utils/access");
const { emitChange } = require("../utils/realtime");

const randomKey = (prefix) => prefix + crypto.randomBytes(16).toString("hex");

router.use((req, _res, next) => { try { requireSuper(req.user); next(); } catch (e) { next(e); } });

function cleanConfig(kind, cfg = {}) {
  const c = { ...cfg };
  if (kind === "facebook") {
    c.page_id = String(c.page_id || "").trim();
    c.page_access_token = String(c.page_access_token || "").trim();
    c.verify_token = c.verify_token || randomKey("vt_");
  } else {
    c.api_key = c.api_key || randomKey("wk_live_");
    c.allowed_origins = String(c.allowed_origins || "*").trim() || "*";
  }
  return c;
}

router.get("/", wrap(async (_req, res) => {
  res.json((await Integration.find().sort({ created_at: 1 })).map(json));
}));

router.post("/", wrap(async (req, res) => {
  const d = pick(req.body, ["kind", "name", "enabled", "config", "assign_to", "department_id"]);
  if (!["facebook", "website"].includes(d.kind)) throw bad("kind must be facebook or website");
  if (!String(d.name || "").trim()) throw bad("Name is required");
  d.config = cleanConfig(d.kind, d.config);
  if (d.kind === "facebook" && (!d.config.page_id || !d.config.page_access_token)) throw bad("Page ID and page access token are required");
  d.assign_to = oid(d.assign_to); d.department_id = oid(d.department_id);
  const i = await Integration.create({ ...d, created_by: req.user._id });
  emitChange("integrations", {}, [req.user._id]);
  res.status(201).json(json(i));
}));

router.patch("/:id", wrap(async (req, res) => {
  const i = await Integration.findById(idParam(req.params.id));
  if (!i) throw notFound();
  const d = pick(req.body, ["name", "enabled", "config", "assign_to", "department_id"]);
  if ("config" in d) { d.config = cleanConfig(i.kind, d.config); i.markModified("config"); }
  if ("assign_to" in d) d.assign_to = oid(d.assign_to);
  if ("department_id" in d) d.department_id = oid(d.department_id);
  i.set(d); await i.save();
  emitChange("integrations", {}, [req.user._id]);
  res.json(json(i));
}));

router.delete("/:id", wrap(async (req, res) => {
  const id = idParam(req.params.id);
  await IntegrationEvent.deleteMany({ integration_id: id });
  await Integration.deleteOne({ _id: id });
  emitChange("integrations", {}, [req.user._id]);
  res.json({ ok: true });
}));

router.get("/:id/events", wrap(async (req, res) => {
  const rows = await IntegrationEvent.find({ integration_id: idParam(req.params.id) }).sort({ created_at: -1 }).limit(50).select("-payload");
  res.json(rows.map(json));
}));

module.exports = router;
