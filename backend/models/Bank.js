const mongoose = require("mongoose");

// One entry per bank-account movement - either a manual deposit/withdrawal
// the owner recorded directly on the Bank page, or money that moved
// because a Customer Dues action ("+ Add Dues" / "- Pay Dues") was made
// "via Bank" instead of "via Cash" - see customerController.js's
// updateCustomerDues/settleCustomerDues, the only two places outside
// bankController that ever push one of THOSE. A customer paying us
// through this bank is a `deposit` (money came IN); us handing a customer
// money through this bank (a credit given by bank transfer) is a
// `withdrawal` (money went OUT) - the same "+ in, - out" direction a real
// bank statement would show.
const bankHistorySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["deposit", "withdrawal"], required: true },
    amount: { type: Number, required: true },
    note: { type: String, default: "", trim: true },
    balanceAfter: { type: Number, required: true },
    // Set only when this entry came from a customer's Add/Pay Dues action
    // routed through this bank - lets the Bank page's own History say
    // "Payment from Umar" / "Given to Umar" instead of a bare amount.
    relatedCustomerPhone: { type: String, default: "" },
    relatedCustomerName: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: false }
);

const bankSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    balance: { type: Number, default: 0 },
    history: { type: [bankHistorySchema], default: [] },
  },
  { timestamps: true }
);

bankSchema.index({ shopId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Bank", bankSchema);
