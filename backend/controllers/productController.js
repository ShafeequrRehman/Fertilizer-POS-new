const Product = require("../models/Product");
const Ingredient = require("../models/Ingredient");
const { shopScope } = require("../middleware/attachShopScope");
const { escapeRegex } = require("../utils/escapeRegex");

exports.getProducts = async (req, res) => {
  const { search } = req.query;
  const query = { ...shopScope(req) };
  if (search) {
    // escapeRegex - see customerController.searchCustomers' own comment;
    // same reasoning applies to this search box.
    const safeSearch = escapeRegex(search);
    query.$or = [
      { name: { $regex: safeSearch, $options: "i" } },
      { category: { $regex: safeSearch, $options: "i" } },
      { company: { $regex: safeSearch, $options: "i" } },
    ];
  }
  // .lean() - read-only list, fetched on every POS/Sales/Record page load
  // and every Add Items panel open; same double-hydration overhead already
  // found and fixed on Order's own list endpoints (see orderController.js).
  const products = await Product.find(query).sort({ createdAt: -1 }).lean();
  // "All" is the reserved meta-option meaning "every category" - it is
  // NOT itself a real category. If any product's own category field
  // happens to literally be "All" (a stray/legacy value), including it
  // here produced a duplicate "All" pill in the POS/Sales category filter
  // (case-insensitive, since the filter buttons treat it as the same
  // option either way).
  const realCategories = new Set(
    products.map((product) => product.category).filter((category) => category && category.trim().toLowerCase() !== "all"),
  );
  const categories = ["All", ...realCategories];
  res.json({ categories, products });
};

exports.getProduct = async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, ...shopScope(req) }).lean();
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }
  res.json(product);
};

// Task 6: a brand new Product should automatically show up on the Stock
// page with 0 starting quantity, so the shop owner never has to remember
// to manually create a matching Ingredient by hand. Only creates a NEW
// Ingredient when no Ingredient of that exact same name already exists for
// this shop - if one does, it's left alone entirely (linkedIngredientId
// stays null) rather than "adopting" it, since an existing Ingredient may
// already carry real purchase history/stock that must never be at risk of
// being deleted later just because a same-named Product gets deleted (see
// deleteProduct below). This is purely a convenience side-effect - it never
// blocks/fails product creation itself if it errors for any reason.
async function autoLinkIngredientForNewProduct(product) {
  try {
    const trimmedName = String(product.name || "").trim();
    if (!trimmedName) return;
    const existing = await Ingredient.findOne({
      shopId: product.shopId,
      name: { $regex: `^${escapeRegex(trimmedName)}$`, $options: "i" },
    });
    if (existing) return;
    const ingredient = await Ingredient.create({
      shopId: product.shopId,
      name: trimmedName,
      unit: product.unit || "pcs",
      currentStock: 0,
    });
    product.linkedIngredientId = ingredient._id;
    await product.save();
  } catch (error) {
    console.error("[Product->Stock auto-link] Failed to auto-create Stock entry:", error.message);
  }
}

exports.createProduct = async (req, res) => {
  try {
    const product = await Product.create({ ...req.body, shopId: req.user.shopId });
    await autoLinkIngredientForNewProduct(product);
    res.status(201).json(product);
  } catch (error) {
    // Duplicate Product Code within this shop (see Product.js's partial
    // unique index) - give a clear message instead of a raw Mongo error.
    if (error.code === 11000 && error.keyPattern?.productCode) {
      return res.status(400).json({ error: `Product Code "${req.body.productCode}" is already in use by another product.` });
    }
    throw error;
  }
};

exports.updateProduct = async (req, res) => {
  // Never let the request body override shopId - a product can't be
  // reassigned to a different shop via this endpoint.
  const { shopId, ...updates } = req.body;
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, ...shopScope(req) },
      updates,
      { new: true }
    );
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json(product);
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.productCode) {
      return res.status(400).json({ error: `Product Code "${updates.productCode}" is already in use by another product.` });
    }
    throw error;
  }
};

// DELETE /api/products/:id - removes a single variation (or a whole
// single-variation product). There was previously no way to remove a
// product/variation at all once created; this is what backs the trash
// icon on each variation row in Manage Products.
//
// Task 6: deleting a Product from Manage Products also removes its Stock
// entry (linkedIngredientId, set at creation time by
// autoLinkIngredientForNewProduct above) - but ONLY the exact Ingredient
// this Product itself auto-created; an Ingredient the shop owner manually
// created (or one that already existed under the same name before this
// Product was added) is never touched by this, since linkedIngredientId is
// only ever set on that auto-create path. The reverse (deleting from the
// Stock page) intentionally does NOT delete the Product - see
// ingredientController.deleteIngredient.
exports.deleteProduct = async (req, res) => {
  const product = await Product.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }
  if (product.linkedIngredientId) {
    try {
      await Ingredient.findOneAndDelete({ _id: product.linkedIngredientId, shopId: product.shopId });
    } catch (error) {
      console.error("[Product->Stock auto-link] Failed to remove linked Stock entry:", error.message);
    }
  }
  res.json({ message: "Product deleted", id: req.params.id });
};
