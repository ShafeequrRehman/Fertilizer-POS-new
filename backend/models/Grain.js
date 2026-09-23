const mongoose = require("mongoose");

// One entry per grain-stock movement - either a manual deposit/withdrawal
// the owner recorded directly on the Grain Stock page, or grain that moved
// because a Customer Dues action ("+ Add Dues" / "- Pay Dues") was made
// "via Grain Stock" instead of "via Cash"/"via Bank" - see
// customerController.js's applyUpdateCustomerDues/applySettleCustomerDues,
// the only two places outside grainController that ever push one of
// THESE. Same "+ in, - out" direction convention as Bank.js: a customer
// paying dues in grain is a `deposit` (grain came IN, the shop is now
// holding more of it); the shop handing a customer grain as credit is a
// `withdrawal` (grain went OUT).
const grainHistorySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["deposit", "withdrawal"], required: true },
    kg: { type: Number, required: true },
    amount: { type: Number, required: true },
    note: { type: String, default: "", trim: true },
    balanceAfterKg: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    // Set only when this entry came from a customer's Add/Pay Dues action
    // routed through this grain - lets the Grain Stock page's own History
    // say "Received from Umar" / "Given to Umar" instead of a bare amount.
    relatedCustomerPhone: { type: String, default: "" },
    relatedCustomerName: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: false }
);

const grainSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Running kg on hand, same "+ in, - out" convention as `balance` below.
    totalKg: { type: Number, default: 0 },
    // Running rupee VALUE of the grain currently on hand (not a separate
    // pool of cash - this is what makes the Grain Stock page's own khata
    // behave "same as Bank", per how it was asked for).
    balance: { type: Number, default: 0 },
    history: { type: [grainHistorySchema], default: [] },
  },
  { timestamps: true }
);

grainSchema.index({ shopId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Grain", grainSchema);
