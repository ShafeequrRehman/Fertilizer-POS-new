const mongoose = require("mongoose");

// "Munshi Khata" - identical shape/idea to LabourAccount.js, just for the
// munshi's own running balance instead. See LabourAccount.js's own
// comment for the full reasoning; kept as a separate model/collection
// rather than a shared "kind" field, matching this codebase's existing
// convention of one dedicated model per khata (Bank, Grain, CashRegister)
// rather than a generic shared one.
const munshiHistorySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["due_recovery", "due_given", "adjustment"], required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: "" },
    balanceAfter: { type: Number, required: true },
    relatedCustomerName: { type: String, default: "" },
    relatedCustomerPhone: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const munshiAccountSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, unique: true, index: true },
    balance: { type: Number, default: 0 },
    history: { type: [munshiHistorySchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MunshiAccount", munshiAccountSchema);
