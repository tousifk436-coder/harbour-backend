/**
 * Where uploaded documents are stored.
 *
 *  1. Cloudinary (when CLOUDINARY_* is set in .env)  -> storage_path "cloudinary:<type>:<format>:<public_id>"
 *     Files are uploaded as PRIVATE: they have no public link. The CRM fetches them with a
 *     short-lived signed request and streams them through /api/files/:id (same as before).
 *  2. MongoDB GridFS (no Cloudinary keys)             -> storage_path "gridfs:<id>"
 *  3. Old uploads saved on the server disk            -> relative path (served if the file still exists)
 *
 * Uses Cloudinary's REST API directly with Node's built-in fetch, so no extra npm package is needed.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const mongoose = require("mongoose");
const config = require("../config");
const { HttpError } = require("./http");

const CLD = "cloudinary:";
const GRID = "gridfs:";
const cld = config.cloudinary;

// ---------------------------------------------------------------- Cloudinary
/** Cloudinary request signature: sorted "key=value&..." + api secret, SHA-1. */
function sign(params) {
  const str = Object.keys(params)
    .filter(
      (k) => params[k] !== undefined && params[k] !== null && params[k] !== "",
    )
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto
    .createHash("sha1")
    .update(str + cld.secret)
    .digest("hex");
}
const resourceTypeFor = (mime) =>
  mime?.startsWith("image/")
    ? "image"
    : mime?.startsWith("video/")
      ? "video"
      : "raw";
const now = () => Math.floor(Date.now() / 1000);

async function cloudinaryUpload(buffer, { filename, contentType }) {
  const rt = resourceTypeFor(contentType);
  const params = { folder: cld.folder, timestamp: now(), type: "private" };
  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer], { type: contentType || "application/octet-stream" }),
    filename || "file",
  );
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append("api_key", cld.key);
  form.append("signature", sign(params));
  let res, body;
  try {
    res = await fetch(`${cld.apiBase}/${cld.cloud}/${rt}/upload`, {
      method: "POST",
      body: form,
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    throw new HttpError(
      502,
      `Could not reach Cloudinary: ${e.message}`,
      "storage_error",
    );
  }
  if (!res.ok || !body?.public_id) {
    throw new HttpError(
      502,
      `Cloudinary did not accept the file: ${body?.error?.message || res.status}`,
      "storage_error",
    );
  }
  return `${CLD}${body.resource_type || rt}:${body.format || ""}:${body.public_id}`;
}

function parseCloudinary(storagePath) {
  const rest = storagePath.slice(CLD.length);
  const [rt, format, ...idParts] = rest.split(":");
  return { rt, format, publicId: idParts.join(":") };
}

/** Signed, short-lived download link for a private Cloudinary file (Cloudinary "private download URL"). */
function cloudinaryDownloadUrl(storagePath) {
  const { rt, format, publicId } = parseCloudinary(storagePath);
  const params = {
    public_id: publicId,
    format: format || undefined,
    type: "private",
    timestamp: now(),
    expires_at: now() + 600,
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined) qs.set(k, String(v));
  qs.set("api_key", cld.key);
  qs.set("signature", sign(params));
  return `${cld.apiBase}/${cld.cloud}/${rt}/download?${qs}`;
}

async function cloudinaryDestroy(storagePath) {
  const { rt, publicId } = parseCloudinary(storagePath);
  const params = { public_id: publicId, timestamp: now(), type: "private" };
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.set(k, String(v));
  form.set("api_key", cld.key);
  form.set("signature", sign(params));
  await fetch(`${cld.apiBase}/${cld.cloud}/${rt}/destroy`, {
    method: "POST",
    body: form,
  });
}

// ---------------------------------------------------------------- MongoDB GridFS
let bucket = null;
let bucketDb = null;
function getBucket() {
  const db = mongoose.connection.db;
  if (!bucket || bucketDb !== db) {
    bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: "documents" });
    bucketDb = db;
  }
  return bucket;
}
const gridId = (storagePath) => {
  try {
    return new mongoose.Types.ObjectId(storagePath.slice(GRID.length));
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- public API
/** Where new uploads go right now (shown in the server start-up log). */
const storageName = () =>
  cld.enabled ? `Cloudinary (${cld.cloud}, private)` : "MongoDB (GridFS)";

/** Save a file from memory. Returns the storage_path to keep on the Document. */
async function saveFile(buffer, { filename, contentType, metadata }) {
  if (cld.enabled) return cloudinaryUpload(buffer, { filename, contentType });
  return new Promise((resolve, reject) => {
    const up = getBucket().openUploadStream(filename || "file", {
      contentType: contentType || undefined,
      metadata,
    });
    up.once("error", reject);
    up.once("finish", () => resolve(GRID + String(up.id)));
    up.end(buffer);
  });
}

/** Open a stored file for reading. Returns { stream, length } or null when it no longer exists. */
async function openFile(storagePath) {
  if (typeof storagePath !== "string" || !storagePath) return null;

  if (storagePath.startsWith(CLD)) {
    if (!cld.enabled) return null; // keys removed from .env
    let res;
    try {
      res = await fetch(cloudinaryDownloadUrl(storagePath));
    } catch {
      return null;
    }
    if (!res.ok || !res.body) return null;
    const len = Number(res.headers.get("content-length")) || null;
    return { stream: Readable.fromWeb(res.body), length: len };
  }

  if (storagePath.startsWith(GRID)) {
    const id = gridId(storagePath);
    if (!id) return null;
    const file = await getBucket().find({ _id: id }).limit(1).next();
    if (!file) return null;
    return { stream: getBucket().openDownloadStream(id), length: file.length };
  }

  // legacy: file saved on disk by an older version
  const full = path.join(config.uploadDir, storagePath);
  if (!full.startsWith(config.uploadDir) || !fs.existsSync(full)) return null;
  return { stream: fs.createReadStream(full), length: fs.statSync(full).size };
}

/** Delete stored files for these documents (missing files are ignored). */
async function deleteFiles(docs) {
  for (const d of docs) {
    const p = d.storage_path;
    try {
      if (typeof p !== "string" || !p) continue;
      if (p.startsWith(CLD)) {
        if (cld.enabled) await cloudinaryDestroy(p);
      } else if (p.startsWith(GRID)) {
        const id = gridId(p);
        if (id) await getBucket().delete(id);
      } else {
        await fs.promises.unlink(path.join(config.uploadDir, p));
      }
    } catch {
      /* already gone */
    }
  }
}

module.exports = { saveFile, openFile, deleteFiles, storageName };
