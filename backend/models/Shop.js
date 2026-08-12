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
  },
  { timestamps: true }
);

module.exports = mongoose.model("Shop", shopSchema);
