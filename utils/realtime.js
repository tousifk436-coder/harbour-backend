/**
 * Realtime sync over Socket.IO. Whenever data changes, connected web and mobile
 * clients receive a small `change` event ({ table, ... }) and refetch what they
 * show. No record data is sent over the socket, so nobody learns about records
 * they are not allowed to see — they simply re-query through the permission-checked API.
 */
const jwt = require("jsonwebtoken");
const config = require("../config");
const { User } = require("../models");

let io = null;

function initRealtime(server, corsOptions) {
  const { Server } = require("socket.io");
  io = new Server(server, { cors: corsOptions || { origin: true, credentials: true }, path: "/socket.io" });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || String(socket.handshake.query?.token || "");
      const payload = jwt.verify(token, config.jwtSecret);
      const user = await User.findById(payload.sub).select("is_active token_version").lean();
      if (!user || !user.is_active || (user.token_version || 0) !== (payload.v || 0)) return next(new Error("unauthorized"));
      socket.data.userId = String(user._id);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.join("authenticated");
    socket.join(`user:${socket.data.userId}`);
  });
  return io;
}

/** Tell clients that `table` changed. Pass userIds to notify only those users (e.g. chat members). */
function emitChange(table, extra = {}, userIds = null) {
  if (!io) return;
  const payload = { table, ...extra };
  if (userIds && userIds.length) {
    let target = io;
    for (const id of new Set(userIds.map(String))) target = target.to(`user:${id}`);
    target.emit("change", payload);
  } else {
    io.to("authenticated").emit("change", payload);
  }
}

module.exports = { initRealtime, emitChange };
