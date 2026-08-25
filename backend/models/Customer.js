const mongoose = require("mongoose");

// One entry per manual dues change (Customer Dues page's "+ Add Dues" /
// "- Pay Dues" / "Clear") - the note the cashier typed, plus enough to
// tell an "add" from a "settle" and what the running lump-sum balance was
// right after. Deliberately doesn't try to record anything about
// order-based dues here - those already have their own full history as
// Order documents (dailyOrderNumber, total, paidAmount, ...), which
// getCustomerLedger already returns per customer; the frontend's History
// dropdown (DuesPage.tsx) merges this array with that orders array at
// render time instead of duplicating order data in here.
const duesHistorySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["add", "settle"], required: true },
    amount: { type: Number, required: true },
    note: { type: String, default: "", trim: true },
    balanceAfter: { type: Number, required: true },
    createdBy: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Phone was globally unique before multi-tenancy, which is wrong once
    // multiple shops can each have a customer with the same number -
    // uniqueness is now scoped to (shopId, phone) instead.
    phone: { type: String, required: true, trim: true },
    address: { type: String, default: "" },
    previousDues: { type: Number, default: 0, min: 0 },
    duesHistory: { type: [duesHistorySchema], default: [] },
  },
  { timestamps: true }
);

customerSchema.index({ shopId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model("Customer", customerSchema);
