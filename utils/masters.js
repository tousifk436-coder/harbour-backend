/**
 * Masters are admin-managed lookup lists (lead sources, designations, follow-up
 * types…). One table, grouped by `type`. These helpers seed sensible defaults
 * for any workspace that has none, and expose slug/validation helpers.
 */
const { Workspace, Master } = require("../models");

const DEFAULTS = {
  lead_source: [
    { key: "website", label: "Website" },
    { key: "referral", label: "Referral" },
    { key: "social_media", label: "Social Media" },
    { key: "facebook", label: "Facebook" },
    { key: "phone", label: "Phone" },
    { key: "walk_in", label: "Walk-in" },
    { key: "advertisement", label: "Advertisement" },
    { key: "other", label: "Other" },
  ],
  followup_type: [
    { key: "call", label: "Call" },
    { key: "meeting", label: "Meeting" },
    { key: "reminder", label: "Reminder" },
    { key: "email", label: "Email" },
    { key: "whatsapp", label: "WhatsApp" },
  ],
  designation: [
    { key: "sales_executive", label: "Sales Executive" },
    { key: "senior_sales_executive", label: "Senior Sales Executive" },
    { key: "team_lead", label: "Team Lead" },
    { key: "telecaller", label: "Telecaller" },
    { key: "manager", label: "Manager" },
  ],
};
const TYPES = Object.keys(DEFAULTS);

function slugify(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

async function uniqueKey(workspaceId, type, base) {
  let key = base || "item";
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Master.exists({ workspace_id: workspaceId, type, key })) {
    n += 1;
    key = `${base}_${n}`;
  }
  return key;
}

async function seedMastersForWorkspace(workspaceId) {
  let created = 0;
  for (const type of TYPES) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await Master.countDocuments({
      workspace_id: workspaceId,
      type,
    });
    if (existing > 0) continue;
    // eslint-disable-next-line no-await-in-loop
    await Master.insertMany(
      DEFAULTS[type].map((m, i) => ({
        workspace_id: workspaceId,
        type,
        key: m.key,
        label: m.label,
        position: i,
      })),
    );
    created += 1;
  }
  return created;
}

async function ensureMastersSeeded() {
  const workspaces = await Workspace.find().select("_id").lean();
  let seeded = 0;
  for (const ws of workspaces) {
    // eslint-disable-next-line no-await-in-loop
    seeded += await seedMastersForWorkspace(ws._id);
  }
  if (seeded > 0)
    console.log(`Masters: seeded ${seeded} default list(s) across companies.`);
}

/** Set of valid keys for one master type in a workspace (for validation). */
async function masterKeySet(workspaceId, type) {
  const rows = await Master.find({ workspace_id: workspaceId, type })
    .select("key")
    .lean();
  return new Set(rows.map((r) => r.key));
}

module.exports = {
  DEFAULTS,
  TYPES,
  slugify,
  uniqueKey,
  seedMastersForWorkspace,
  ensureMastersSeeded,
  masterKeySet,
};
