/**
 * SAMPLE DATA FOR TESTING ONLY — do not run on your live database.
 *   npm run seed            (refuses if users already exist)
 *   npm run seed -- --force (WIPES the database first)
 * Creates 1 super admin, 1 admin, 2 employees (password for all: Password123!)
 * plus leads, clients, follow-ups, tasks, payments, notes, to-dos, chat and a website integration.
 */
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const config = require("../config");
const M = require("../models");
const { ensureDefaultChannels } = require("../utils/channels");

const H = 3600_000, D = 24 * H;
const at = (ms) => new Date(Date.now() + ms);
const ymd = (ms) => { const d = at(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

(async () => {
  await mongoose.connect(config.mongoUri);
  const force = process.argv.includes("--force");
  if ((await M.User.countDocuments()) > 0 && !force) {
    console.error("Users already exist. Run `npm run seed -- --force` to wipe the database and load sample data.");
    process.exit(1);
  }
  if (force) {
    await mongoose.connection.db.dropDatabase();
    for (const m of Object.values(M)) if (m && m.syncIndexes) await m.syncIndexes();
  }

  const sales = await M.Department.create({ name: "Sales" });
  const cs = await M.Department.create({ name: "Client Services" });
  const pw = await bcrypt.hash("Password123!", 10);
  const owner = await M.User.create({ email: "owner@example.com", password_hash: pw, full_name: "Olivia Owner", role: "super_admin" });
  const admin = await M.User.create({ email: "admin@example.com", password_hash: pw, full_name: "Adam Admin", role: "admin", department_id: sales._id });
  const emma = await M.User.create({ email: "employee@example.com", password_hash: pw, full_name: "Emma Employee", role: "employee", department_id: sales._id });
  const ethan = await M.User.create({ email: "ethan@example.com", password_hash: pw, full_name: "Ethan Employee", role: "employee", department_id: cs._id });

  const lead = async (d) => {
    const l = new M.Lead(d); l.created_at = d.created_at; await l.save({ timestamps: false });
    await M.Activity.create({ lead_id: l._id, type: "created", title: "Lead created", user_id: d.created_by, department_id: d.department_id });
    return l;
  };
  const stamp = (d) => ({ ...d, updated_at: d.created_at });
  const priya = await lead(stamp({ name: "Priya Sharma", phone: "+15145550101", email: "priya@example.com", company: "Sharma Consulting", address: "123 Rue Sainte-Catherine, Montréal", source: "website", status: "new", estimated_value: 2500, assigned_to: emma._id, department_id: sales._id, created_by: admin._id, created_at: at(-2 * D) }));
  const carlos = await lead(stamp({ name: "Carlos Mendes", phone: "+15145550102", email: "carlos@example.com", company: "Mendes Logistics", address: "45 Av. du Parc, Montréal", source: "referral", status: "contacted", estimated_value: 4000, assigned_to: emma._id, department_id: sales._id, created_by: admin._id, created_at: at(-9 * D) }));
  const aisha = await lead(stamp({ name: "Aisha Rahman", phone: "+15145550103", email: "aisha@example.com", address: "900 Boul. René-Lévesque, Montréal", source: "social_media", status: "qualified", estimated_value: 3200, assigned_to: admin._id, department_id: sales._id, created_by: admin._id, created_at: at(-15 * D) }));
  const jean = await lead(stamp({ name: "Jean Tremblay", phone: "+15145550104", email: "jean@example.com", company: "Tremblay & Fils", address: "10 Rue Saint-Paul, Québec", source: "phone", status: "proposal", estimated_value: 6000, assigned_to: ethan._id, department_id: cs._id, created_by: owner._id, created_at: at(-20 * D) }));
  await lead(stamp({ name: "Wei Zhang", phone: "+15145550105", email: "wei@example.com", company: "Zhang Tech", address: "200 Rue Peel, Montréal", source: "advertisement", status: "lost", estimated_value: 1500, assigned_to: emma._id, department_id: sales._id, created_by: admin._id, created_at: at(-40 * D) }));
  await lead(stamp({ name: "Fatima Al-Sayed", phone: "+15145550106", email: "fatima@example.com", address: "77 Rue Sherbrooke, Montréal", source: "walk_in", status: "new", estimated_value: 1800, assigned_to: ethan._id, department_id: cs._id, created_by: ethan._id, created_at: at(-1 * D) }));

  const noah = await M.Client.create({ name: "Noah Bergeron", phone: "+15145550201", email: "noah@example.com", company: "Bergeron Inc.", address: "15 Rue McGill, Montréal", service_status: "in_progress", service_name: "Premium Package", contract_value: 5000, assigned_to: emma._id, department_id: sales._id, created_by: admin._id });
  const sofia = await M.Client.create({ name: "Sofia Rossi", phone: "+15145550202", email: "sofia@example.com", address: "300 Rue Notre-Dame, Montréal", service_status: "completed", service_name: "Standard Package", contract_value: 2200, assigned_to: ethan._id, department_id: cs._id, created_by: owner._id });

  await M.Payment.create([
    { client_id: noah._id, amount: 2500, status: "paid", description: "Deposit", due_at: ymd(-25 * D), paid_at: at(-25 * D), department_id: sales._id, created_by: admin._id },
    { client_id: noah._id, amount: 2500, status: "pending", description: "Final balance", due_at: ymd(20 * D), department_id: sales._id, created_by: admin._id },
    { client_id: sofia._id, amount: 2200, status: "paid", description: "Full payment", due_at: ymd(-80 * D), paid_at: at(-80 * D), department_id: cs._id, created_by: owner._id },
  ]);

  await M.FollowUp.create([
    { lead_id: priya._id, type: "call", title: "Introductory call", due_at: at(2 * H), notes: "Ask about timeline", assigned_to: emma._id, department_id: sales._id, created_by: admin._id },
    { lead_id: carlos._id, type: "meeting", title: "Proposal walkthrough", due_at: at(1 * D), assigned_to: emma._id, department_id: sales._id, created_by: admin._id },
    { lead_id: aisha._id, type: "call", title: "Check in on documents", due_at: at(-2 * D), notes: "Overdue!", assigned_to: admin._id, department_id: sales._id, created_by: admin._id },
    { lead_id: jean._id, type: "email", title: "Send revised quote", due_at: at(3 * D), assigned_to: ethan._id, department_id: cs._id, created_by: owner._id },
    { client_id: noah._id, type: "reminder", title: "Collect final balance", due_at: at(20 * D), assigned_to: emma._id, department_id: sales._id, created_by: admin._id },
    { lead_id: carlos._id, type: "meeting", title: "Proposal presentation with Carlos", due_at: at(2 * D), ends_at: at(2 * D + H), location: "Office, Room B", assigned_to: emma._id, department_id: sales._id, created_by: admin._id, attendees: [admin._id] },
    { type: "reminder", title: "Renew office insurance", due_at: at(10 * D), assigned_to: owner._id, created_by: owner._id },
    { type: "reminder", title: "Submit weekly report", due_at: at(1 * D), assigned_to: emma._id, department_id: sales._id, created_by: emma._id },
  ]);

  await M.Task.create([
    { title: "Prepare proposal for Carlos", description: "Include pricing tiers", status: "in_progress", priority: "high", due_at: at(1 * D), lead_id: carlos._id, assigned_to: emma._id, department_id: sales._id, created_by: admin._id },
    { title: "Verify Priya's company details", status: "todo", priority: "medium", due_at: at(3 * D), lead_id: priya._id, assigned_to: emma._id, department_id: sales._id, created_by: admin._id },
    { title: "Update CRM pipeline report", status: "todo", priority: "low", due_at: at(7 * D), assigned_to: admin._id, department_id: sales._id, created_by: owner._id },
    { title: "Call Jean about contract", status: "done", priority: "high", due_at: at(-1 * D), completed_at: at(-1 * D), lead_id: jean._id, assigned_to: ethan._id, department_id: cs._id, created_by: owner._id },
  ]);

  await M.Activity.create([
    { lead_id: carlos._id, type: "call", title: "Discovery call", body: "Interested in the premium package; budget approx. $4k.", user_id: emma._id, department_id: sales._id },
    { lead_id: aisha._id, type: "note", title: "Referred by existing client", body: "Mentioned Noah Bergeron referred her.", user_id: admin._id, department_id: sales._id },
  ]);

  await M.Note.create([
    { title: "Pricing cheat-sheet", body: "Standard: $2,200 · Premium: $5,000 · Rush fee +15%", color: "yellow", pinned: true, assigned_to: emma._id, department_id: sales._id, created_by: emma._id },
    { title: "Carlos — what he cares about", body: "Wants weekly status updates by email. Decision maker is his partner.", color: "blue", lead_id: carlos._id, assigned_to: emma._id, department_id: sales._id, created_by: emma._id },
    { title: "Team reminder", body: "Monthly pipeline review every first Monday.", color: "green", pinned: true, assigned_to: admin._id, department_id: sales._id, created_by: admin._id },
  ]);

  await M.Todo.create([
    { user_id: emma._id, title: "Send Priya the brochure", due_at: at(4 * H), priority: "high", position: 0 },
    { user_id: emma._id, title: "Update lead notes after calls", priority: "medium", position: 1 },
    { user_id: emma._id, title: "Book meeting room for Thursday", done: true, due_at: at(-1 * D), priority: "low", position: 2 },
    { user_id: owner._id, title: "Review Q4 targets", due_at: at(2 * D), priority: "high", position: 0 },
  ]);

  await ensureDefaultChannels();
  const general = await M.ChatChannel.findOne({ type: "general" });
  const salesCh = await M.ChatChannel.findOne({ type: "department", department_id: sales._id });
  const msg = async (d) => { const m = new M.ChatMessage(d); await m.save(); await M.ChatMessage.updateOne({ _id: m._id }, { $set: { created_at: d.created_at } }, { timestamps: false }); };
  await msg({ channel_id: general._id, user_id: owner._id, body: "Welcome to the team chat! Use this channel for company-wide updates.", created_at: at(-3 * D) });
  await msg({ channel_id: salesCh._id, user_id: admin._id, body: "Emma, can you take the Carlos proposal meeting on Thursday?", lead_id: carlos._id, created_at: at(-2 * H) });
  await msg({ channel_id: salesCh._id, user_id: emma._id, body: "Yes, on it. I will bring the pricing sheet.", created_at: at(-1 * H) });
  // older read markers so the seeded messages show as unread
  await M.ChatMember.updateMany({}, { $set: { last_read_at: at(-4 * D) } });

  await M.Integration.create({ kind: "website", name: "Website contact form", enabled: true, config: { api_key: "wk_test_" + crypto.randomBytes(12).toString("hex"), allowed_origins: "*" }, assign_to: emma._id, department_id: sales._id, created_by: owner._id });

  console.log("Sample data loaded. Log in with owner@example.com / Password123! (also admin@, employee@, ethan@example.com)");
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
