const bcrypt = require("bcryptjs");
const config = require("../config");
const { User } = require("../models");

/**
 * Make sure the master owner account exists and can sign in.
 *
 * Reads OWNER_EMAIL and OWNER_PASSWORD from the environment. On every startup it
 * creates that user as a super_admin if missing, or updates the password/role/active
 * flag if it already exists. The same email and password then work on the web CRM and
 * the Android app, because both sign in through POST /api/auth/login.
 *
 * Does nothing if the two values are not set, so local dev without them still runs.
 */
async function ensureOwner() {
  const { email, password, name } = config.owner;
  if (!email || !password) return;
  if (password.length < 8) {
    console.warn(
      "WARNING: OWNER_PASSWORD is shorter than 8 characters — skipping owner setup.",
    );
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  const existing = await User.findOne({ email });
  if (existing) {
    const samePassword = await bcrypt.compare(
      password,
      existing.password_hash || "",
    );
    const changed =
      !samePassword ||
      existing.role !== "super_admin" ||
      existing.is_active === false;
    if (changed) {
      if (!samePassword) existing.password_hash = hash;
      existing.role = "super_admin";
      existing.is_active = true;
      if (!samePassword)
        existing.token_version = (existing.token_version || 0) + 1;
      await existing.save();
      console.log(`Owner account ready (updated): ${email}`);
    } else {
      console.log(`Owner account ready: ${email}`);
    }
  } else {
    await User.create({
      email,
      password_hash: hash,
      full_name: name || email.split("@")[0],
      role: "super_admin",
    });
    console.log(`Owner account ready (created): ${email}`);
  }
}

module.exports = { ensureOwner };
