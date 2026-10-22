const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/** Enum values shared with the web and mobile apps. */
const ENUMS = {
  role: ["super_admin", "admin", "employee"],
  leadStatus: ["new", "contacted", "qualified", "proposal", "won", "lost"],
  leadSource: ["website", "referral", "social_media", "facebook", "phone", "walk_in", "advertisement", "other"],
  followupType: ["call", "meeting", "reminder", "email", "whatsapp"],
  followupStatus: ["pending", "done", "cancelled"],
  taskStatus: ["todo", "in_progress", "done"],
  priority: ["low", "medium", "high"],
  serviceStatus: ["onboarding", "in_progress", "on_hold", "completed", "cancelled"],
  paymentStatus: ["pending", "paid", "overdue", "refunded"],
  activityType: ["note", "call", "email", "meeting", "status_change", "assignment", "document", "payment", "created", "converted", "system"],
  noteColor: ["yellow", "pink", "blue", "green", "purple", "orange"],
  channelType: ["general", "department", "direct", "group"],
  integrationKind: ["facebook", "website"],
};

/**
 * JSON output matches what the apps expect: `id` instead of `_id`, snake_case
 * fields, ObjectIds as strings, populated relations as nested objects.
 */
function transform(_doc, ret) {
  ret.id = String(ret._id);
  delete ret._id;
  delete ret.__v;
  delete ret.password_hash;
  delete ret.reset_token_hash;
  delete ret.reset_expires;
  delete ret.token_version;
  delete ret.phone_digits;
  return ret;
}

function baseOptions(extra = {}) {
  return {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    toJSON: { virtuals: true, versionKey: false, transform },
    toObject: { virtuals: true, versionKey: false, transform },
    id: false,
    ...extra,
  };
}

/** Adds a populate-able virtual, e.g. `assignee` -> profile referenced by `assigned_to`. */
function relation(schema, name, ref, localField) {
  schema.virtual(name, { ref, localField, foreignField: "_id", justOne: true });
}

const nullableRef = (ref) => ({ type: ObjectId, ref, default: null });
const str = { type: String, default: null, trim: true };

module.exports = { mongoose, Schema, ObjectId, ENUMS, baseOptions, relation, nullableRef, str };
