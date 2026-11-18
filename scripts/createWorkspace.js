/**
 * Create a NEW company (workspace) with its first super admin.
 *   npm run create-company -- "Company Name" admin@company.com "StrongPass123" "Admin Name"
 * The new company starts empty and is completely separate from every other company.
 */
const mongoose = require("mongoose");
const config = require("../config");
const { createWorkspace } = require("../utils/bootstrap");

(async () => {
  const [companyName, email, password, fullName] = process.argv.slice(2);
  if (!companyName || !email || !password) {
    console.log(
      'Usage: npm run create-company -- "Company Name" <admin-email> <password> ["Admin Name"]',
    );
    process.exit(1);
  }
  await mongoose.connect(config.mongoUri);
  try {
    const { workspace, user } = await createWorkspace({
      companyName,
      email,
      password,
      fullName,
    });
    console.log(
      `Created company "${workspace.name}" with super admin ${user.email}.`,
    );
    console.log(
      `They can now sign in to the web CRM and the Android app with that email and password.`,
    );
  } catch (e) {
    console.error("Could not create company:", e.message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
