/**
 * Default chat channels: "General" for everyone and one per department.
 * Membership is kept in sync whenever users or departments change.
 */
const { ChatChannel, ChatMember, Department, User } = require("../models");

async function addMembers(channelId, userIds) {
  if (!userIds.length) return;
  await ChatMember.bulkWrite(
    userIds.map((uid) => ({
      updateOne: { filter: { channel_id: channelId, user_id: uid }, update: { $setOnInsert: { channel_id: channelId, user_id: uid, last_read_at: new Date() } }, upsert: true },
    })),
    { ordered: false },
  );
}

async function ensureDefaultChannels() {
  let general = await ChatChannel.findOne({ type: "general" });
  if (!general) general = await ChatChannel.create({ type: "general", name: "General" });

  const [departments, users] = await Promise.all([Department.find().lean(), User.find({ is_active: true }).select("role department_id").lean()]);

  // everyone active is in General
  await addMembers(general._id, users.map((u) => u._id));

  const supers = users.filter((u) => u.role === "super_admin").map((u) => u._id);
  for (const d of departments) {
    let ch = await ChatChannel.findOne({ type: "department", department_id: d._id });
    if (!ch) ch = await ChatChannel.create({ type: "department", name: d.name, department_id: d._id });
    else if (ch.name !== d.name) { ch.name = d.name; await ch.save(); }
    const members = users.filter((u) => u.department_id && String(u.department_id) === String(d._id)).map((u) => u._id);
    await addMembers(ch._id, [...members, ...supers]);

    // remove people who left the department (super admins stay in every department channel)
    const keep = new Set([...members, ...supers].map(String));
    const current = await ChatMember.find({ channel_id: ch._id }).select("user_id").lean();
    const remove = current.filter((m) => !keep.has(String(m.user_id))).map((m) => m.user_id);
    if (remove.length) await ChatMember.deleteMany({ channel_id: ch._id, user_id: { $in: remove } });
  }

  // deactivated users leave General and department channels
  const inactive = await User.find({ is_active: false }).distinct("_id");
  if (inactive.length) {
    const defaults = await ChatChannel.find({ type: { $in: ["general", "department"] } }).distinct("_id");
    await ChatMember.deleteMany({ channel_id: { $in: defaults }, user_id: { $in: inactive } });
  }
}

module.exports = { ensureDefaultChannels, addMembers };
