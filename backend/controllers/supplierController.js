const Supplier = require("../models/Supplier");
const { shopScope } = require("../middleware/attachShopScope");

exports.getSuppliers = async (req, res) => {
  const suppliers = await Supplier.find({ ...shopScope(req) }).sort({ name: 1 }).lean();
  res.json(suppliers);
};

exports.getSupplier = async (req, res) => {
  const supplier = await Supplier.findOne({ _id: req.params.id, ...shopScope(req) });
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });
  res.json(supplier);
};

exports.createSupplier = async (req, res) => {
  const { shopId, ...body } = req.body;
  const supplier = await Supplier.create({ ...body, shopId: req.user.shopId });
  res.status(201).json(supplier);
};

exports.updateSupplier = async (req, res) => {
  const { shopId, ...updates } = req.body;
  const supplier = await Supplier.findOneAndUpdate({ _id: req.params.id, ...shopScope(req) }, updates, { new: true });
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });
  res.json(supplier);
};

exports.deleteSupplier = async (req, res) => {
  const supplier = await Supplier.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });
  res.status(204).send();
};
