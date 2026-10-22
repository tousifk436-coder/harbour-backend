const mongoose = require("mongoose");

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg) => new HttpError(400, msg, "bad_request");
const forbidden = (msg = "You do not have permission to do that.") => new HttpError(403, msg, "forbidden");
const notFound = (msg = "Not found or access denied") => new HttpError(404, msg, "not_found");

/** Wrap async route handlers so thrown errors reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Returns a valid ObjectId, or null for empty/invalid input. */
function oid(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) && /^[a-f0-9]{24}$/i.test(s) ? new mongoose.Types.ObjectId(s) : null;
}
/** Like oid() but throws 404 when the id is malformed (for :id params). */
function idParam(v) {
  const id = oid(v);
  if (!id) throw notFound();
  return id;
}

/** Copy only whitelisted keys that are present in `src`. */
function pick(src, keys) {
  const out = {};
  for (const k of keys) if (src && Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  return out;
}

/** Normalise "" -> null for optional text fields. */
function blankToNull(obj, keys) {
  for (const k of keys) if (k in obj && (obj[k] === "" || obj[k] === undefined)) obj[k] = null;
  return obj;
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const ymd = (d) => { const x = new Date(d); const p = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };
const json = (doc) => (doc && typeof doc.toJSON === "function" ? doc.toJSON() : doc);

module.exports = { HttpError, bad, forbidden, notFound, wrap, oid, idParam, pick, blankToNull, escapeRegex, sameId, startOfDay, endOfDay, ymd, json };
