/**
 * Lead stages are admin-managed per company. These helpers seed a sensible
 * default pipeline for any workspace that has none yet (new companies and the
 * one-time upgrade of existing ones), and expose slug/role helpers used by the
 * stage routes and lead validation.
 */
const { Workspace, LeadStage } = require("../models");

// The default pipeline every new company starts with. `key` is the stable slug
// stored on lead.status; `is_open` means it counts as an active/open lead.
const DEFAULT_STAGES = [
  {
    key: "new_lead",
    label: "New Lead",
    color: "#1E8F99",
    is_open: true,
    role: "new",
  },
  { key: "prospect", label: "Prospect", color: "#1E8F99", is_open: true },
  { key: "follow_up", label: "Follow Up", color: "#6B4A9E", is_open: true },
  { key: "qualified", label: "Qualified", color: "#B7791F", is_open: true },
  {
    key: "meeting_scheduled",
    label: "Meeting Scheduled",
    color: "#2563EB",
    is_open: true,
  },
  { key: "rspv", label: "RSVP", color: "#7C3AED", is_open: true },
  {
    key: "meeting_done",
    label: "Meeting Done",
    color: "#0D9488",
    is_open: true,
  },
  {
    key: "sale_done",
    label: "Sale Done",
    color: "#2F7D4A",
    is_open: false,
    role: "won",
  },
  { key: "unreachable", label: "Unreachable", color: "#64748B", is_open: true },
  { key: "dnp", label: "DNP", color: "#D97706", is_open: true },
  {
    key: "not_interested",
    label: "Not Interested",
    color: "#DC2626",
    is_open: false,
  },
  { key: "hanged_up", label: "Hanged Up", color: "#E11D48", is_open: false },
  {
    key: "junk",
    label: "Junk",
    color: "#94A3B8",
    is_open: false,
    role: "junk",
  },
];

/** Turn a label into a stable slug key, e.g. "Not Interested" -> "not_interested". */
function slugify(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** Make a slug unique within a workspace by appending _2, _3, ... if needed. */
async function uniqueKey(workspaceId, base) {
  let key = base || "stage";
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await LeadStage.exists({ workspace_id: workspaceId, key })) {
    n += 1;
    key = `${base}_${n}`;
  }
  return key;
}

/** Create the default stages for one workspace if it has none. Returns created count. */
async function seedStagesForWorkspace(workspaceId) {
  const existing = await LeadStage.countDocuments({
    workspace_id: workspaceId,
  });
  if (existing > 0) return 0;
  await LeadStage.insertMany(
    DEFAULT_STAGES.map((s, i) => ({
      workspace_id: workspaceId,
      key: s.key,
      label: s.label,
      color: s.color,
      position: i,
      is_open: s.is_open,
      role: s.role || null,
    })),
  );
  return DEFAULT_STAGES.length;
}

/** One-time: every workspace with no stages gets the default pipeline. */
async function ensureStagesSeeded() {
  const workspaces = await Workspace.find().select("_id").lean();
  let seeded = 0;
  for (const ws of workspaces) {
    // eslint-disable-next-line no-await-in-loop
    seeded += (await seedStagesForWorkspace(ws._id)) > 0 ? 1 : 0;
  }
  if (seeded > 0)
    console.log(
      `Lead stages: seeded default pipeline for ${seeded} company(ies).`,
    );
}

module.exports = {
  DEFAULT_STAGES,
  slugify,
  uniqueKey,
  seedStagesForWorkspace,
  ensureStagesSeeded,
};
