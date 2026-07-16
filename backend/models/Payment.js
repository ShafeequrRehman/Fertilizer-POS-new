const mongoose = require("mongoose");

// Internal payment record-keeping (no live payment gateway integration).
// The Super Admin manually logs a payment when a shop pays for a
// plan/renewal; this is what backs the "View Payments" screen and feeds
// License.renewalHistory when the license is extended in the same action.
const paymentSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan" },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "PKR" },
    method: {
      type: String,
      enum: ["cash", "bank_transfer", "jazzcash", "easypaisa", "card", "other"],
      default: "cash",
    },
    monthsCovered: { type: Number, default: 1, min: 0 },
    date: { type: Date, default: Date.now },
    note: { type: String, default: "" },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
