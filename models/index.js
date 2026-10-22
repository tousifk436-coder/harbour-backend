const { mongoose, Schema, ObjectId, ENUMS, baseOptions, relation, nullableRef, str } = require("./_base");

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const digits = (s) => (s ? String(s).replace(/\D/g, "") : null);

// ---------------- Departments ----------------
const departmentSchema = new Schema({ name: { type: String, required: true, unique: true, trim: true } }, baseOptions({ timestamps: { createdAt: "created_at", updatedAt: false } }));
const Department = mongoose.model("Department", departmentSchema);

// ---------------- Users / profiles ----------------
const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  full_name: { type: String, default: "", trim: true },
  phone: str,
  role: { type: String, enum: ENUMS.role, default: "employee" },
  department_id: nullableRef("Department"),
  is_active: { type: Boolean, default: true },
  avatar_url: str,
  push_tokens: { type: [String], default: [] },
  token_version: { type: Number, default: 0 },
  reset_token_hash: { type: String, default: null },
  reset_expires: { type: Date, default: null },
}, baseOptions());
userSchema.index({ department_id: 1 });
userSchema.index({ role: 1 });
relation(userSchema, "department", "Department", "department_id");
const User = mongoose.model("User", userSchema);

// ---------------- Leads ----------------
const leadSchema = new Schema({
  name: { type: String, required: [true, "Name is required"], trim: true, maxlength: 200 },
  phone: str,
  phone_digits: { type: String, default: null },
  email: { type: String, default: null, trim: true, validate: { validator: (v) => v == null || v === "" || EMAIL_RE.test(v), message: "Invalid value: email address is not valid" } },
  company: str,
  address: str,
  source: { type: String, enum: ENUMS.leadSource, default: "other" },
  status: { type: String, enum: ENUMS.leadStatus, default: "new" },
  estimated_value: { type: Number, default: 0, min: [0, "Estimated value cannot be negative"] },
  notes: str,
  assigned_to: nullableRef("User"),
  department_id: nullableRef("Department"),
  created_by: nullableRef("User"),
  converted_client_id: nullableRef("Client"),
  last_contacted_at: { type: Date, default: null },
}, baseOptions());
leadSchema.pre("save", function (next) { this.phone_digits = digits(this.phone); if (this.email === "") this.email = null; next(); });
leadSchema.index({ assigned_to: 1 }); leadSchema.index({ department_id: 1 }); leadSchema.index({ status: 1 }); leadSchema.index({ created_at: -1 });
leadSchema.index({ email: 1 }); leadSchema.index({ phone_digits: 1 });
relation(leadSchema, "assignee", "User", "assigned_to");
const Lead = mongoose.model("Lead", leadSchema);

// ---------------- Clients ----------------
const clientSchema = new Schema({
  lead_id: nullableRef("Lead"),
  name: { type: String, required: [true, "Name is required"], trim: true },
  phone: str, email: str, company: str, address: str,
  service_status: { type: String, enum: ENUMS.serviceStatus, default: "onboarding" },
  service_name: str,
  contract_value: { type: Number, default: 0, min: [0, "Contract value cannot be negative"] },
  notes: str,
  assigned_to: nullableRef("User"),
  department_id: nullableRef("Department"),
  created_by: nullableRef("User"),
}, baseOptions());
clientSchema.index({ assigned_to: 1 }); clientSchema.index({ department_id: 1 });
relation(clientSchema, "assignee", "User", "assigned_to");
const Client = mongoose.model("Client", clientSchema);

// ---------------- Follow-ups / reminders / meetings ----------------
const followUpSchema = new Schema({
  lead_id: nullableRef("Lead"),
  client_id: nullableRef("Client"),
  type: { type: String, enum: ENUMS.followupType, default: "call" },
  title: { type: String, required: [true, "Title is required"], trim: true },
  due_at: { type: Date, required: [true, "Date is required"] },
  ends_at: { type: Date, default: null },
  status: { type: String, enum: ENUMS.followupStatus, default: "pending" },
  notes: str, outcome: str, location: str, meeting_link: str,
  attendees: { type: [{ type: ObjectId, ref: "User" }], default: [] },
  assigned_to: nullableRef("User"),
  department_id: nullableRef("Department"),
  created_by: nullableRef("User"),
  notified_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
}, baseOptions());
followUpSchema.index({ status: 1, due_at: 1 }); followUpSchema.index({ assigned_to: 1 }); followUpSchema.index({ lead_id: 1 }); followUpSchema.index({ client_id: 1 });
relation(followUpSchema, "lead", "Lead", "lead_id");
relation(followUpSchema, "client", "Client", "client_id");
relation(followUpSchema, "assignee", "User", "assigned_to");
const FollowUp = mongoose.model("FollowUp", followUpSchema);

