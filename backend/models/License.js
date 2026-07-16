const mongoose = require("mongoose");

const renewalEntrySchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },
    months: { type: Number, required: true },
    previousExpiry: { type: Date },
    newExpiry: { type: Date, required: true },
    extendedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    note: { type: String, default: "" },
  },
  { _id: false }
);

// One License per Shop. Only the Super Admin can ever create, extend, or
// change the status of a License - see requireSuperAdmin usage on every
// license-mutating route in routes/superAdminRoutes.js. Shop Owners and
// Employees can only read their own shop's license status (to show the
// "License expires in N days" banner / the License Expired screen).
const licenseSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, unique: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan" },
    startDate: { type: Date, required: true, default: Date.now },
    expiryDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["trial", "active", "expired", "suspended"],
      default: "trial",
      index: true,
    },
    lastRenewal: { type: Date, default: null },
    renewalHistory: { type: [renewalEntrySchema], default: [] },
  },
  { timestamps: true }
);

// Derives the effective status from expiryDate/manual status without
// requiring a background job - `isExpired()` is checked at login time and
// on every protected shop-data request (see middleware/requireLicenseValid.js).
licenseSchema.methods.isExpired = function isExpired() {
  if (this.status === "suspended") return true;
  return this.expiryDate.getTime() < Date.now();
};

module.exports = mongoose.model("License", licenseSchema);
