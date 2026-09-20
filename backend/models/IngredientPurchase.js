const mongoose = require("mongoose");
const { INGREDIENT_UNITS } = require("../config/ingredientUnits");

// One incoming batch of a raw ingredient (Task 1 of Purchasing/Financial
// Logic: "the Stock Manager adds new items... they must input the Purchase
// Rate, the Total Amount, how much was Paid, and how much is Remaining/
// Dues to the supplier"). Deliberately its own model rather than reusing
// the generic Purchase (models/Purchase.js, which is a loose multi-item
// order with no per-line rate/cost tracking) - every field here exists
// specifically to drive Ingredient.averageCost and a supplier's running
// due balance, neither of which the generic Purchase model was ever built
// to support.
//
// `remainingAmount` is always `totalAmount - paidAmount` (enforced in
// ingredientPurchaseController, same "server recomputes the derived
// number, never trusts the client's own arithmetic" rule
// orderController.recalculateTotals already follows for order totals).
// This document is never deleted once created (see
// ingredientPurchaseController's own comment on why) - only its paid/
// remaining amounts change, as the supplier is paid down over time.
const ingredientPurchaseSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    // Auto-generated, human-readable invoice number ("PO-000123") - see
    // ingredientPurchaseController.createPurchase, which assigns it off
    // Shop.purchaseOrderSequenceCounter. Never resets, never reused - the
    // whole point of a Purchase Order System (Task 2: "handle it exactly
    // like an invoice system") is that every batch a Stock Manager logs
    // gets its own permanent, unique reference the company/receipt can
    // both be identified by later.
    purchaseOrderNumber: { type: String, required: true },
    ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: "Ingredient", required: true, index: true },
    // Denormalized from Ingredient at the moment of purchase, same
    // reasoning as Order.items' own name/variation snapshot - if the
    // ingredient is later renamed, this historical batch record should
    // still read exactly as it did when it was actually bought.
    ingredientName: { type: String, required: true },
    unit: { type: String, enum: INGREDIENT_UNITS, required: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },
    // Unified Khata / Customer-Supplier Netting: an OPTIONAL link to a
    // Khata Customer contact, completely independent of supplierId/Supplier
    // above. A real person can be BOTH a customer (buys from the shop,
    // sometimes on credit) AND a supplier (sells stock to the shop,
    // sometimes on credit) - e.g. "Rana Tayab" - and Customer/Supplier are
    // two different collections with different identity (phone-uniqueness
    // lives on Customer, not Supplier), so this deliberately does NOT reuse
    // supplierId. Setting this is what lets customerController.getCustomerLedger
    // net this contact's sales-side dues (Customer.previousDues + their
    // Orders' remainingAmount) against their purchase-side dues (this
    // purchase's own remainingAmount) into one balance, computed fresh at
    // READ time - see that function's own comment. Never mutates
    // remainingAmount/totalAmount/paidAmount here or on the Order/Customer
    // side; this field only tells the netting query which rows belong to
    // the same real person. Stays null for the overwhelming majority of
    // purchases (a one-off supplier who has never been, and may never be,
    // a shop customer).
    linkedCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    // Free-text company/vendor name, deliberately NOT required to be a real
    // Supplier document - there is no Supplier-picker UI in the app yet
    // (models/Supplier.js exists but nothing on the frontend creates or
    // lists one), so the Stock Manager just types who they bought from.
    // ingredientPurchaseController.getCompanyLedger groups purchases by this
    // exact string to build the company-wise dues view - kept as the
    // simplest thing that satisfies "track outstanding balances per
    // company" without inventing a whole Supplier management screen.
    companyName: { type: String, default: "", trim: true },
    // Free-text specifics of the batch beyond just which Ingredient it
    // restocks (brand, packaging, grade, etc.) - shown in the Day-End
    // report's Kitchen Stock detail table alongside ingredientName.
    productDetails: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 0 },
    // Rate-Less Order Placement redesign: a Phase 1 "Pending" line is
    // created with NO rate/totalAmount at all (the manager only picks the
    // ingredient + quantity - see ingredientPurchaseController.createPurchaseOrder).
    // The actual supplier rate is only known once the delivery physically
    // arrives, so both fields default to 0 and stay optional here; they are
    // only ever populated for real by receivePurchaseOrder (Phase 2 billing
    // screen) or by the legacy single-batch createPurchase path, both of
    // which already have a real rate in hand at the moment they set these.
    rate: { type: Number, default: 0, min: 0 }, // cost per single unit (per g/ml)
    totalAmount: { type: Number, default: 0, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    remainingAmount: { type: Number, default: 0, min: 0 },
    purchaseDate: { type: Date, default: Date.now },
    // Dual-Status Stock Inventory Workflow: "pending" (Order Placed/
    // Dispatched - a Purchase Order has been raised with a supplier but
    // nothing has physically arrived yet) vs "received" (Maal Received &
    // Paid - the batch is actually in hand). This is the gate that decides
    // whether this line has been folded into Ingredient.currentStock/
    // averageCost yet - see ingredientPurchaseController.createPurchase
    // (the legacy single-batch "Log Purchase" form, which always logs
    // stock already in hand and so is always created "received" directly)
    // vs .createPurchaseOrder/.receivePurchaseOrder (the new multi-item
    // Purchase page flow, which genuinely starts "pending" and only
    // becomes "received" - with the stock/cost effect actually applied -
    // once a Stock Manager confirms physical delivery and logs payment).
    // Every purchase ever created before this field existed predates this
    // distinction entirely and was immediately stocked, so config/seed.js's
    // backfillIngredientPurchaseStatus() retroactively marks all of them
    // "received" (with receivedAt = their original purchaseDate) on first
    // boot after this change - never left as an unset/undefined status.
    status: { type: String, enum: ["pending", "received"], default: "pending", index: true },
    // Set the moment status flips to "received" - this, not purchaseDate
    // (which only ever means "when the order was placed"), is what
    // reportController.js's Day-End/Inventory reports scope their date
    // range against, since that's the date real cash/stock actually moved.
    receivedAt: { type: Date, default: null },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

ingredientPurchaseSchema.index({ shopId: 1, purchaseDate: -1 });
ingredientPurchaseSchema.index({ shopId: 1, ingredientId: 1, purchaseDate: -1 });
// Backs "which suppliers are we still into for money" without scanning
// every purchase this shop has ever logged.
ingredientPurchaseSchema.index({ shopId: 1, remainingAmount: 1 });
// getCompanyLedger groups every one of a shop's purchases by companyName -
// this is what keeps that grouping fast as purchase history grows.
ingredientPurchaseSchema.index({ shopId: 1, companyName: 1 });
// A multi-item Purchase Order shares ONE purchaseOrderNumber across several
// of these documents (one per ingredient line) - this is what
// receivePurchaseOrder groups/looks up by to flip every line of a PO to
// "received" together in one call. Deliberately not unique - "one purchase
// order, many line-item documents sharing a number" is the whole point.
ingredientPurchaseSchema.index({ shopId: 1, purchaseOrderNumber: 1 });
ingredientPurchaseSchema.index({ shopId: 1, status: 1, receivedAt: -1 });
// Unified Khata netting - customerController.getCustomerLedger's one batch
// lookup of every received purchase linked to any of a shop's customers,
// kept fast the same way the companyName index above keeps getCompanyLedger
// fast.
ingredientPurchaseSchema.index({ shopId: 1, linkedCustomerId: 1, status: 1 });

module.exports = mongoose.model("IngredientPurchase", ingredientPurchaseSchema);