// ---------------- Tasks ----------------
const taskSchema = new Schema({
  title: { type: String, required: [true, "Title is required"], trim: true },
  description: str,
  status: { type: String, enum: ENUMS.taskStatus, default: "todo" },
  priority: { type: String, enum: ENUMS.priority, default: "medium" },
  due_at: { type: Date, default: null },
  lead_id: nullableRef("Lead"),
  client_id: nullableRef("Client"),
  assigned_to: nullableRef("User"),
  department_id: nullableRef("Department"),
  created_by: nullableRef("User"),
  completed_at: { type: Date, default: null },
}, baseOptions());
taskSchema.index({ assigned_to: 1 }); taskSchema.index({ status: 1 });
relation(taskSchema, "lead", "Lead", "lead_id");
relation(taskSchema, "client", "Client", "client_id");
relation(taskSchema, "assignee", "User", "assigned_to");
const Task = mongoose.model("Task", taskSchema);

// ---------------- Documents (files live on disk in UPLOAD_DIR) ----------------
const documentSchema = new Schema({
  lead_id: nullableRef("Lead"),
  client_id: nullableRef("Client"),
  name: { type: String, required: true },
  storage_path: { type: String, required: true, unique: true },
  mime_type: str,
  size_bytes: { type: Number, default: null },
  department_id: nullableRef("Department"),
  uploaded_by: nullableRef("User"),
}, baseOptions({ timestamps: { createdAt: "created_at", updatedAt: false } }));
documentSchema.index({ client_id: 1 }); documentSchema.index({ lead_id: 1 });
relation(documentSchema, "uploader", "User", "uploaded_by");
const Document = mongoose.model("Document", documentSchema);

// ---------------- Payments ----------------
const paymentSchema = new Schema({
  client_id: { type: ObjectId, ref: "Client", required: true },
  amount: { type: Number, required: true, validate: { validator: (v) => v > 0, message: "Amount must be greater than 0" } },
  currency: { type: String, default: "CAD" },
  status: { type: String, enum: ENUMS.paymentStatus, default: "pending" },
  description: str,
  due_at: { type: String, default: null },   // YYYY-MM-DD
  paid_at: { type: Date, default: null },
  department_id: nullableRef("Department"),
  created_by: nullableRef("User"),
}, baseOptions());
paymentSchema.index({ client_id: 1 }); paymentSchema.index({ status: 1 });
const Payment = mongoose.model("Payment", paymentSchema);

// ---------------- Activity / interaction history ----------------
const activitySchema = new Schema({
  lead_id: nullableRef("Lead"),
  client_id: nullableRef("Client"),
  type: { type: String, enum: ENUMS.activityType, default: "note" },
  title: { type: String, required: true },
  body: str,
  metadata: { type: Schema.Types.Mixed, default: {} },
  department_id: nullableRef("Department"),
  user_id: nullableRef("User"),
}, baseOptions({ timestamps: { createdAt: "created_at", updatedAt: false }, minimize: false }));
activitySchema.index({ lead_id: 1, created_at: -1 }); activitySchema.index({ client_id: 1, created_at: -1 }); activitySchema.index({ user_id: 1, created_at: -1 });
relation(activitySchema, "user", "User", "user_id");
const Activity = mongoose.model("Activity", activitySchema);

// ---------------- Personal to-dos ----------------
const todoSchema = new Schema({
  user_id: { type: ObjectId, ref: "User", required: true },
  title: { type: String, required: [true, "Title is required"], trim: true, maxlength: 300 },
  done: { type: Boolean, default: false },
  due_at: { type: Date, default: null },
  priority: { type: String, enum: ENUMS.priority, default: "medium" },
  position: { type: Number, default: 0 },
}, baseOptions());
todoSchema.index({ user_id: 1, done: 1, position: 1 });
const Todo = mongoose.model("Todo", todoSchema);

