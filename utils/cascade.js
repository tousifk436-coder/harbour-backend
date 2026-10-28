/** Mirrors the ON DELETE CASCADE / SET NULL rules of the original schema. */
const { deleteFiles } = require("./files");
const {
  Lead,
  Client,
  FollowUp,
  Task,
  Document,
  Payment,
  Activity,
  Note,
  ChatMessage,
  IntegrationEvent,
} = require("../models");

/** Deletes the stored files (in MongoDB, or on disk for old uploads). */
async function removeFiles(docs) {
  await deleteFiles(docs);
}

async function deleteLeadCascade(leadId) {
  const docs = await Document.find({ lead_id: leadId }).lean();
  await removeFiles(docs);
  await Promise.all([
    FollowUp.deleteMany({ lead_id: leadId }),
    Document.deleteMany({ lead_id: leadId }),
    Activity.deleteMany({ lead_id: leadId }),
    Task.updateMany({ lead_id: leadId }, { $set: { lead_id: null } }),
    Note.updateMany({ lead_id: leadId }, { $set: { lead_id: null } }),
    Client.updateMany({ lead_id: leadId }, { $set: { lead_id: null } }),
    ChatMessage.updateMany({ lead_id: leadId }, { $set: { lead_id: null } }),
    IntegrationEvent.updateMany(
      { lead_id: leadId },
      { $set: { lead_id: null } },
    ),
  ]);
  await Lead.deleteOne({ _id: leadId });
}

async function deleteClientCascade(clientId) {
  const docs = await Document.find({ client_id: clientId }).lean();
  await removeFiles(docs);
  await Promise.all([
    FollowUp.deleteMany({ client_id: clientId }),
    Document.deleteMany({ client_id: clientId }),
    Payment.deleteMany({ client_id: clientId }),
    Activity.deleteMany({ client_id: clientId }),
    Task.updateMany({ client_id: clientId }, { $set: { client_id: null } }),
    Note.updateMany({ client_id: clientId }, { $set: { client_id: null } }),
    ChatMessage.updateMany(
      { client_id: clientId },
      { $set: { client_id: null } },
    ),
    Lead.updateMany(
      { converted_client_id: clientId },
      { $set: { converted_client_id: null } },
    ),
  ]);
  await Client.deleteOne({ _id: clientId });
}

module.exports = { deleteLeadCascade, deleteClientCascade, removeFiles };
