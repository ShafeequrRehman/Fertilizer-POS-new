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
    // Set the moment a kitchen ticket is actually printed for this order -
    // by whichever till claims it first (see PATCH /orders/:id/claim-kitchen-print
    // in orderController.js). Lets any number of open tills for the same
    // shop poll for "orders nobody has printed yet" without double-printing
    // the same order, regardless of whether it was placed on that till's
    // own POS screen or on a cashier's phone via pos-mobile.
    kitchenPrintedAt: { type: Date, default: null },
    // Same claim pattern as kitchenPrintedAt, but for the CUSTOMER-facing
    // receipt on TakeAway orders specifically. TakeAway customers pay and
    // collect their food right away, so their receipt (with the order
    // number) prints immediately when the order is placed instead of
    // waiting for the Sales page's "Complete Payment" step like DineIn/
    // Delivery orders do - see claimReceiptPrint below and SalesPage.tsx's
    // saveUpdate, which skips the completion-time auto-print once this is
    // already set so the customer never gets two copies.
    customerReceiptPrintedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
