const mongoose = require("mongoose");

// One entry per manual dues change (Customer Dues page's "+ Add Dues" /
// "- Pay Dues" / "Clear") - the note the cashier typed, plus enough to
// tell an "add" from a "settle" and what the running lump-sum balance was
// right after. Deliberately doesn't try to record anything about
// order-based dues here - those already have their own full history as
// Order documents (dailyOrderNumber, total, paidAmount, ...), which
// getCustomerLedger already returns per customer; the frontend's History
// dropdown (DuesPage.tsx) merges this array with that orders array at
// render time instead of duplicating order data in here.
const duesHistorySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["add", "settle"], required: true },
    amount: { type: Number, required: true },
    note: { type: String, default: "", trim: true },
    balanceAfter: { type: Number, required: true },
    createdBy: { type: String, default: "" },
    // How this entry actually moved money - "bank" means it went through
    // one of the shop's own Bank documents (see bankController.js's
    // recordCustomerBankMovement, called from customerController.js's
    // updateCustomerDues/settleCustomerDues) and bankName records which
    // one, purely for display here (DuesPage.tsx's History row) - the
    // Bank's own history is the source of truth for that side of it.
    paymentMethod: { type: String, enum: ["cash", "bank", "grain", "labour", "munshi"], default: "cash" },
    bankName: { type: String, default: "" },
    // Set only when paymentMethod is "grain" - which grain (e.g. "Rice")
    // and how many kg moved, purely for display here (DuesPage.tsx's
    // History row) - the Grain's own history is the source of truth for
    // that side of it, same relationship bankName has with Bank.js.
    grainName: { type: String, default: "" },
    grainKg: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Phone was globally unique before multi-tenancy, which is wrong once
    // multiple shops can each have a customer with the same number -
    // uniqueness is now scoped to (shopId, phone) instead. No longer
    // required - the shop owner asked to be able to add a customer with
    // no phone number at all (walk-in / word-of-mouth customer whose
    // number they don't have). Stays "" in that case; the partial unique
    // index below (same pattern as Product.js's productCode) only
    // enforces uniqueness for a customer who actually has one, so any
    // number of phone-less customers can coexist without a duplicate-key
    // error.
    phone: { type: String, default: "", trim: true },
    address: { type: String, default: "" },
    // Set from Customer Dues' "Add Customer" form (a plain checkbox,
    // default unchecked) when this contact is also someone the shop buys
    // stock FROM, not just sells to. Purely a UI marker for
    // PurchasePage.tsx's "Link to Existing Khata Contact" picker (which
    // filters to isVendor customers, see customerController.searchCustomers'
    // vendorOnly param) - it does NOT itself feed the Dashboard's Vendor
    // Balance figure, which already sums every received
    // IngredientPurchase.remainingAmount shop-wide regardless of whether
    // it's linked to a Customer at all (see reportController.js's
    // getDashboardSummary) and already correctly drops back out the
    // moment a purchase is cancelled/returned (status stops being
    // "received" - see IngredientPurchase.js's own comment on why a
    // purchase is never hard-deleted). This flag exists purely so the
    // "Link to Existing Khata Contact" search only ever offers contacts
    // the shop actually buys from, instead of every ordinary customer.
    isVendor: { type: Boolean, default: false },
    // No longer floored at 0 - "- Pay Dues" (settleCustomerDues) can now
    // push this negative, which means the CUSTOMER is in credit (they've
    // paid the shop more than they currently owe, an advance) rather than
    // the shop being owed. totalDue (previousDues + unpaid orders) simply
    // goes negative too in that case - see getCustomerLedger's own comment.
    previousDues: { type: Number, default: 0 },
    duesHistory: { type: [duesHistorySchema], default: [] },
  },
  { timestamps: true }
);

// Partial: only enforced for a customer who actually has a phone number -
// see phone's own comment above.
customerSchema.index(
  { shopId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string", $ne: "" } } }
);

module.exports = mongoose.model("Customer", customerSchema);
