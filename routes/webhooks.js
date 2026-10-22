/**
 * Public endpoints (no login):
 *   GET/POST /api/webhooks/meta          Facebook / Instagram Lead Ads webhook
 *   POST     /api/webhooks/website-lead  Website enquiry form (X-Api-Key header)
 */
const express = require("express");
const crypto = require("crypto");
const config = require("../config");
const { Integration, IntegrationEvent } = require("../models");
const { ingestIntegrationLead } = require("../utils/ingest");

const router = express.Router();
const GRAPH = "https://graph.facebook.com/v19.0";

// ---------------- Facebook Lead Ads ----------------
router.get("/meta", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = req.query["hub.challenge"] || "";
  const integ = token ? await Integration.findOne({ kind: "facebook", enabled: true, "config.verify_token": token }).lean() : null;
  if (mode === "subscribe" && integ) return res.status(200).send(String(challenge));
  res.status(403).send("Verification failed");
});

router.post("/meta", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  let body;
  try { body = JSON.parse(raw); } catch { return res.status(400).send("Bad JSON"); }
  if (body.object !== "page") return res.status(200).send("Ignored");

  if (config.metaAppSecret) {
    const sig = req.headers["x-hub-signature-256"] || "";
    const expected = "sha256=" + crypto.createHmac("sha256", config.metaAppSecret).update(raw).digest("hex");
    const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return res.status(401).send("Bad signature");
  }

  let created = 0;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "leadgen") continue;
      const { leadgen_id, page_id, form_id } = change.value || {};
      const integ = await Integration.findOne({ kind: "facebook", enabled: true, "config.page_id": String(page_id) }).lean();
      if (!integ) continue;
      try {
        const r = await fetch(`${GRAPH}/${leadgen_id}?fields=created_time,field_data,ad_name,campaign_name&access_token=${encodeURIComponent(integ.config.page_access_token)}`);
        const lead = await r.json();
        if (!r.ok) throw new Error(lead?.error?.message || "Graph API error");
        const f = {};
        for (const fd of lead.field_data || []) f[fd.name] = (fd.values || [])[0] || "";
        const name = f.full_name || [f.first_name, f.last_name].filter(Boolean).join(" ") || "Facebook lead";
        const skip = ["full_name", "first_name", "last_name", "email", "phone_number", "phone", "company_name"];
        const payload = {
          name, email: f.email || null, phone: f.phone_number || f.phone || null, company: f.company_name || null,
          address: [f.street_address, f.city, f.province, f.post_code].filter(Boolean).join(", ") || null,
          notes: ["Facebook Lead Ad", lead.campaign_name && `Campaign: ${lead.campaign_name}`, lead.ad_name && `Ad: ${lead.ad_name}`, form_id && `Form: ${form_id}`,
            ...Object.entries(f).filter(([k]) => !skip.includes(k)).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join("\n"),
        };
        await ingestIntegrationLead(integ._id, payload, { leadgen_id, form_id, field_data: lead.field_data });
        created++;
      } catch (e) {
        await IntegrationEvent.create({ integration_id: integ._id, status: "error", detail: String(e.message || e), payload: change.value });
      }
    }
  }
  res.status(200).json({ ok: true, created });
});

// ---------------- Website form ----------------
const hits = new Map();
function rateLimited(ip, max = 10, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

function websiteCors(req, res, next) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

router.options("/website-lead", websiteCors);
router.post("/website-lead", websiteCors, express.json({ limit: "100kb" }), async (req, res) => {
  try {
    const ip = req.ip || "unknown";
    if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests, try again in a minute." });
    const key = String(req.headers["x-api-key"] || "");
    if (!key) return res.status(401).json({ error: "Missing API key" });
    const integ = await Integration.findOne({ kind: "website", enabled: true, "config.api_key": key }).lean();
    if (!integ) return res.status(401).json({ error: "Invalid API key" });

    const origin = req.headers.origin || "*";
    const allowed = String(integ.config.allowed_origins || "*");
    if (allowed !== "*" && origin !== "*" && !allowed.split(",").map((s) => s.trim()).includes(origin)) return res.status(403).json({ error: "Origin not allowed" });

    const b = req.body || {};
    if (b.website_url || b._hp) return res.json({ ok: true });   // honeypot filled by a bot: pretend success
    const name = String(b.name || "").trim();
    const email = String(b.email || "").trim();
    const phone = String(b.phone || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!email && !phone) return res.status(400).json({ error: "Email or phone is required" });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Email looks invalid" });

    const id = await ingestIntegrationLead(integ._id, {
      name, email: email || null, phone: phone || null, company: b.company || null, address: b.address || null,
      notes: [b.message && `Message: ${b.message}`, b.page && `Page: ${b.page}`].filter(Boolean).join("\n") || null,
    }, { ...b, ip, origin });
    res.json({ ok: true, id: String(id) });
  } catch (e) {
    console.error("[website-lead]", e);
    res.status(500).json({ error: "Could not save your enquiry" });
  }
});

module.exports = router;
