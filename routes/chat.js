const router = require("express").Router();
const { ChatChannel, ChatMember, ChatMessage, User } = require("../models");
const {
  wrap,
  bad,
  forbidden,
  notFound,
  idParam,
  oid,
  sameId,
  json,
} = require("../utils/http");
const { isAdmin, canAccessParent } = require("../utils/access");
const { myChannels, isMember } = require("../utils/chat");
const { addMembers } = require("../utils/channels");
const { emitChange } = require("../utils/realtime");

async function memberIds(channelId) {
  return (
    await ChatMember.find({ channel_id: channelId }).select("user_id").lean()
  ).map((m) => String(m.user_id));
}

router.get(
  "/channels",
  wrap(async (req, res) => {
    res.json(await myChannels(req.user._id));
  }),
);

// GET /api/chat/people -> everyone in the company you can message (all active staff, any department)
router.get(
  "/people",
  wrap(async (req, res) => {
    const rows = await User.find({
      is_active: true,
      _id: { $ne: req.user._id },
    })
      .select("full_name role department_id phone email")
      .populate({ path: "department", select: "name" })
      .sort({ full_name: 1 });
    res.json(rows.map(json));
  }),
);

// GET /api/chat/channels/:id/messages?before=<iso>  -> oldest first, 60 per page
router.get(
  "/channels/:id/messages",
  wrap(async (req, res) => {
    const cid = idParam(req.params.id);
    if (!(await isMember(cid, req.user._id)))
      throw notFound("Channel not found");
    const filter = { channel_id: cid };
    if (req.query.before)
      filter.created_at = { $lt: new Date(String(req.query.before)) };
    const rows = await ChatMessage.find(filter)
      .sort({ created_at: -1 })
      .limit(60)
      .populate([
        { path: "user", select: "full_name" },
        { path: "lead", select: "name" },
        { path: "client", select: "name" },
      ]);
    res.json(rows.reverse().map(json));
  }),
);

router.post(
  "/channels/:id/messages",
  wrap(async (req, res) => {
    const cid = idParam(req.params.id);
    if (!(await isMember(cid, req.user._id)))
      throw forbidden("You are not a member of this channel.");
    const body = String(req.body.body || "").trim();
    if (!body) throw bad("Message is empty");
    if (body.length > 4000)
      throw bad("Message is too long (max 4000 characters)");
    const lead_id = oid(req.body.lead_id),
      client_id = oid(req.body.client_id);
    if (
      (lead_id || client_id) &&
      !(await canAccessParent(req.user, lead_id, client_id))
    )
      throw forbidden("You cannot share that record.");
    const m = await ChatMessage.create({
      channel_id: cid,
      user_id: req.user._id,
      body,
      lead_id,
      client_id,
    });
    await ChatMember.updateOne(
      { channel_id: cid, user_id: req.user._id },
      { $set: { last_read_at: new Date() } },
    );
    emitChange(
      "chat_messages",
      { channel_id: String(cid) },
      await memberIds(cid),
    );
    res.status(201).json(json(m));
  }),
);

router.delete(
  "/messages/:id",
  wrap(async (req, res) => {
    const m = await ChatMessage.findById(idParam(req.params.id));
    if (!m) throw notFound();
    if (!sameId(m.user_id, req.user._id) && !isAdmin(req.user))
      throw forbidden();
    await m.deleteOne();
    emitChange(
      "chat_messages",
      { channel_id: String(m.channel_id) },
      await memberIds(m.channel_id),
    );
    res.json({ ok: true });
  }),
);

router.post(
  "/channels/:id/read",
  wrap(async (req, res) => {
    const cid = idParam(req.params.id);
    await ChatMember.updateOne(
      { channel_id: cid, user_id: req.user._id },
      { $set: { last_read_at: new Date() } },
    );
    res.json({ ok: true });
  }),
);

// POST /api/chat/direct { user_id } -> { id }
router.post(
  "/direct",
  wrap(async (req, res) => {
    const me = req.user._id;
    const other = oid(req.body.user_id);
    if (!other || sameId(other, me)) throw bad("Invalid user");
    if (!(await User.exists({ _id: other, is_active: true })))
      throw bad("User not found");
    const key = [String(me), String(other)].sort().join(":");
    let ch = await ChatChannel.findOne({ direct_key: key });
    if (!ch) {
      try {
        ch = await ChatChannel.create({
          type: "direct",
          direct_key: key,
          created_by: me,
        });
      } catch (e) {
        if (e.code === 11000)
          ch = await ChatChannel.findOne({ direct_key: key });
        else throw e;
      }
      await addMembers(ch._id, [me, other]);
      emitChange("chat_channels", {}, [me, other]);
    }
    res.json({ id: String(ch._id) });
  }),
);

// POST /api/chat/groups { name, member_ids } -> { id }
router.post(
  "/groups",
  wrap(async (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) throw bad("Group name is required");
    const ids = (Array.isArray(req.body.member_ids) ? req.body.member_ids : [])
      .map(oid)
      .filter(Boolean);
    const valid = await User.find({
      _id: { $in: ids },
      is_active: true,
    }).distinct("_id");
    const members = [req.user._id, ...valid];
    const ch = await ChatChannel.create({
      type: "group",
      name,
      created_by: req.user._id,
    });
    await addMembers(ch._id, members);
    emitChange("chat_channels", {}, members);
    res.status(201).json({ id: String(ch._id) });
  }),
);

module.exports = router;
