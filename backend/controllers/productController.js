const Product = require("../models/Product");
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

exports.createProduct = async (req, res) => {
  try {
    const product = await Product.create({ ...req.body, shopId: req.user.shopId });
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
exports.deleteProduct = async (req, res) => {
  const product = await Product.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }
  res.json({ message: "Product deleted", id: req.params.id });
};
