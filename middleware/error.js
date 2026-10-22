const { HttpError } = require("../utils/http");

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err && err.name === "ValidationError") {
    const first = Object.values(err.errors)[0];
    const msg = first?.kind === "enum" ? `Invalid value for ${first.path}` : first?.message || "Invalid data";
    return res.status(400).json({ error: msg, code: "validation" });
  }
  if (err && err.name === "CastError") return res.status(400).json({ error: `Invalid value for ${err.path}`, code: "validation" });
  if (err && err.code === 11000) return res.status(409).json({ error: "A record with these details already exists.", code: "duplicate" });
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File is too large.", code: "too_large" });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON", code: "bad_json" });
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(500).json({ error: "Something went wrong on the server.", code: "server_error" });
}

module.exports = { errorHandler };
