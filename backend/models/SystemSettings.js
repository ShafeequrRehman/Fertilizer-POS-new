const mongoose = require("mongoose");

// Singleton document (there is always exactly one) backing the Super
// Admin's "Manage Software Settings" screen - product-wide defaults, not
// anything shop-specific.
const systemSettingsSchema = new mongoose.Schema(
  {
    supportEmail: { type: String, default: "" },
    supportPhone: { type: String, default: "" },
    defaultCurrency: { type: String, default: "PKR" },
    defaultTrialDays: { type: Number, default: 14, min: 0 },
    licenseExpiryWarningDays: { type: Number, default: 7, min: 0 },
    maintenanceMode: { type: Boolean, default: false },
    announcement: { type: String, default: "" },
  },
  { timestamps: true }
);

systemSettingsSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

module.exports = mongoose.model("SystemSettings", systemSettingsSchema);
