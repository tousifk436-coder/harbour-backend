/**
 * Owner-only "platform" endpoints: create and manage the separate companies (workspaces).
 * Guarded so only the master owner (is_owner) can use them. Returns company metadata and
 * counts only — never the leads, customers or chats inside a company.
 */
const router = require("express").Router();
const { Workspace, User, Lead, Client } = require("../models");
const {
  wrap,
  bad,
  forbidden,
  notFound,
  idParam,
  json,
} = require("../utils/http");
const { createWorkspace } = require("../utils/bootstrap");

// Only the platform owner may manage companies.
router.use((req, _res, next) => {
  if (!req.user || req.user.is_owner !== true)
    return next(forbidden("Only the owner can manage companies."));
  next();
});

// GET /api/platform/companies -> all companies with high-level counts (no inside data)
router.get(
  "/companies",
  wrap(async (req, res) => {
    const workspaces = await Workspace.find().sort({ created_at: 1 }).lean();
    const ids = workspaces.map((w) => w._id);
    const groupCount = (Model) =>
      Model.aggregate([
        { $match: { workspace_id: { $in: ids } } },
        { $group: { _id: "$workspace_id", n: { $sum: 1 } } },
      ]);
    const [userRows, leadRows, clientRows, admins] = await Promise.all([
      groupCount(User),
      groupCount(Lead),
      groupCount(Client),
      User.find({ workspace_id: { $in: ids }, role: "super_admin" })
        .select("workspace_id email full_name is_active")
        .sort({ created_at: 1 })
        .lean(),
    ]);
    const cnt = (rows) =>
      Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
    const u = cnt(userRows),
      l = cnt(leadRows),
      c = cnt(clientRows);
    const adminsBy = {};
    for (const a of admins)
      (adminsBy[String(a.workspace_id)] ||= []).push({
        email: a.email,
        full_name: a.full_name,
        is_active: a.is_active !== false,
      });
    res.json(
      workspaces.map((w) => ({
        id: String(w._id),
        name: w.name,
        is_active: w.is_active !== false,
        created_at: w.created_at,
        users: u[String(w._id)] || 0,
        leads: l[String(w._id)] || 0,
        clients: c[String(w._id)] || 0,
        super_admins: adminsBy[String(w._id)] || [],
        is_mine: String(w._id) === String(req.user.workspace_id),
      })),
    );
  }),
);

// POST /api/platform/companies { company_name, email, password, full_name } -> create company + its first super admin
router.post(
  "/companies",
  wrap(async (req, res) => {
    const { company_name, email, password, full_name } = req.body || {};
    try {
      const { workspace, user } = await createWorkspace({
        companyName: company_name,
        email,
        password,
        fullName: full_name,
      });
      res.status(201).json({
        id: String(workspace._id),
        name: workspace.name,
        admin_email: user.email,
      });
    } catch (e) {
      throw bad(e.message || "Could not create company");
    }
  }),
);

// PATCH /api/platform/companies/:id { name?, is_active? } -> rename or suspend/re-enable a company
router.patch(
  "/companies/:id",
  wrap(async (req, res) => {
    const w = await Workspace.findById(idParam(req.params.id));
    if (!w) throw notFound();
    const mine = String(w._id) === String(req.user.workspace_id);
    if (mine && req.body.is_active === false)
      throw bad("You cannot suspend your own company.");
    if (typeof req.body.name === "string" && req.body.name.trim())
      w.name = req.body.name.trim();
    if (typeof req.body.is_active === "boolean")
      w.is_active = req.body.is_active;
    await w.save();
    res.json({
      id: String(w._id),
      name: w.name,
      is_active: w.is_active !== false,
    });
  }),
);

module.exports = router;
