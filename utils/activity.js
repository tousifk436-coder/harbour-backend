const { Activity } = require("../models");
const { parentDepartment } = require("./access");
const { emitChange } = require("./realtime");

/** Add an entry to a lead's / client's history. Department is inherited from the parent. */
async function logActivity({ lead_id = null, client_id = null, type = "note", title, body = null, metadata = {}, user_id = null, department_id }) {
  const dept = department_id !== undefined ? department_id : await parentDepartment(lead_id, client_id);
  const a = await Activity.create({ lead_id, client_id, type, title, body, metadata, user_id, department_id: dept });
  emitChange("activities");
  return a;
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

module.exports = { logActivity, cap };
