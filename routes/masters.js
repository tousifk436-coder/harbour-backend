const router = require("express").Router();
const { Master } = require("../models");
const { wrap, bad, idParam, oid, json } = require("../utils/http");
const { requireAdmin } = require("../utils/access");
const { TYPES, slugify, uniqueKey } = require("../utils/masters");

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const okType = (t) => TYPES.includes(t);

// GET /api/masters?type=lead_source  -> ordered list (any signed-in user)
router.get(
  "/masters",
  wrap(async (req, res) => {
    const type = String(req.query.type || "");
    if (!okType(type)) throw bad("Unknown master type.");
    const rows = await Master.find({
      workspace_id: req.user.workspace_id,
      type,
    })
      .sort({ position: 1, _id: 1 })
      .lean();
    res.json(rows.map((r) => ({ ...r, id: String(r._id), _id: undefined })));
  }),
);

// POST /api/masters  { type, label, color? }  (admin/owner)
router.post(
  "/masters",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const ws = req.user.workspace_id;
    const type = String(req.body.type || "");
    if (!okType(type)) throw bad("Unknown master type.");
    const label = String(req.body.label || "").trim();
    if (!label) throw bad("Name is required.");
    const base = slugify(label);
    if (!base) throw bad("Name must contain letters or numbers.");
    const color = HEX.test(req.body.color) ? req.body.color : null;
    const key = await uniqueKey(ws, type, base);
    const last = await Master.find({ workspace_id: ws, type })
      .sort({ position: -1 })
      .limit(1)
      .lean();
    const position = (last[0]?.position ?? -1) + 1;
    const row = await Master.create({
      workspace_id: ws,
      type,
      key,
      label,
      color,
      position,
    });
    res.status(201).json(json(row));
  }),
);

// PATCH /api/masters/:id  { label?, color?, position? }  (admin/owner)
router.patch(
  "/masters/:id",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const row = await Master.findOne({
      _id: idParam(req.params.id),
      workspace_id: req.user.workspace_id,
    });
    if (!row) throw bad("Item not found.");
    if ("label" in req.body) {
      const label = String(req.body.label || "").trim();
      if (!label) throw bad("Name is required.");
      row.label = label; // key stays the same so existing records keep working
    }
    if ("color" in req.body)
      row.color = HEX.test(req.body.color) ? req.body.color : null;
    if ("position" in req.body && Number.isFinite(Number(req.body.position)))
      row.position = Number(req.body.position);
    await row.save();
    res.json(json(row));
  }),
);

// POST /api/masters/reorder  { type, order: [id, ...] }  (admin/owner)
router.post(
  "/masters/reorder",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const type = String(req.body.type || "");
    if (!okType(type)) throw bad("Unknown master type.");
    const ids = (Array.isArray(req.body.order) ? req.body.order : [])
      .map(oid)
      .filter(Boolean);
    if (!ids.length) throw bad("No order provided.");
    await Promise.all(
      ids.map((id, i) =>
        Master.updateOne(
          { _id: id, workspace_id: req.user.workspace_id, type },
          { $set: { position: i } },
        ),
      ),
    );
    res.json({ ok: true });
  }),
);

// DELETE /api/masters/:id  (admin/owner)
router.delete(
  "/masters/:id",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const row = await Master.findOne({
      _id: idParam(req.params.id),
      workspace_id: req.user.workspace_id,
    });
    if (!row) throw bad("Item not found.");
    await row.deleteOne();
    res.json({ ok: true });
  }),
);

module.exports = router;
