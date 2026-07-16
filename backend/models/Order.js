const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    variation: { type: String, default: "" },
  },
  { _id: false }
);

const discountSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["value", "percent"] },
    value: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    userId: { type: String, default: "", index: true },
    clientSyncId: { type: String, default: "", index: true },
    items: { type: [orderItemSchema], default: [] },
    dailyOrderNumber: { type: Number, default: 1 },
    subtotal: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    orderType: { type: String, enum: ["DineIn", "TakeAway", "Delivery"], required: true },
    customer: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      address: { type: String, default: "" },
    },
    address: { type: String, default: "" },
    note: { type: String, default: "" },
    waiter: { type: String, default: "" },
    table: { type: String, default: "" },
    status: { type: String, enum: ["pending", "completed", "cancelled", "paid"], default: "pending" },
    paymentMethod: { type: String, enum: ["Cash", "Card", "E-Wallet"], default: "Cash" },
    paidAmount: { type: Number, default: 0 },
    remainingAmount: { type: Number, default: 0 },
    cancelledAt: { type: String, default: "" },
    cancelledBy: { type: String, default: "" },
    cancelReason: { type: String, default: "" },
    discount: { type: discountSchema, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
