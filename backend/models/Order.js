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

// Queue of "the kitchen needs to prepare MORE of this" line items, built up
// whenever an already-fired order's items change in a way that increases
// what's being cooked (addItems, or a replaceItems quantity increase on an
// existing line - see computeKitchenDelta/mergeKitchenDelta in
// orderController.js). Distinct from kitchenPrintedAt (a one-shot flag for
// the order's ORIGINAL ticket at creation) - this can be set, claimed, and
// set again any number of times over an order's life, which is what makes
// edits made from pos-mobile (no printer of its own) still reach the
// kitchen: DashboardShell.tsx's KitchenUpdateWatcher polls for orders with
// this non-null and prints just the queued items.
const pendingKitchenUpdateSchema = new mongoose.Schema(
  {
    items: { type: [orderItemSchema], default: [] },
    queuedAt: { type: Date, default: Date.now },
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
    pendingKitchenUpdate: { type: pendingKitchenUpdateSchema, default: null },
    // Set only for orders that were originally rung up while the shop had
    // no internet (see backend/localHub/ + orderController.importOfflineOrders).
    // dailyOrderNumber above is still the shop's real, permanent ticket
    // number, assigned at import time same as any other order -
    // offlineOrderNumber is just the temporary local ticket number staff
    // saw at the moment the order was actually placed, kept for traceability.
    createdOffline: { type: Boolean, default: false },
    offlineOrderNumber: { type: Number, default: null },
    offlineCreatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
