const mongoose = require("mongoose");

// Manual corrections for Accounting Overview tiles that have no other
// natural place to fix a mistake. Cash in Hand already has its own
// CashRegister "adjustment" entries, and Balance on Bank is corrected from
// each Bank document's own history - this model is for every OTHER tile
// the owner asked to also be editable (Total Sale Today, Customer
// Udhar/Advance, Stock Value, Vendor Balance, Total Purchase/Expenses
// Today, Sale on Cash/Bank/Credit, Total Recovery Today - see
// dashboardAdjustmentController.js's ALLOWED_KEYS for the exact list).
//
// One document per {shopId, key}. `key` is the same camelCase field name
// reportController.getDashboardSummary already returns (e.g. "stockValue",
// "vendorBalance"). `total` is a running net correction (positive or
// negative) simply ADDED on top of that metric's real computed value by
// getDashboardSummary - it never replaces or touches the underlying real
// records (orders, purchases, ledgers), so this is purely a display-level
// fix for when the owner says a figure looks wrong.
const adjustmentHistorySchema = new mongoose.Schema(
  {
    direction: { type: String, enum: ["in", "out"], required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: "" },
    totalAfter: { type: Number, required: true },
    createdBy: { type: String, default: "" },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const dashboardAdjustmentSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    key: { type: String, required: true },
    total: { type: Number, default: 0 },
    history: { type: [adjustmentHistorySchema], default: [] },
  },
  { timestamps: true }
);
dashboardAdjustmentSchema.index({ shopId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("DashboardAdjustment", dashboardAdjustmentSchema);
