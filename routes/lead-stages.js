const router = require("express").Router();
const { Lead, LeadStage } = require("../models");
const { wrap, bad, idParam, oid, json } = require("../utils/http");
const { requireAdmin } = require("../utils/access");
const { slugify, uniqueKey } = require("../utils/stages");
const { emitChange } = require("../utils/realtime");

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// GET /api/lead-stages  -> ordered list for this company (any signed-in user)
router.get(
  "/lead-stages",
  wrap(async (req, res) => {
    const rows = await LeadStage.find({ workspace_id: req.user.workspace_id })
      .sort({ position: 1, _id: 1 })
      .lean();
    res.json(rows.map((r) => ({ ...r, id: String(r._id), _id: undefined })));
  }),
);

// POST /api/lead-stages  { label, color?, is_open? }  (admin/owner)
router.post(
  "/lead-stages",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const ws = req.user.workspace_id;
    const label = String(req.body.label || "").trim();
    if (!label) throw bad("Stage name is required.");
    const color = HEX.test(req.body.color) ? req.body.color : "#64748B";
    const is_open = req.body.is_open === undefined ? true : !!req.body.is_open;
    const base = slugify(label);
    if (!base) throw bad("Stage name must contain letters or numbers.");
    const key = await uniqueKey(ws, base);
    const last = await LeadStage.find({ workspace_id: ws })
      .sort({ position: -1 })
      .limit(1)
      .lean();
    const position = (last[0]?.position ?? -1) + 1;
    const stage = await LeadStage.create({
      workspace_id: ws,
      key,
      label,
      color,
      is_open,
      position,
    });
    emitChange("lead_stages");
    res.status(201).json(json(stage));
  }),
);

// PATCH /api/lead-stages/:id  { label?, color?, is_open?, position? }  (admin/owner)
router.patch(
  "/lead-stages/:id",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const stage = await LeadStage.findOne({
      _id: idParam(req.params.id),
      workspace_id: req.user.workspace_id,
    });
    if (!stage) throw bad("Stage not found.");
    if ("label" in req.body) {
      const label = String(req.body.label || "").trim();
      if (!label) throw bad("Stage name is required.");
      stage.label = label; // key stays the same so existing leads and reports keep working
    }
    if ("color" in req.body && HEX.test(req.body.color)) stage.color = req.body.color;
    if ("is_open" in req.body) stage.is_open = !!req.body.is_open;
    if ("position" in req.body && Number.isFinite(Number(req.body.position)))
      stage.position = Number(req.body.position);
    await stage.save();
    emitChange("lead_stages");
    res.json(json(stage));
  }),
);

// POST /api/lead-stages/reorder  { order: [id, id, ...] }  (admin/owner)
router.post(
  "/lead-stages/reorder",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const ids = (Array.isArray(req.body.order) ? req.body.order : [])
      .map(oid)
      .filter(Boolean);
    if (!ids.length) throw bad("No order provided.");
    await Promise.all(
      ids.map((id, i) =>
        LeadStage.updateOne(
          { _id: id, workspace_id: req.user.workspace_id },
          { $set: { position: i } },
        ),
      ),
    );
    emitChange("lead_stages");
    res.json({ ok: true });
  }),
);

// DELETE /api/lead-stages/:id  (admin/owner)
// Blocked while leads still use the stage, so no lead is ever orphaned.
router.delete(
  "/lead-stages/:id",
  wrap(async (req, res) => {
    requireAdmin(req.user);
    const ws = req.user.workspace_id;
    const stage = await LeadStage.findOne({
      _id: idParam(req.params.id),
      workspace_id: ws,
    });
    if (!stage) throw bad("Stage not found.");
    const total = await LeadStage.countDocuments({ workspace_id: ws });
    if (total <= 1) throw bad("You must keep at least one stage.");
    const inUse = await Lead.countDocuments({ workspace_id: ws, status: stage.key });
    if (inUse > 0)
      throw bad(
        `This stage has ${inUse} lead(s). Move them to another stage before deleting it.`,
      );
    await stage.deleteOne();
    emitChange("lead_stages");
    res.json({ ok: true });
  }),
);

module.exports = router;
