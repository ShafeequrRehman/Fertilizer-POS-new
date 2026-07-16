const Waiter = require("../models/Waiter");
const { shopScope } = require("../middleware/attachShopScope");

exports.getWaiters = async (req, res) => {
  const waiters = await Waiter.find({ ...shopScope(req) }).sort({ name: 1 });
  res.json(waiters.map((waiter) => ({ ...waiter.toObject(), id: String(waiter._id) })));
};

exports.createWaiter = async (req, res) => {
  const name = String(req.body?.name || "").trim();

  if (!name) {
    return res.status(400).json({ error: "Waiter name is required" });
  }

  const existingWaiter = await Waiter.findOne({
    ...shopScope(req),
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  });
  if (existingWaiter) {
    return res.status(409).json({ error: "A waiter with this name already exists" });
  }

  const waiter = await Waiter.create({
    name,
    isActive: req.body?.isActive !== false,
    shopId: req.user.shopId,
  });

  res.status(201).json({ ...waiter.toObject(), id: String(waiter._id) });
};

exports.updateWaiter = async (req, res) => {
  const patch = {};

  if (req.body?.name !== undefined) {
    const name = String(req.body.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Waiter name is required" });
    }

    const existingWaiter = await Waiter.findOne({
      ...shopScope(req),
      _id: { $ne: req.params.id },
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    });

    if (existingWaiter) {
      return res.status(409).json({ error: "A waiter with this name already exists" });
    }

    patch.name = name;
  }

  if (req.body?.isActive !== undefined) {
    patch.isActive = Boolean(req.body.isActive);
  }

  const waiter = await Waiter.findOneAndUpdate({ _id: req.params.id, ...shopScope(req) }, patch, { new: true });
  if (!waiter) {
    return res.status(404).json({ error: "Waiter not found" });
  }

  res.json({ ...waiter.toObject(), id: String(waiter._id) });
};

exports.deleteWaiter = async (req, res) => {
  const waiter = await Waiter.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!waiter) {
    return res.status(404).json({ error: "Waiter not found" });
  }

  res.status(204).send();
};
