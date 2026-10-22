const jwt = require("jsonwebtoken");
const config = require("../config");
const { User } = require("../models");
const { HttpError } = require("../utils/http");

function signToken(user) {
  return jwt.sign({ sub: String(user._id), v: user.token_version || 0 }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

/** Requires `Authorization: Bearer <token>`; attaches the active user to req.user. */
async function requireAuth(req, _res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) throw new HttpError(401, "Please sign in.", "unauthorized");
    let payload;
    try { payload = jwt.verify(token, config.jwtSecret); } catch { throw new HttpError(401, "Your session has expired. Please sign in again.", "unauthorized"); }
    const user = await User.findById(payload.sub);
    if (!user || (user.token_version || 0) !== (payload.v || 0)) throw new HttpError(401, "Your session has expired. Please sign in again.", "unauthorized");
    if (!user.is_active) throw new HttpError(403, "Your account has been deactivated. Contact your administrator.", "inactive");
    req.user = user;
    next();
  } catch (e) { next(e); }
}

module.exports = { signToken, requireAuth };
