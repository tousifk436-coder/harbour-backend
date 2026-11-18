const bcrypt = require("bcryptjs");
const config = require("../config");
const { User, Workspace } = require("../models");
const { ensureDefaultChannels } = require("./channels");

/**
 * Make sure the master owner account exists.
 *
 * OWNER_EMAIL / OWNER_PASSWORD in .env are used ONLY to create the owner the first time.
 * After that the owner is a normal super_admin of its own company ("Main Company") and you
 * change its email/password from the admin panel like any other account — the server never
 * overwrites them again (it is marked is_owner). To reset a forgotten owner password, use
 *   npm run create-admin -- <owner-email> <new-password>
 */
async function ensureOwner() {
  const { email, password, name } = config.owner;
  if (!email || !password) return;

  // The owner lives in the first company (created by the migration, or made here on a fresh install).
  let ws = await Workspace.findOne().sort({ created_at: 1 });
  if (!ws)
    ws = await Workspace.create({
      name: process.env.OWNER_WORKSPACE_NAME || "Main Company",
    });

  // If an owner already exists, leave its email and password alone (managed from the panel).
  let owner = await User.findOne({ is_owner: true });
  if (owner) {
    let changed = false;
    if (!owner.workspace_id) {
      owner.workspace_id = ws._id;
      changed = true;
    }
    if (owner.role !== "super_admin") {
      owner.role = "super_admin";
      changed = true;
    }
    if (!owner.is_active) {
      owner.is_active = true;
      changed = true;
    }
    if (changed) await owner.save();
    await ensureDefaultChannels(owner.workspace_id);
    console.log(`Owner account ready: ${owner.email}`);
    return;
  }

  // No owner yet. Adopt an existing user with OWNER_EMAIL, or create a new one.
  if (password.length < 8) {
    console.warn(
      "WARNING: OWNER_PASSWORD is shorter than 8 characters — skipping owner creation.",
    );
    return;
  }
  const existing = await User.findOne({ email });
  if (existing) {
    existing.is_owner = true;
    existing.role = "super_admin";
    existing.is_active = true;
    if (!existing.workspace_id) existing.workspace_id = ws._id;
    await existing.save(); // keep its current password (do not overwrite)
    console.log(`Owner account ready (marked existing): ${existing.email}`);
    await ensureDefaultChannels(existing.workspace_id);
  } else {
    const u = await User.create({
      workspace_id: ws._id,
      email,
      password_hash: await bcrypt.hash(password, 10),
      full_name: name || email.split("@")[0],
      role: "super_admin",
      is_owner: true,
    });
    console.log(`Owner account ready (created): ${u.email}`);
    await ensureDefaultChannels(u.workspace_id);
  }
}

module.exports = { ensureOwner };
