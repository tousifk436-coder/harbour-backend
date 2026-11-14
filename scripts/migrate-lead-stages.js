require("dotenv").config();
const mongoose = require("mongoose");
const { Lead } = require("../models");
const mapping = { new: "new_lead", contacted: "follow_up", proposal: "meeting_scheduled", won: "sale_done", lost: "junk" };
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  for (const [oldStage, newStage] of Object.entries(mapping)) {
    const result = await Lead.collection.updateMany({ status: oldStage }, { $set: { status: newStage } });
    console.log(`${oldStage} -> ${newStage}: ${result.modifiedCount}`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
