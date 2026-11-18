/**
 * Create the first super admin (or reset a user's password).
 *   npm run create-admin -- owner@company.com "StrongPass123" "Owner Name"
 */
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const config = require("../config");
const { User, Workspace } = require("../models");
const { ensureDefaultChannels } = require("../utils/channels");

(async () => {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password) {
    console.log(
      'Usage: npm run create-admin -- <email> <password> ["Full Name"]',
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters");
    process.exit(1);
  }
  await mongoose.connect(config.mongoUri);
  const hash = await bcrypt.hash(password, 10);
  // Super admins belong to a company; use the first one, or create "Main Company".
  let ws = await Workspace.findOne().sort({ created_at: 1 });
  if (!ws)
    ws = await Workspace.create({
      name: process.env.OWNER_WORKSPACE_NAME || "Main Company",
    });
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    existing.password_hash = hash;
    existing.role = "super_admin";
    existing.is_active = true;
    if (!existing.workspace_id) existing.workspace_id = ws._id;
    existing.token_version = (existing.token_version || 0) + 1;
    if (name) existing.full_name = name;
    await existing.save();
    console.log(
      `Updated ${email}: now an active super admin with the new password.`,
    );
  } else {
    await User.create({
      workspace_id: ws._id,
      email,
      password_hash: hash,
      full_name: name || email.split("@")[0],
      role: "super_admin",
    });
    console.log(`Created super admin ${email}.`);
  }
  await ensureDefaultChannels(ws._id);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
