/**
 * Permission model (enforced on the server for every request):
 *   super_admin : everything, every department
 *   admin       : every record in their own department (+ records with no department)
 *   employee    : only records assigned to them or created by them
 */
const { User, Lead, Client } = require("../models");
const { sameId, forbidden, notFound } = require("./http");

const isAdmin = (u) => u.role === "admin" || u.role === "super_admin";
const isSuper = (u) => u.role === "super_admin";

/** Mongo filter that limits a query on leads/clients/follow-ups/tasks/notes to what `u` may see. */
function scopeFilter(u) {
  if (u.role === "super_admin") return {};
  if (u.role === "admin") {
    return u.department_id ? { department_id: { $in: [null, u.department_id] } } : { department_id: null };
  }
  return { $or: [{ assigned_to: u._id }, { created_by: u._id }] };
}

/** Same rule as scopeFilter, for a single loaded record. */
function canAccess(u, rec) {
  if (!rec) return false;
  if (u.role === "super_admin") return true;
  if (u.role === "admin") return rec.department_id == null || sameId(rec.department_id, u.department_id);
  return sameId(rec.assigned_to, u._id) || sameId(rec.created_by, u._id);
}

/** Can `u` assign work to user `targetId`? */
async function canAssignTo(u, targetId) {
  if (!targetId) return true;
  if (u.role === "super_admin") return true;
  if (sameId(targetId, u._id)) return true;
  if (u.role === "admin") {
    const t = await User.findById(targetId).select("department_id").lean();
    return !!t && t.department_id != null && sameId(t.department_id, u.department_id);
  }
  return false;
}

/**
 * Stamp created_by / assigned_to / department_id on a new record so employees'
 * records always belong to them (an employee cannot assign to someone else).
 */
async function stampOwnership(u, data) {
  data.created_by = u._id;
  if (u.role === "employee" || !data.assigned_to) data.assigned_to = u._id;
  if (!data.department_id) {
    const a = await User.findById(data.assigned_to).select("department_id").lean();
    data.department_id = (a && a.department_id) || u.department_id || null;
  }
  return data;
}

/** Load a lead/client and verify access; throws 404 if missing or not allowed. */
async function loadAccessible(Model, u, id) {
  const rec = await Model.findById(id);
  if (!rec || !canAccess(u, rec)) throw notFound();
  return rec;
}

/** Access for child records (documents, payments, activities) follows the parent lead/client. */
async function canAccessParent(u, leadId, clientId) {
  if (leadId) {
    const l = await Lead.findById(leadId).select("department_id assigned_to created_by").lean();
    if (l) return canAccess(u, l);
  }
  if (clientId) {
    const c = await Client.findById(clientId).select("department_id assigned_to created_by").lean();
    if (c) return canAccess(u, c);
  }
  return false;
}
async function assertParent(u, leadId, clientId) {
  if (!(await canAccessParent(u, leadId, clientId))) throw notFound("Record not found or access denied");
}

/** Department inherited from the parent record (client first, then lead). */
async function parentDepartment(leadId, clientId) {
  if (clientId) { const c = await Client.findById(clientId).select("department_id").lean(); if (c) return c.department_id; }
  if (leadId) { const l = await Lead.findById(leadId).select("department_id").lean(); if (l) return l.department_id; }
  return null;
}

/** ids of every lead / client visible to `u` (null means "no restriction"). */
async function visibleIds(u) {
  if (u.role === "super_admin") return { leadIds: null, clientIds: null };
  const f = scopeFilter(u);
  const [leadIds, clientIds] = await Promise.all([Lead.find(f).distinct("_id"), Client.find(f).distinct("_id")]);
  return { leadIds, clientIds };
}

function requireAdmin(u) { if (!isAdmin(u)) throw forbidden(); }
function requireSuper(u) { if (!isSuper(u)) throw forbidden(); }

module.exports = { isAdmin, isSuper, scopeFilter, canAccess, canAssignTo, stampOwnership, loadAccessible, canAccessParent, assertParent, parentDepartment, visibleIds, requireAdmin, requireSuper };
