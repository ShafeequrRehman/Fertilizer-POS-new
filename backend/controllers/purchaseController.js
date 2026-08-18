const Purchase = require("../models/Purchase");
const { shopScope } = require("../middleware/attachShopScope");

exports.getPurchases = async (req, res) => {
  // .lean() - read-only list (Purchase page), same reasoning as
  // productController.getProducts.
  const purchases = await Purchase.find({ ...shopScope(req) }).sort({ purchaseDate: -1 }).populate("supplierId", "name phone").lean();
  res.json(purchases);
};

exports.getPurchase = async (req, res) => {
  const purchase = await Purchase.findOne({ _id: req.params.id, ...shopScope(req) }).populate("supplierId", "name phone");
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });
  res.json(purchase);
};

exports.createPurchase = async (req, res) => {
  const { shopId, ...body } = req.body;
  const items = Array.isArray(body.items) ? body.items : [];
  const total = typeof body.total === "number" ? body.total : items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);

  const purchase = await Purchase.create({
    ...body,
    items,
    total,
    shopId: req.user.shopId,
    createdBy: req.user.id,
  });
  res.status(201).json(purchase);
};

exports.updatePurchase = async (req, res) => {
  const { shopId, createdBy, ...updates } = req.body;
  if (Array.isArray(updates.items) && updates.total === undefined) {
    updates.total = updates.items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  }
  const purchase = await Purchase.findOneAndUpdate({ _id: req.params.id, ...shopScope(req) }, updates, { new: true });
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });
  res.json(purchase);
};

exports.deletePurchase = async (req, res) => {
  const purchase = await Purchase.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });
  res.status(204).send();
};
