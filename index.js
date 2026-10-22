/**
 * Harbour CRM backend — entry point.
 *   npm run dev   (auto-restart on changes)
 *   npm start
 */
const http = require("http");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const mongoose = require("mongoose");

const config = require("./config");
const { requireAuth } = require("./middleware/auth");
const { errorHandler } = require("./middleware/error");
const { initRealtime } = require("./utils/realtime");
const { ensureDefaultChannels } = require("./utils/channels");
const { startReminderJob } = require("./jobs/reminders");

// ---------------- CORS: public — any website or app may call this API ----------------
const corsOptions = {
  origin: true,                 // reflect whatever Origin calls us (works from every domain, localhost, file://, apps)
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key", "X-Requested-With", "Accept"],
  maxAge: 86400,
};

// ---------------- Express app ----------------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));   // answer every preflight request
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, crossOriginOpenerPolicy: false, contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan(config.env === "production" ? "combined" : "dev"));

app.get("/", (_req, res) => res.json({ name: "Harbour CRM API", status: "running", health: "/api/health" }));
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Public: Facebook + website-form webhooks (they parse their own bodies)
app.use("/api/webhooks", require("./routes/webhooks"));

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Public: signed document download links
app.use("/api/files", require("./routes/records").fileRouter);

// Login, password reset, push tokens
app.use("/api/auth", require("./routes/auth"));

// Everything below needs a signed-in, active user
app.use("/api", requireAuth);
app.use("/api", require("./routes/team"));            // departments, profiles, employee performance
app.use("/api/leads", require("./routes/leads"));
app.use("/api/clients", require("./routes/clients"));
app.use("/api/follow-ups", require("./routes/followups"));
app.use("/api/tasks", require("./routes/tasks"));
app.use("/api", require("./routes/records"));         // activities, documents, payments
app.use("/api", require("./routes/workspace"));       // todos, notes, calendar, dashboard, module counts
app.use("/api/chat", require("./routes/chat"));
app.use("/api/integrations", require("./routes/integrations"));

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found", code: "not_found" }));
app.use(errorHandler);

// ---------------- Start ----------------
async function start() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  await mongoose.connect(config.mongoUri);
  console.log(`MongoDB connected: ${config.mongoUri.replace(/\/\/[^@]*@/, "//***@")}`);
  await ensureDefaultChannels();

  const server = http.createServer(app);
  initRealtime(server, corsOptions);
  startReminderJob();

  server.listen(config.port, () => {
    console.log(`Harbour CRM API listening on port ${config.port} (${config.env}, TZ ${config.timezone})`);
    console.log(`Health check: http://localhost:${config.port}/api/health`);
  });

  const shutdown = async () => { server.close(); await mongoose.disconnect(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  start().catch((e) => { console.error("Failed to start:", e); process.exit(1); });
}

module.exports = app;
