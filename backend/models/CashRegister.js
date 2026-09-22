const mongoose = require("mongoose");

// "Cash in Hand" - one singleton document per shop tracking the physical
// cash actually sitting at the till, the same way Bank.js tracks money
// sitting in a named bank account. Fed automatically from two places -
// a Cash-method order payment at completion (orderController.js's
// applyOrderPatch, completeAndSettle branch) and a Cash-method "Pay Dues"
// recovery (customerController.js's settleCustomerDues) - plus a manual
// "Adjust Cash" correction from the Dashboard (cashController.adjustCash),
// since a shop owner needs a way to fix this figure by hand if a mistake
// ever throws it off (the owner's own explicit ask - every dashboard money
// figure must be editable).
const cashHistorySchema = new mongoose.Schema(
  {
    // "sale" = a Cash-method order payment came in; "due_recovery" = a
    // Cash-method Pay Dues action came in; "purchase" = cash paid out for
    // stock (kept for future use, nothing writes it yet - purchases are
    // currently recorded through IngredientPurchase.paidAmount only, with
    // no cash/bank split of their own); "adjustment" = the owner corrected
    // this figure by hand from the Dashboard.
    type: { type: String, enum: ["sale", "due_recovery", "purchase", "adjustment"], required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: "" },
    balanceAfter: { type: Number, required: true },
    relatedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    relatedCustomerName: { type: String, default: "" },
    relatedCustomerPhone: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const cashRegisterSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, unique: true, index: true },
    balance: { type: Number, default: 0 },
    history: { type: [cashHistorySchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CashRegister", cashRegisterSchema);
