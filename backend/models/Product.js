const mongoose = require("mongoose");

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
