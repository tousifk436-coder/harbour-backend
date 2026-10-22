const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// Business timezone: used for "today", dashboard day/month buckets and reminder texts.
if (process.env.TIMEZONE) process.env.TZ = process.env.TIMEZONE;

const config = {
  port: Number(process.env.PORT || 5000),
  env: process.env.NODE_ENV || "development",
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/harbour_crm",
  jwtSecret: process.env.JWT_SECRET || "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "30d",
  publicApiUrl: (process.env.PUBLIC_API_URL || "").replace(/\/$/, ""),
  webAppUrl: (process.env.WEB_APP_URL || "http://localhost:5173").replace(/\/$/, ""),
  uploadDir: path.resolve(path.join(__dirname, ".."), process.env.UPLOAD_DIR || "./uploads"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
  reminderWindow: Number(process.env.REMINDER_WINDOW_MINUTES || 15),
  timezone: process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  metaAppSecret: process.env.META_APP_SECRET || "",
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.MAIL_FROM || "Harbour CRM <no-reply@example.com>",
  },
};

if (!config.jwtSecret || config.jwtSecret.startsWith("CHANGE_ME")) {
  if (config.env === "production") {
    console.error("FATAL: set JWT_SECRET in .env to a long random string.");
    process.exit(1);
  }
  config.jwtSecret = "dev-only-insecure-secret";
  console.warn("WARNING: JWT_SECRET not set — using an insecure development secret.");
}

module.exports = config;
