const mongoose = require("mongoose");

// A Shop is a single tenant. Every other business-data collection
// (Product, Customer, Order/Invoice, Waiter, Supplier, Purchase, Expense,
// Role, and the shop's own employee Users) carries a `shopId` that points
// back to this document, and every query in the app must be scoped by it -
// see backend/middleware/attachShopScope.js and requireShopScope usage in
// each controller.
const shopSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
      index: true,
    },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan" },
    licenseId: { type: mongoose.Schema.Types.ObjectId, ref: "License" },
    notes: { type: String, default: "" },
    // Bcrypt hash of the shop's "Cancel Order Key" - a secret set by the
    // Super Admin (same moment/place as the owner username/password, or
    // later via "Set Cancel Order Key") and given to the Shop Owner out of
    // band. Never stored or transmitted in plaintext after creation, and
    // never hardcoded anywhere in the app - see
    // backend/controllers/orderController.js exports.cancelOrder, which is
    // the only place it's ever compared against.
    cancelOrderKeyHash: { type: String, default: "" },
    // Estimated combined preparation + dining duration (minutes) used to
    // drive the Dine-In table availability countdown (see
    // tableController.js's getTableSettings/updateTableSettings and
    // orderController.js's isTableCurrentlyLocked). A table is treated as
    // occupied/un-selectable from the moment a DineIn order is placed on
    // it until this many minutes have passed - and always re-opens at that
    // point even if the order still hasn't been paid, by design (see
    // Technical Requirement #4 - the timer itself IS the grace period).
    tableTurnoverMinutes: { type: Number, default: 45, min: 1 },
    // Bcrypt hash of the shop's "Page Visibility Key" - same pattern as
    // cancelOrderKeyHash above: set by the Super Admin (via "Set Page
    // Visibility Key" on the Shops page) and given to the Shop Owner out
    // of band. It is NOT the Shop Owner's login password - it's a separate
    // secret that unlocks the ability to edit enabledPages below from
    // their own Settings page (see shopOwnerController.exports.
    // updateEnabledPages, the only place it's ever compared against).
    pageVisibilityKeyHash: { type: String, default: "" },
    // Which sidebar pages this shop's dashboard shows (see
    // src/lib/dashboard-pages.ts for the full key list, and
    // DashboardShell.tsx's isPageEnabled filter, which is where this
    // actually gets enforced). The SHOP OWNER controls this from their own
    // Settings page - not the Super Admin - gated behind
    // pageVisibilityKeyHash above. null/undefined (the default, and every
    // shop before this field existed) means "no restriction - show every
    // page the user's own permissions already allow"; only once the Shop
    // Owner has entered their key and saved a selection does this become a
    // concrete array. This only hides pages from the sidebar; it is not a
    // backend access-control boundary.
    enabledPages: { type: [String], default: null },
    // Permanent, all-time order counter for this shop - printed on receipts
    // as "Tr#" (see models/Order.js's shopSequenceNumber). Deliberately
    // lives here rather than on ShopSession (whose own orderCounter resets
    // every shift by design) since the whole point is that this one never
    // resets, ever. Atomically incremented via $inc in
    // orderController.createOrder/importOfflineOrders, same pattern as
    // ShopSession.orderCounter.
    orderSequenceCounter: { type: Number, default: 0 },
    // Permanent, all-time counter backing each IngredientPurchase's
    // human-readable Purchase Order Number ("PO-000123" - see
    // ingredientPurchaseController.createPurchase) - same never-resets,
    // atomically-$inc'd pattern as orderSequenceCounter above, just a
    // completely separate counter since a purchase order and a sales
    // order are never the same sequence.
    purchaseOrderSequenceCounter: { type: Number, default: 0 },
    // A shop's own custom table labels for DineIn seating (e.g. ["M1"..
    // "M8", "FM1".."FM8", "OUT1".."OUT8"] for a shop with Male/Family/
    // Outdoor sections), in the exact order they should be offered/shown.
    // Empty (the default, and every shop before this field existed) means
    // "no custom layout" - POSPage.tsx's Table Number dropdown and
    // SalesPage.tsx's Change Table grid both fall back to the original
    // plain "Table 1".."Table 20" numbering in that case (see
    // src/lib/table-options.ts), so this is purely additive - no shop's
    // existing behavior changes unless this is explicitly set for them.
    tables: { type: [String], default: [] },
    // WhatsApp number(s) that get notified (via the shop's own WhatsApp
    // session - see whatsappService.js) the moment a Delivery order placed
    // through the customer QR page is confirmed - see
    // orderController.notifyRiderForDelivery. Plain array so a shop can
    // notify more than one rider at once; empty means "no rider configured
    // yet", in which case the notification is silently skipped rather than
    // failing the confirm action.
    riderPhones: { type: [String], default: [] },
    // JazzCash/EasyPaisa MERCHANT credentials for THIS shop specifically -
    // every shop is its own merchant, so these can never be shared/global.
    // All blank by default; the online-payment step on CustomerOrderPage.tsx
    // simply doesn't offer a gateway that has no credentials configured yet
    // (see publicOrderController.getMenu's isPaymentGatewayConfigured
    // flags) and falls back to "pay by hand" instead - see
    // paymentGatewayService.js for where these are actually used, and
    // SettingsPage.tsx's Customer Ordering section for where the Shop
    // Owner enters them. Never returned to the public (unauthenticated)
    // customer-facing endpoints - only ever read server-side.
    paymentGateway: {
      jazzCash: {
        merchantId: { type: String, default: "" },
        password: { type: String, default: "" },
        integritySalt: { type: String, default: "" },
        environment: { type: String, enum: ["sandbox", "live"], default: "sandbox" },
      },
      easyPaisa: {
        storeId: { type: String, default: "" },
        hashKey: { type: String, default: "" },
        environment: { type: String, enum: ["sandbox", "live"], default: "sandbox" },
      },
    },
    // Whether to automatically print the customer receipt the instant an
    // order is completed & settled - per order type, since a shop may want
    // this for Dine-In/Takeaway (handed to the customer at the counter) but
    // not Delivery (no one to hand a paper receipt to until the rider picks
    // up), or any other combination. Purely a policy flag read by
    // SalesPage.tsx's completeOrder - the backend itself never prints
    // anything (that's always a client/device action against a real
    // thermal printer). All default false, matching the prior behavior
    // (auto-print-on-completion was removed entirely) until a Shop Owner
    // explicitly opts a type back in from Settings.
    receiptAutoPrint: {
      dineIn: { type: Boolean, default: false },
      takeAway: { type: Boolean, default: false },
      delivery: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Shop", shopSchema);
