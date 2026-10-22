/** Create (or de-duplicate) a lead coming from an integration (Facebook Lead Ads, website form). */
const { Integration, IntegrationEvent, Lead, User, digits } = require("../models");
const { logActivity } = require("./activity");
const { emitChange } = require("./realtime");
const { escapeRegex } = require("./http");

async function ingestIntegrationLead(integrationId, p, payload = null) {
  const integ = await Integration.findOne({ _id: integrationId, enabled: true });
  if (!integ) throw new Error("Integration disabled or not found");

  const email = p.email ? String(p.email).trim() : null;
  const phoneDigits = digits(p.phone);

  // de-duplicate on email or phone within the last 30 days
  const or = [];
  if (email) or.push({ email: new RegExp(`^${escapeRegex(email)}$`, "i") });
  if (phoneDigits) or.push({ phone_digits: phoneDigits });
  const existing = or.length ? await Lead.findOne({ $or: or }).sort({ created_at: -1 }) : null;
  if (existing && existing.created_at > new Date(Date.now() - 30 * 86400_000)) {
    await IntegrationEvent.create({ integration_id: integ._id, lead_id: existing._id, status: "duplicate", detail: "Matched existing lead", payload });
    await logActivity({ lead_id: existing._id, type: "system", title: `New enquiry via ${integ.name}`, body: p.notes || "", department_id: integ.department_id });
    return existing._id;
  }

  let dept = integ.department_id;
  if (!dept && integ.assign_to) dept = (await User.findById(integ.assign_to).select("department_id").lean())?.department_id || null;
  const lead = await Lead.create({
    name: (p.name && String(p.name).trim()) || "Unknown",
    phone: p.phone || null,
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
    company: p.company || null, address: p.address || null,
    source: integ.kind === "facebook" ? "facebook" : "website",
    notes: p.notes || null,
    assigned_to: integ.assign_to, department_id: dept, created_by: integ.created_by,
  });
  await logActivity({ lead_id: lead._id, type: "created", title: "Lead created", user_id: integ.created_by, department_id: lead.department_id });
  await Integration.updateOne({ _id: integ._id }, { $inc: { leads_received: 1 }, $set: { last_lead_at: new Date() } });
  await IntegrationEvent.create({ integration_id: integ._id, lead_id: lead._id, status: "created", detail: null, payload });
  emitChange("leads"); emitChange("integrations");
  return lead._id;
}

module.exports = { ingestIntegrationLead };
