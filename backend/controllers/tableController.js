const Table = require("../models/Table");
const Shop = require("../models/Shop");
const { shopScope } = require("../middleware/attachShopScope");

// Tables sort "naturally" (1, 2, 3, ... 10, 11) instead of lexicographically
// (1, 10, 11, ... 2) when the name is a plain number, which covers the
// default seeded set and the common case of renaming/adding more numbered
// tables. Non-numeric names (e.g. "VIP-1") sort after numeric ones, then
// alphabetically.
function sortTables(tables) {
  return tables.sort((left, right) => {
    const leftNumber = Number(left.name);
    const rightNumber = Number(right.name);
    const leftIsNumeric = left.name.trim() !== "" && !Number.isNaN(leftNumber);
    const rightIsNumeric = right.name.trim() !== "" && !Number.isNaN(rightNumber);

    if (leftIsNumeric && rightIsNumeric) return leftNumber - rightNumber;
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return left.name.localeCompare(right.name);
  });
}

// A brand new shop (or one that predates this feature) has zero Table
// documents - POSPage.tsx previously just rendered a hardcoded "1".."20"
// dropdown with no backing record at all. Seed the same 20 tables once, on
// first read, so existing shops don't need any manual setup: 1-10 as
// regular tables, 11-20 pre-marked as Family Tables. The shop person can
// then rename/retag/add/remove freely from the Management screen.
async function ensureDefaultTables(shopId) {
  const existingCount = await Table.countDocuments({ shopId });
  if (existingCount > 0) return;

  const defaults = Array.from({ length: 20 }).map((_, index) => ({
    shopId,
    name: String(index + 1),
    isFamily: index + 1 > 10,
    isActive: true,
  }));

  try {
    await Table.insertMany(defaults, { ordered: false });
  } catch (error) {
    // Ignore duplicate-key races (two concurrent first-loads) - whichever
    // request won, the tables now exist either way.
    if (error?.code !== 11000) throw error;
  }
}

exports.getTables = async (req, res) => {
  const shopId = req.user.shopId;
  await ensureDefaultTables(shopId);

  const tables = await Table.find({ ...shopScope(req) });
  res.json(sortTables(tables).map((table) => ({ ...table.toObject(), id: String(table._id) })));
};

exports.createTable = async (req, res) => {
  const name = String(req.body?.name || "").trim();

  if (!name) {
    return res.status(400).json({ error: "Table name is required" });
  }

  const existingTable = await Table.findOne({
    ...shopScope(req),
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  });
  if (existingTable) {
    return res.status(409).json({ error: "A table with this name already exists" });
  }

  const table = await Table.create({
    name,
    isFamily: Boolean(req.body?.isFamily),
    isActive: req.body?.isActive !== false,
    shopId: req.user.shopId,
  });

  res.status(201).json({ ...table.toObject(), id: String(table._id) });
};

exports.updateTable = async (req, res) => {
  const patch = {};

  if (req.body?.name !== undefined) {
    const name = String(req.body.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Table name is required" });
    }

    const existingTable = await Table.findOne({
      ...shopScope(req),
      _id: { $ne: req.params.id },
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    });

    if (existingTable) {
      return res.status(409).json({ error: "A table with this name already exists" });
    }

    patch.name = name;
  }

  if (req.body?.isFamily !== undefined) {
    patch.isFamily = Boolean(req.body.isFamily);
  }

  if (req.body?.isActive !== undefined) {
    patch.isActive = Boolean(req.body.isActive);
  }

  const table = await Table.findOneAndUpdate({ _id: req.params.id, ...shopScope(req) }, patch, { new: true });
  if (!table) {
    return res.status(404).json({ error: "Table not found" });
  }

  res.json({ ...table.toObject(), id: String(table._id) });
};

exports.deleteTable = async (req, res) => {
  const table = await Table.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!table) {
    return res.status(404).json({ error: "Table not found" });
  }

  res.status(204).send();
};

// GET /api/tables/settings - readable by any shop member (employees running
// the POS need tableTurnoverMinutes to compute the same countdown the
// backend uses to gate createOrder, see orderController.js).
exports.getTableSettings = async (req, res) => {
  const shop = await Shop.findById(req.user.shopId).select("tableTurnoverMinutes").lean();
  res.json({ tableTurnoverMinutes: shop?.tableTurnoverMinutes ?? 45 });
};

// PATCH /api/tables/settings - gated behind the settings.manage permission
// at the route level (Shop Owner always passes; an Employee needs the
// permission granted via their Role).
exports.updateTableSettings = async (req, res) => {
  const minutes = Number(req.body?.tableTurnoverMinutes);
  if (!Number.isFinite(minutes) || minutes < 1) {
    return res.status(400).json({ error: "tableTurnoverMinutes must be a number of at least 1" });
  }

  const shop = await Shop.findByIdAndUpdate(
    req.user.shopId,
    { tableTurnoverMinutes: Math.round(minutes) },
    { new: true }
  ).select("tableTurnoverMinutes");

  if (!shop) {
    return res.status(404).json({ error: "Shop not found" });
  }

  res.json({ tableTurnoverMinutes: shop.tableTurnoverMinutes });
};
