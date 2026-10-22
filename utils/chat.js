const { ChatChannel, ChatMember, ChatMessage, User } = require("../models");

/** Channel list for a user with unread counts and the other participant for DMs. */
async function myChannels(userId) {
  const memberships = await ChatMember.find({ user_id: userId }).lean();
  if (!memberships.length) return [];
  const ids = memberships.map((m) => m.channel_id);
  const readAt = Object.fromEntries(memberships.map((m) => [String(m.channel_id), m.last_read_at]));
  const channels = await ChatChannel.find({ _id: { $in: ids } }).lean();

  // other participant for direct messages
  const directIds = channels.filter((c) => c.type === "direct").map((c) => c._id);
  const others = directIds.length ? await ChatMember.find({ channel_id: { $in: directIds }, user_id: { $ne: userId } }).lean() : [];
  const otherUsers = others.length ? await User.find({ _id: { $in: others.map((o) => o.user_id) } }).select("full_name").lean() : [];
  const nameOf = Object.fromEntries(otherUsers.map((u) => [String(u._id), u.full_name]));
  const otherOf = Object.fromEntries(others.map((o) => [String(o.channel_id), String(o.user_id)]));

  // last message per channel
  const last = await Promise.all(channels.map((c) => ChatMessage.findOne({ channel_id: c._id }).sort({ created_at: -1 }).select("body created_at").lean()));
  const lastOf = Object.fromEntries(channels.map((c, i) => [String(c._id), last[i]]));

  // unread counts
  const unreadRows = await Promise.all(channels.map((c) => ChatMessage.countDocuments({
    channel_id: c._id, user_id: { $ne: userId }, created_at: { $gt: readAt[String(c._id)] || new Date(0) },
  })));

  const rows = channels.map((c, i) => {
    const id = String(c._id);
    const otherId = otherOf[id] || null;
    const lm = lastOf[id];
    return {
      id, type: c.type,
      name: c.name || (otherId ? nameOf[otherId] : null) || "Chat",
      department_id: c.department_id ? String(c.department_id) : null,
      other_user_id: c.type === "direct" ? otherId : null,
      other_user_name: c.type === "direct" && otherId ? nameOf[otherId] || null : null,
      last_message: lm ? lm.body : null,
      last_message_at: lm ? lm.created_at : null,
      unread: unreadRows[i],
      _sort: (lm ? lm.created_at : c.created_at).getTime(),
    };
  });
  rows.sort((a, b) => b._sort - a._sort);
  return rows.map(({ _sort, ...r }) => r);
}

async function isMember(channelId, userId) {
  return !!(await ChatMember.exists({ channel_id: channelId, user_id: userId }));
}

module.exports = { myChannels, isMember };
