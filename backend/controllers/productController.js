const Product = require("../models/Product");
const { shopScope } = require("../middleware/attachShopScope");

exports.getProducts = async (req, res) => {
  const { search } = req.query;
  const query = { ...shopScope(req) };
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { category: { $regex: search, $options: "i" } },
    ];
  }
  const products = await Product.find(query).sort({ createdAt: -1 });
  const categories = ["All", ...new Set(products.map((product) => product.category))];
  res.json({ categories, products });
};

exports.getProduct = async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, ...shopScope(req) });
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }
  res.json(product);
};

exports.createProduct = async (req, res) => {
  const product = await Product.create({ ...req.body, shopId: req.user.shopId });
  res.status(201).json(product);
};

exports.updateProduct = async (req, res) => {
  // Never let the request body override shopId - a product can't be
  // reassigned to a different shop via this endpoint.
  const { shopId, ...updates } = req.body;
  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, ...shopScope(req) },
    updates,
    { new: true }
  );
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }
  res.json(product);
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
