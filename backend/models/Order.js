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
    // Carries the product's own Product.specialType forward onto the order
    // line itself, same reasoning as `image` above - "electricity_bill" /
    // "cash" for the two system-seeded service products, "" for everything
    // else. POSPage.tsx reads this off the CART item (not a fresh product
    // lookup) to decide whether to show the Bill/Cash-specific fields and
    // auto-settle the order below.
    specialType: { type: String, default: "" },
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

// One entry of what services/stockService.js's deductStockForItems actually
// took off an ingredient's shelf for this order - see orderSchema's
// stockDeductions field below for the full reasoning.
const stockDeductionSchema = new mongoose.Schema(
  {
    ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: "Ingredient", required: true },
    quantity: { type: Number, required: true, min: 0 },
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

// A customer-qr order's own request to add/remove items after it's
// already been placed (see publicOrderController.requestOrderChange /
// orderController.respondToChangeRequest) - never applied automatically.
// It just sits here as "pending" until staff/the shop owner explicitly
// approves or rejects it from the Sales dashboard (SalesPage.tsx's
// OnlineOrderControls). Only one request can be pending at a time - the
// customer has to wait for a response before submitting another.
// addItems is priced at REQUEST time (never trust a re-submitted price,
// but also don't let the catalog changing between request and approval
// silently change what the customer agreed to - same principle as
// publicOrderController.createOrder's own re-pricing). removeItems is
// just name/variation/quantity - matched back against the real
// order.items at approval time, since that's the only thing that could
// have changed between request and approval on the removal side.
const customerChangeRequestSchema = new mongoose.Schema(
  {
    addItems: { type: [orderItemSchema], default: [] },
    removeItems: {
      type: [
        {
          name: { type: String, required: true },
          variation: { type: String, default: "" },
          quantity: { type: Number, required: true, min: 1 },
        },
      ],
      default: [],
    },
    note: { type: String, default: "" },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    requestedAt: { type: Date, default: Date.now },
    respondedAt: { type: Date, default: null },
    respondedBy: { type: String, default: "" },
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
    // Permanent, shop-lifetime running count - printed on receipts as
    // "Tr#" (see ItemizedBillReceipt.tsx/KitchenKotReceipt.tsx and their
    // main.js react-pdf counterparts). Unlike dailyOrderNumber above (which
    // resets to 1 every time the shop opens a new session/shift),
    // shopSequenceNumber NEVER resets - it starts at 1 on this shop's very
    // first order ever and keeps counting up for the life of the shop, so
    // it doubles as a true all-time order count. Allocated from
    // Shop.orderSequenceCounter - see orderController.js's createOrder/
    // importOfflineOrders for the same requested-number-first-else-$inc
    // pattern already used for dailyOrderNumber (honoring a number the
    // till's Local Hub already reserved and printed offline, instead of
    // blindly reassigning one at sync time). null on orders created before
    // this field existed - never backfilled.
    shopSequenceNumber: { type: Number, default: null },
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
    // Quick Delivery Charges preset (POSPage.tsx's Free/30/50/Custom row) -
    // only ever meaningful for orderType "Delivery", folded straight into
    // `total` by recalculateTotals (orderController.js) alongside
    // subtotal/discount, same single-source-of-truth pattern as discount
    // itself. Stays 0 for every non-Delivery order.
    deliveryFee: { type: Number, default: 0, min: 0 },
    note: { type: String, default: "" },
    waiter: { type: String, default: "" },
    table: { type: String, default: "" },
    // Electricity Bill / Cash special-product order details (see
    // orderItemSchema's own `specialType` above and POSPage.tsx's
    // hasElectricityBillItem/hasCashItem) - typed by the cashier at
    // checkout, right alongside note/waiter. billTid/billName only ever get
    // filled in for an order whose cart included the "Electricity Bill"
    // product; cashRecipientName only for one that included "Cash". All
    // three stay "" for every ordinary order.
    billTid: { type: String, default: "" },
    billName: { type: String, default: "" },
    cashRecipientName: { type: String, default: "" },
    status: { type: String, enum: ["pending", "completed", "cancelled", "paid"], default: "pending" },
    paymentMethod: { type: String, enum: ["Cash", "Card", "E-Wallet"], default: "Cash" },
    paidAmount: { type: Number, default: 0 },
    remainingAmount: { type: Number, default: 0 },
    // Change-Return Calculation: the raw cash amount the customer actually
    // handed over at checkout - independent of paidAmount above, which is
    // always clamped to however much of this bill (plus any other dues)
    // it actually settles. Only meaningful for a Cash payment where the
    // customer tendered more than the bill (e.g. bill is 1600, customer
    // hands over 2000) - see orderController.js's completeAndSettle branch
    // (which sets this) and the receipt template (which prints "CASH
    // TENDERED"/"CHANGE RETURNED" from it). Stays 0 for a payment where
    // nothing extra was tendered.
    cashReceived: { type: Number, default: 0 },
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
    // "staff" (the default, and every order before this field existed) for
    // anything rung up from the till/POSPage.tsx/pos-mobile as normal -
    // "customer-qr" only for an order placed by a customer themselves via
    // the public QR ordering page (see publicOrderController.js). Purely
    // informational.
    source: { type: String, enum: ["staff", "customer-qr"], default: "staff" },
    // Customer-facing order-tracking lifecycle for a customer-qr order -
    // deliberately SEPARATE from `status` above (pending/completed/
    // cancelled/paid), which drives kitchen printing, payment/dues, and
    // every staff-facing page in the app and must never change meaning.
    // trackingStatus is purely additional: it's what CustomerOrderPage.tsx
    // polls to show the customer "Preparing your order..." etc, and what
    // staff move forward from the dashboard (see orderController.js's
    // updateTrackingStatus). "awaiting_confirmation" (the default) means a
    // customer placed it but no one has accepted it into the kitchen queue
    // yet - staff/admin explicitly (or a verified online payment
    // automatically) moves it to "confirmed", then "preparing", then
    // "ready" (TakeAway/Delivery pickup-ready) or straight to a normal
    // completed status for DineIn. "cancelled" here also flips the real
    // `status` field to "cancelled" at the same time (see
    // updateTrackingStatus) so it disappears from active order lists the
    // same way any other cancelled order does.
    trackingStatus: {
      type: String,
      enum: ["awaiting_confirmation", "confirmed", "preparing", "ready", "cancelled"],
      default: "awaiting_confirmation",
    },
    // Independent of paidAmount/remainingAmount above (which track a
    // staff-collected cash/card tender at the counter) - this tracks an
    // ONLINE payment made through JazzCash/EasyPaisa on a customer-qr
    // order specifically. "awaiting_confirmation" while the customer is on
    // the gateway's page; "paid" once the gateway's callback/webhook is
    // verified (see paymentGatewayService.js) - that's also the trigger
    // that auto-advances trackingStatus to "confirmed" without staff
    // having to do anything. Cash/E-Wallet-by-hand orders never touch this
    // field - it stays "unpaid" and confirmation is manual, same as before.
    paymentStatus: { type: String, enum: ["unpaid", "awaiting_confirmation", "paid", "failed"], default: "unpaid" },
    paymentGateway: {
      provider: { type: String, enum: ["", "JazzCash", "EasyPaisa"], default: "" },
      txnRefNo: { type: String, default: "" },
      transactionId: { type: String, default: "" },
      raw: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    // Captured once, at order-placement time, from the customer's own
    // phone (navigator.geolocation) for a Delivery order - never updated
    // afterwards (this is not live rider tracking, just "where were they
    // standing when they ordered", which is what the WhatsApp rider
    // notification's Google Maps link is built from - see
    // orderController.js's notifyRiderForDelivery). null for every
    // non-Delivery order and for any Delivery order placed before this
    // field existed or from a browser that declined location access.
    deliveryLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      capturedAt: { type: Date, default: null },
    },
    // Which staff member (a User with designation "Delivery Rider" - see
    // waiterController.getRiders) this Delivery order was handed to, set
    // by orderController.assignRider. A snapshot of {id,name,phone} rather
    // than just a User ref, same reasoning as `waiter` above (String, not
    // a ref) - if that staff member is later renamed/removed, this order's
    // own record of who delivered it should stay exactly as it was.
    assignedRider: {
      id: { type: String, default: "" },
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      assignedAt: { type: Date, default: null },
    },
    customerChangeRequest: { type: customerChangeRequestSchema, default: null },
    // Snapshot of exactly what services/stockService.js's
    // deductStockForItems took off the shelf for THIS order's line items at
    // creation time (Recipe Management/Stock Management: Task 3's
    // real-time deduction) - not the recipe's theoretical amounts, but what
    // was actually available and removed (see that function's own comment
    // on why). orderController.js's cancelOrderCore reads this back to
    // restore the exact same amounts if the order is later cancelled,
    // deliberately never recomputing against whatever the recipe looks
    // like at cancellation time, which may have changed since. Empty for
    // every order with no matching recipe, and for every order placed
    // before this field existed.
    stockDeductions: { type: [stockDeductionSchema], default: [] },
    // Task 2 (Purchasing/Financial Logic): the real-time ingredient cost of
    // this order's items, computed once at creation by
    // services/stockService.js's deductStockForItems using each
    // ingredient's averageCost AT THAT MOMENT (see Ingredient.js's own
    // comment on how that average moves) - a frozen snapshot, exactly like
    // stockDeductions above, never recomputed later even if an ingredient's
    // average cost subsequently changes. grossProfit is simply
    // `total - costPrice`, stored rather than computed on read so the
    // Day-End Profit report (reportController.getDayEndReport) can sum it
    // directly with a single aggregation instead of re-deriving it per
    // order. Both default to 0 - an order with no matching recipe (or
    // placed before this feature existed) legitimately has no known cost.
    costPrice: { type: Number, default: 0 },
    grossProfit: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// getOrders (see orderController.js) always filters by shopId and sorts
// by createdAt descending - the single-field shopId index above narrows
// to this shop's documents fine, but MongoDB still has to sort the result
// in memory without a compound index covering both, which gets
// noticeably slower as a shop's order history grows. This is what that
// query actually uses on every Dashboard/Sales/Kitchen page load.
orderSchema.index({ shopId: 1, createdAt: -1 });

// SalesPage.tsx's refresh() (and RecordPage/POSPage's own equivalents) also
// run a SECOND, deliberately unbounded query - `status=pending`, no date
// filter at all - to catch an old still-open DineIn table or Delivery that
// would otherwise silently vanish once it aged out of the 14-day window the
// index above was built for (see getOrders' own comment on why that has to
// stay unbounded). Without status in the index, that query can only use
// {shopId,createdAt} to narrow to this shop's documents and then has to
// scan every one of them - fine for a new shop, but exactly what was still
// timing out Sales/Record/POS on a shop with thousands of lifetime orders
// even after the fix above. This lets MongoDB jump straight to just this
// shop's pending documents instead.
orderSchema.index({ shopId: 1, status: 1, createdAt: -1 });

// DashboardShell.tsx's KitchenPrintWatcher and KitchenUpdateWatcher poll
// getUnprintedKitchenOrders/getUnprintedKitchenUpdateOrders every 1.5
// SECONDS, continuously, on every open till - by far the most frequent
// queries in the whole app, more than an order of magnitude more often
// than any page-load fetch. Both filter on kitchenPrintedAt/
// pendingKitchenUpdate, and until now NEITHER was covered by an index -
// same missing-index problem as getOrders' own two indexes above, just
// undiscovered until now because the filtered RESULT is always small
// (kitchenPrintedAt only ever goes null -> a real date once, never back;
// pendingKitchenUpdate is a short-lived queue), which hid the real cost:
// finding that small result still means scanning every one of this shop's
// orders without an index, and that scan cost grows with the shop's total
// order count. Run every 1.5s against a shop with a growing order history,
// this alone can add up to a real, compounding slowdown over the course of
// a shift even though no single poll looks slow in isolation - this is the
// most likely explanation for "the app gets slower as today's order count
// grows," felt on every page since DashboardShell (and therefore these
// watchers) wraps the whole dashboard, not just one page.
orderSchema.index({ shopId: 1, kitchenPrintedAt: 1, createdAt: 1 });
orderSchema.index({ shopId: 1, "pendingKitchenUpdate.queuedAt": 1 });

// customerController.js's getCustomerOutstanding (called by SalesPage.tsx's
// loadDue effect every time a cashier selects an order that has a customer
// phone number - a very frequent, real-time interaction, not a periodic
// poll) filters by {shopId, "customer.phone"} - as do settleCustomerDues and
// the completeAndSettle dues cascade in orderController.js. None of those
// were covered by an index, same missing-index problem as the two indexes
// above: the matched result is small (one customer's orders), but finding
// it still meant scanning every order this shop has ever had, and that
// scan cost grows with the shop's total order history - felt as "selecting
// an order with a phone number feels slower over time."
orderSchema.index({ shopId: 1, "customer.phone": 1 });

module.exports = mongoose.model("Order", orderSchema);
