/**
 * Default chat channels, kept separate per workspace (company):
 * "General" for everyone in the company, plus one channel per department.
 * Membership is synced whenever users or departments change.
 */
const {
  ChatChannel,
  ChatMember,
  Department,
  User,
  Workspace,
} = require("../models");

async function addMembers(channelId, workspaceId, userIds) {
  if (!userIds.length) return;
  await ChatMember.bulkWrite(
    userIds.map((uid) => ({
      updateOne: {
        filter: { channel_id: channelId, user_id: uid },
        update: {
          $setOnInsert: {
            workspace_id: workspaceId,
            channel_id: channelId,
            user_id: uid,
            last_read_at: new Date(),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

/** Build/refresh the default channels for ONE company. */
async function ensureDefaultChannels(workspaceId) {
  if (!workspaceId) return;
  let general = await ChatChannel.findOne({
    type: "general",
    workspace_id: workspaceId,
  });
  if (!general)
    general = await ChatChannel.create({
      workspace_id: workspaceId,
      type: "general",
      name: "General",
    });

  const [departments, users] = await Promise.all([
    Department.find({ workspace_id: workspaceId }).lean(),
    User.find({ workspace_id: workspaceId, is_active: true })
      .select("role department_id")
      .lean(),
  ]);

  // everyone active in this company is in General
  await addMembers(
    general._id,
    workspaceId,
    users.map((u) => u._id),
  );

  const supers = users
    .filter((u) => u.role === "super_admin")
    .map((u) => u._id);
  for (const d of departments) {
    let ch = await ChatChannel.findOne({
      type: "department",
      department_id: d._id,
      workspace_id: workspaceId,
    });
    if (!ch)
      ch = await ChatChannel.create({
        workspace_id: workspaceId,
        type: "department",
        name: d.name,
        department_id: d._id,
      });
    else if (ch.name !== d.name) {
      ch.name = d.name;
      await ch.save();
    }
    const members = users
      .filter(
        (u) => u.department_id && String(u.department_id) === String(d._id),
      )
      .map((u) => u._id);
    await addMembers(ch._id, workspaceId, [...members, ...supers]);

    // remove people who left the department (super admins stay in every department channel)
    const keep = new Set([...members, ...supers].map(String));
    const current = await ChatMember.find({ channel_id: ch._id })
      .select("user_id")
      .lean();
    const remove = current
      .filter((m) => !keep.has(String(m.user_id)))
      .map((m) => m.user_id);
    if (remove.length)
      await ChatMember.deleteMany({
        channel_id: ch._id,
        user_id: { $in: remove },
      });
  }

  // deactivated users leave the default channels of this company
  const inactive = await User.find({
    workspace_id: workspaceId,
    is_active: false,
  }).distinct("_id");
  if (inactive.length) {
    const defaults = await ChatChannel.find({
      workspace_id: workspaceId,
      type: { $in: ["general", "department"] },
    }).distinct("_id");
    await ChatMember.deleteMany({
      channel_id: { $in: defaults },
      user_id: { $in: inactive },
    });
  }
}

/** Refresh default channels for every company (used at server startup). */
async function ensureAllWorkspaceChannels() {
  const ids = await Workspace.find().distinct("_id");
  for (const id of ids) await ensureDefaultChannels(id);
}

module.exports = {
  ensureDefaultChannels,
  ensureAllWorkspaceChannels,
  addMembers,
};
