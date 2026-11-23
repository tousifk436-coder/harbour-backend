/**
 * Multi-company (multi-tenant) bootstrap helpers.
 *  - ensureWorkspacesMigrated(): one-time, automatic upgrade of an older single-company
 *    database. If data exists but no workspace does, it creates one "Main Company" and
 *    moves every existing record into it, so nothing is lost and the owner keeps seeing it.
 *  - createWorkspace(): make a brand new company with its first super admin.
 */
const bcrypt = require("bcryptjs");
const models = require("../models");
const { Workspace, User, Department } = models;
const { ensureDefaultChannels } = require("./channels");
const { seedStagesForWorkspace } = require("./stages");

// every collection that holds company data and must carry workspace_id
const TENANT_MODELS = [
  "Department",
  "User",
  "Lead",
  "Client",
  "FollowUp",
  "Task",
  "Document",
  "Payment",
  "Activity",
  "Todo",
  "Note",
  "ChatChannel",
  "ChatMember",
  "ChatMessage",
  "Integration",
  "IntegrationEvent",
];

async function ensureWorkspacesMigrated() {
  const workspaceCount = await Workspace.estimatedDocumentCount();
  if (workspaceCount > 0) return null; // already on the new model

  // Is there any legacy data to migrate?
  const hasUsers = await User.estimatedDocumentCount();
  if (!hasUsers) return null; // fresh install: nothing to migrate

  const name = process.env.OWNER_WORKSPACE_NAME || "Main Company";
  const ws = await Workspace.create({ name });
  let stamped = 0;
  for (const key of TENANT_MODELS) {
    const Model = models[key];
    const r = await Model.updateMany(
      { workspace_id: { $exists: false } },
      { $set: { workspace_id: ws._id } },
    );
    stamped += r.modifiedCount || 0;
  }
  console.log(
    `Multi-company upgrade: moved ${stamped} existing records into "${name}".`,
  );
  await ensureDefaultChannels(ws._id);
  return ws;
}

/** Create a new company and its first super admin. Returns { workspace, user }. */
async function createWorkspace({ companyName, email, password, fullName }) {
  const name = String(companyName || "").trim();
  const mail = String(email || "")
    .trim()
    .toLowerCase();
  if (!name) throw new Error("Company name is required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail))
    throw new Error("A valid admin email is required");
  if (!password || String(password).length < 8)
    throw new Error("Admin password must be at least 8 characters");
  if (await User.exists({ email: mail }))
    throw new Error(`A user with email ${mail} already exists`);

  const workspace = await Workspace.create({ name });
  const user = await User.create({
    workspace_id: workspace._id,
    email: mail,
    password_hash: await bcrypt.hash(String(password), 10),
    full_name: String(fullName || "").trim() || mail.split("@")[0],
    role: "super_admin",
  });
  await ensureDefaultChannels(workspace._id);
  await seedStagesForWorkspace(workspace._id);
  return { workspace, user };
}

/**
 * Older databases have a GLOBAL unique index on department name (name_1), which would
 * stop two companies from each having, say, a "Sales" department. Drop it once; the new
 * per-company unique index { workspace_id, name } is built by Mongoose automatically.
 */
async function fixLegacyIndexes() {
  try {
    const idx = await Department.collection.indexes();
    if (idx.some((i) => i.name === "name_1")) {
      await Department.collection.dropIndex("name_1");
      console.log("Dropped obsolete global department-name index (name_1).");
    }
  } catch (e) {
    if (e && e.codeName !== "NamespaceNotFound")
      console.warn("fixLegacyIndexes:", e.message);
  }
}

module.exports = {
  ensureWorkspacesMigrated,
  createWorkspace,
  fixLegacyIndexes,
  TENANT_MODELS,
};