// ---------------- Notes ----------------
const noteSchema = new Schema({
  title: { type: String, default: "" },
  body: { type: String, default: "" },
  color: { type: String, enum: ENUMS.noteColor, default: "yellow" },
  pinned: { type: Boolean, default: false },
  lead_id: nullableRef("Lead"),
  client_id: nullableRef("Client"),
  assigned_to: nullableRef("User"),
  department_id: nullableRef("Department"),
  created_by: nullableRef("User"),
}, baseOptions());
noteSchema.index({ assigned_to: 1, pinned: -1, updated_at: -1 });
relation(noteSchema, "lead", "Lead", "lead_id");
relation(noteSchema, "client", "Client", "client_id");
relation(noteSchema, "owner", "User", "assigned_to");
const Note = mongoose.model("Note", noteSchema);

// ---------------- Chat ----------------
const channelSchema = new Schema({
  type: { type: String, enum: ENUMS.channelType, default: "group" },
  name: { type: String, default: null },
  department_id: nullableRef("Department"),
  direct_key: { type: String, default: undefined },
  created_by: nullableRef("User"),
}, baseOptions({ timestamps: { createdAt: "created_at", updatedAt: false } }));
channelSchema.index({ direct_key: 1 }, { unique: true, sparse: true });
const ChatChannel = mongoose.model("ChatChannel", channelSchema);

const memberSchema = new Schema({
  channel_id: { type: ObjectId, ref: "ChatChannel", required: true },
  user_id: { type: ObjectId, ref: "User", required: true },
  last_read_at: { type: Date, default: () => new Date() },
}, baseOptions({ timestamps: false }));
memberSchema.index({ channel_id: 1, user_id: 1 }, { unique: true });
memberSchema.index({ user_id: 1 });
const ChatMember = mongoose.model("ChatMember", memberSchema);

const messageSchema = new Schema({
  channel_id: { type: ObjectId, ref: "ChatChannel", required: true },
  user_id: { type: ObjectId, ref: "User", required: true },
  body: { type: String, required: true, maxlength: 4000 },
  lead_id: nullableRef("Lead"),
  client_id: nullableRef("Client"),
}, baseOptions({ timestamps: { createdAt: "created_at", updatedAt: false } }));
messageSchema.index({ channel_id: 1, created_at: -1 });
relation(messageSchema, "user", "User", "user_id");
relation(messageSchema, "lead", "Lead", "lead_id");
relation(messageSchema, "client", "Client", "client_id");
const ChatMessage = mongoose.model("ChatMessage", messageSchema);

// ---------------- Integrations ----------------
const integrationSchema = new Schema({
  kind: { type: String, enum: ENUMS.integrationKind, required: true },
  name: { type: String, required: true, trim: true },
  enabled: { type: Boolean, default: true },
  config: { type: Schema.Types.Mixed, default: {} },
  assign_to: nullableRef("User"),
  department_id: nullableRef("Department"),
  leads_received: { type: Number, default: 0 },
  last_lead_at: { type: Date, default: null },
  created_by: nullableRef("User"),
}, baseOptions({ minimize: false }));
integrationSchema.index({ kind: 1, "config.api_key": 1 });
integrationSchema.index({ kind: 1, "config.page_id": 1 });
const Integration = mongoose.model("Integration", integrationSchema);

const integrationEventSchema = new Schema({
  integration_id: { type: ObjectId, ref: "Integration", required: true },
  lead_id: nullableRef("Lead"),
  status: { type: String, required: true },   // received | created | duplicate | error
  detail: str,
  payload: { type: Schema.Types.Mixed, default: null },
}, baseOptions({ timestamps: { createdAt: "created_at", updatedAt: false } }));
integrationEventSchema.index({ integration_id: 1, created_at: -1 });
const IntegrationEvent = mongoose.model("IntegrationEvent", integrationEventSchema);

module.exports = {
  ENUMS, EMAIL_RE, digits,
  Department, User, Lead, Client, FollowUp, Task, Document, Payment, Activity, Todo, Note,
  ChatChannel, ChatMember, ChatMessage, Integration, IntegrationEvent,
};
