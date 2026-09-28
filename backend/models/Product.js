const mongoose = require("mongoose");
const { INGREDIENT_UNITS } = require("../config/ingredientUnits");

const productSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    category: { type: String, default: "General" },
    variation: { type: String, default: "" },
    image: { type: String, default: "" },
    color: { type: String, default: "bg-slate-50" },
    description: { type: String, default: "" },
    isDeal: { type: Boolean, default: false },
    dealItems: { type: [String], default: [] },
    // Product Code / SKU: an optional string the staff can type on the POS
    // screen (see POSPage.tsx's product-code entry box) to instantly add
    // this exact product/deal to the cart with no mouse interaction - a
    // physical barcode scanner "typing" its scanned value into that same
    // box and hitting Enter works identically, since a scanner is just a
    // fast keyboard. Optional and not required to be unique across every
    // product (many shops won't use it at all), but must be unique *within
    // a shop* whenever it's actually set, or the code lookup below would be
    // ambiguous about which product to add - enforced by the partial unique
    // index below (only applies to non-empty values).
    productCode: { type: String, default: "", trim: true },
    // Optional company/brand name (e.g. "Engro", "Fauji", "FFC") - lets a
    // shop selling branded goods (fertilizer, pesticide, seed, etc.) record
    // who makes a product, separately from the product's own name. Purely
    // informational - not used in any grouping/uniqueness logic.
    company: { type: String, default: "", trim: true },
    // System-recognized "service" products, seeded automatically into every
    // shop (see superAdminController.createShop / scripts/seedSpecialProducts.js)
    // rather than typed in by a shop owner - lets POSPage.tsx trigger special
    // checkout behavior (extra TID/Bill Name/Recipient Name fields, and
    // auto-settling the order's payment in full - see POSPage.tsx's
    // hasElectricityBillItem/hasCashItem) purely off this flag, instead of
    // fragile matching on the product's plain-text name (which would break
    // the moment a shop owner renamed or translated it). "" for every
    // ordinary product - the vast majority.
    specialType: { type: String, enum: ["", "electricity_bill", "cash"], default: "" },
    // How this product is counted/measured - reuses the exact same unit
    // list as Ingredient (see config/ingredientUnits.js) so a Product's
    // auto-created Stock entry (see linkedIngredientId below) is tracked in
    // the same unit the shop owner picked here. Defaults to "pcs" for a
    // typical countable item.
    unit: { type: String, enum: INGREDIENT_UNITS, default: "pcs" },
    // The Ingredient (Stock page entry) auto-created for this Product when
    // it was added (see productController.createProduct) - or, if an
    // Ingredient of the exact same name already existed at that moment,
    // left null so an existing, possibly already-stocked Ingredient is
    // never silently "adopted" and later deleted out from under the shop
    // owner (see productController.deleteProduct's own comment). Purely an
    // internal link - never edited directly from the frontend.
    linkedIngredientId: { type: mongoose.Schema.Types.ObjectId, ref: "Ingredient", default: null },
  },
  { timestamps: true }
);

// Partial unique index - only enforced for products that actually have a
// non-empty productCode, so the many products/variations that never set
// one (default "") don't collide with each other.
productSchema.index(
  { shopId: 1, productCode: 1 },
  { unique: true, partialFilterExpression: { productCode: { $type: "string", $ne: "" } } }
);

module.exports = mongoose.model("Product", productSchema);
