const jwt = require("jsonwebtoken");
const config = require("../config");
const { User, Workspace } = require("../models");
const { HttpError } = require("../utils/http");

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), v: user.token_version || 0 },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

/** Requires `Authorization: Bearer <token>`; attaches the active user to req.user. */
async function requireAuth(req, _res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) throw new HttpError(401, "Please sign in.", "unauthorized");
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw new HttpError(
        401,
        "Your session has expired. Please sign in again.",
        "unauthorized",
      );
    }
    const user = await User.findById(payload.sub);
    if (!user || (user.token_version || 0) !== (payload.v || 0))
      throw new HttpError(
        401,
        "Your session has expired. Please sign in again.",
        "unauthorized",
      );
    if (!user.is_active)
      throw new HttpError(
        403,
        "Your account has been deactivated. Contact your administrator.",
        "inactive",
      );
    if (user.is_owner !== true && user.workspace_id) {
      const ws = await Workspace.findById(user.workspace_id)
        .select("is_active")
        .lean();
      if (ws && ws.is_active === false)
        throw new HttpError(
          403,
          "This company's access has been suspended. Please contact support.",
          "workspace_suspended",
        );
    }
    // Hierarchy: an admin sees themselves + the agents they created + agents the
    // SUPER ADMIN created (a shared pool). They never see agents created by
    // ANOTHER admin, nor other admins / super admins. Precompute this subtree once
    // so the per-request access filters stay fast and synchronous. Super admins
    // see the whole company; employees only their own records.
    if (user.role === "admin") {
      const supers = await User.find({
        workspace_id: user.workspace_id,
        role: "super_admin",
      })
        .select("_id")
        .lean();
      const superIds = supers.map((s) => s._id);
      const agents = await User.find({
        workspace_id: user.workspace_id,
        role: "employee",
        $or: [{ manager_id: user._id }, { manager_id: { $in: superIds } }],
      })
        .select("_id")
        .lean();
      user.subordinate_ids = [user._id, ...agents.map((a) => a._id)];
    }
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { signToken, requireAuth };
