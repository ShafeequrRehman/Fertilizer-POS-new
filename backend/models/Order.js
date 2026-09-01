const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    variation: { type: String, default: "" },
    // Carries the product's own image reference (icon filename or a custom
    // hosted/data URL) forward onto the order line itself - without this,
    // once an order is saved we only ever have the item's plain-text name
    // to guess a photo from, which silently breaks for any product whose
    // name doesn't happen to contain an obvious food keyword. See
    // resolveProductImage() in src/lib/food-images.ts.
    image: { type: String, default: "" },
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
    // Real-time table-timer alert (Dashboard-wide popup when a Dine-In
    // table's turnover window expires while the order is still pending -
    // see TableTimerAlertWatcher.tsx). Staff can push the deadline back
    // 10 minutes at a time instead of clearing the table outright.
    timerExtendedMinutes: { type: Number, default: 0 },
    // Set true the moment staff explicitly dismiss the alert with "Clear
    // Table" - the table becomes selectable again immediately everywhere
    // (POS grid, the occupancy check below) even though this order's
    // status is still "pending"/unpaid. Distinct from actually completing
    // or cancelling the order.
    tableTimerCleared: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
