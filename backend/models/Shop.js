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
  },
  { timestamps: true }
);

module.exports = mongoose.model("Shop", shopSchema);
