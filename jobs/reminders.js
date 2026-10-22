/**
 * Every 5 minutes: push an Expo notification to the assignee's phones for each
 * pending follow-up due within the next REMINDER_WINDOW_MINUTES, once.
 * (The mobile app also schedules an on-device reminder 10 minutes before.)
 */
const cron = require("node-cron");
const config = require("../config");
const { FollowUp, User, Lead, Client } = require("../models");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function sendFollowupReminders(windowMinutes = config.reminderWindow) {
  const now = Date.now();
  const due = await FollowUp.find({
    status: "pending", notified_at: null, assigned_to: { $ne: null },
    due_at: { $lte: new Date(now + windowMinutes * 60_000), $gte: new Date(now - 24 * 3600_000) },
  }).lean();
  if (!due.length) return { sent: 0, followups: 0 };

  const users = await User.find({ _id: { $in: due.map((f) => f.assigned_to) }, is_active: true, "push_tokens.0": { $exists: true } }).select("push_tokens").lean();
  const tokensOf = Object.fromEntries(users.map((u) => [String(u._id), u.push_tokens]));
  const [leads, clients] = await Promise.all([
    Lead.find({ _id: { $in: due.map((f) => f.lead_id).filter(Boolean) } }).select("name").lean(),
    Client.find({ _id: { $in: due.map((f) => f.client_id).filter(Boolean) } }).select("name").lean(),
  ]);
  const nameOf = Object.fromEntries([...leads, ...clients].map((r) => [String(r._id), r.name]));

  const messages = [];
  const notifiedIds = [];
  for (const f of due) {
    const tokens = tokensOf[String(f.assigned_to)] || [];
    if (!tokens.length) continue;
    notifiedIds.push(f._id);
    const contact = nameOf[String(f.lead_id)] || nameOf[String(f.client_id)] || (f.type === "reminder" ? "Reminder" : "Contact");
    for (const token of tokens) {
      if (!/^Expo(nent)?PushToken\[/.test(token)) continue;
      messages.push({
        to: token, sound: "default", priority: "high", channelId: "followups",
        title: `${cap(f.type)} due: ${f.title}`,
        body: `${contact} · ${new Date(f.due_at).toLocaleString("en-CA", { timeZone: config.timezone })}`,
        data: { followup_id: String(f._id), type: "followup" },
      });
    }
  }

  const invalid = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const r = await fetch(EXPO_PUSH_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(chunk) });
      const result = await r.json().catch(() => ({}));
      (result?.data || []).forEach((t, idx) => { if (t.status === "error" && t.details?.error === "DeviceNotRegistered") invalid.push(chunk[idx].to); });
    } catch (e) {
      console.error("[reminders] push failed:", e.message);
      return { sent: 0, error: e.message };   // leave notified_at unset so we retry next run
    }
  }
  if (invalid.length) await User.updateMany({ push_tokens: { $in: invalid } }, { $pull: { push_tokens: { $in: invalid } } });
  if (notifiedIds.length) await FollowUp.updateMany({ _id: { $in: notifiedIds } }, { $set: { notified_at: new Date() } });
  return { sent: messages.length, followups: notifiedIds.length, pruned_tokens: invalid.length };
}

function startReminderJob() {
  cron.schedule("*/5 * * * *", () => {
    sendFollowupReminders().then((r) => { if (r.sent) console.log("[reminders]", r); }).catch((e) => console.error("[reminders]", e));
  });
}

module.exports = { startReminderJob, sendFollowupReminders };
