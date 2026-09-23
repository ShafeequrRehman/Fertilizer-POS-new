const mongoose = require("mongoose");

// "Labour Khata" - one singleton document per shop, same "in/out running
// balance" idea as CashRegister.js's own Cash in Hand, but tracking money
// set aside for/collected on behalf of labour separately. Fed
// automatically by Customer Dues actions made "via Labour" (see
// customerController.js's applyUpdateCustomerDues/applySettleCustomerDues -
// a Labour-method payment moves BOTH this account AND Cash in Hand, unlike
// Bank/Grain Stock which move their own balance INSTEAD of Cash in Hand),
// plus a manual add/withdraw recorded directly on the Labour Khata page.
const labourHistorySchema = new mongoose.Schema(
  {
    // "due_recovery" = a Labour-method "Pay Dues" payment came in;
    // "due_given" = a Labour-method "+ Add Dues" credit went out;
    // "adjustment" = a manual add/withdraw recorded on the Labour Khata
    // page itself, with no customer involved.
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

const labourAccountSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, unique: true, index: true },
    balance: { type: Number, default: 0 },
    history: { type: [labourHistorySchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LabourAccount", labourAccountSchema);
