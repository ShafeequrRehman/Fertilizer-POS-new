const Grain = require("../models/Grain");
const User = require("../models/User");
const { shopScope } = require("../middleware/attachShopScope");

// Same pattern as bankController.currentUserName - the JWT never carries a
// display name, only id/role/shopId, so recording who made a Grain Stock
// page action needs one extra lookup.
async function currentUserName(req) {
  if (!req.user?.id) return "";
  const user = await User.findById(req.user.id).select("name username").lean();
  return user?.name || user?.username || "";
}

function serializeGrain(grain) {
  const obj = grain.toObject ? grain.toObject() : grain;
  return {
    id: String(obj._id),
    name: obj.name,
    totalKg: obj.totalKg,
    balance: obj.balance,
    createdAt: obj.createdAt,
    // Newest-first, same convention as Bank's own serializeBank.
    history: (obj.history || [])
      .map((entry) => ({
        type: entry.type,
        kg: entry.kg,
        amount: entry.amount,
        note: entry.note,
        balanceAfterKg: entry.balanceAfterKg,
        balanceAfter: entry.balanceAfter,
        relatedCustomerPhone: entry.relatedCustomerPhone || "",
        relatedCustomerName: entry.relatedCustomerName || "",
        createdBy: entry.createdBy || "",
        createdAt: entry.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  };
}

// GET /api/grains
exports.getGrains = async (req, res) => {
  try {
    const grains = await Grain.find(shopScope(req)).sort({ createdAt: 1 });
    res.json(grains.map(serializeGrain));
  } catch (error) {
    res.status(500).json({ message: "Could not load grain stock", detail: error.message });
  }
};

// POST /api/grains  body: { name, openingKg?, openingAmount?, note? }
// Adding a grain (e.g. "Rice", "Gandam") and its very first stock in one
// step, same "add my bank, add a payment" flow Bank's own createBank was
// built for. Both opening fields are optional - a grain can also be added
// completely empty, with kg/amount added afterwards via addTransaction.
exports.createGrain = async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const openingKg = Math.max(Number(req.body.openingKg) || 0, 0);
    const openingAmount = Math.max(Number(req.body.openingAmount) || 0, 0);
    const note = String(req.body.note || "").trim();
    if (!name) {
      return res.status(400).json({ message: "Grain name is required" });
    }

    const scope = shopScope(req);
    const existing = await Grain.findOne({ ...scope, name });
    if (existing) {
      return res.status(409).json({ message: "A grain with this name already exists" });
    }

    const grain = new Grain({ ...scope, name, totalKg: 0, balance: 0, history: [] });
    if (openingKg > 0 || openingAmount > 0) {
      grain.totalKg = openingKg;
      grain.balance = openingAmount;
      grain.history.push({
        type: "deposit",
        kg: openingKg,
        amount: openingAmount,
        note: note || "Opening stock",
        balanceAfterKg: grain.totalKg,
        balanceAfter: grain.balance,
        createdBy: await currentUserName(req),
      });
    }
    await grain.save();
    res.status(201).json(serializeGrain(grain));
  } catch (error) {
    res.status(500).json({ message: "Could not create grain", detail: error.message });
  }
};

// POST /api/grains/:id/transactions  body: { type: 'deposit'|'withdrawal', kg, amount, note }
// A manual movement recorded directly on the Grain Stock page - grain the
// owner put into or took out of this grain's stock themselves, with no
// customer involved. Entries that come from a customer's Add/Pay Dues
// action never go through this endpoint - see recordCustomerGrainMovement
// below, called directly from customerController.js instead.
exports.addTransaction = async (req, res) => {
  try {
    const type = req.body.type === "withdrawal" ? "withdrawal" : "deposit";
    const kg = Math.max(Number(req.body.kg) || 0, 0);
    const amount = Math.max(Number(req.body.amount) || 0, 0);
    const note = String(req.body.note || "").trim();
    if (kg <= 0 && amount <= 0) {
      return res.status(400).json({ message: "kg or amount must be greater than 0" });
    }

    const grain = await Grain.findOne({ _id: req.params.id, ...shopScope(req) });
    if (!grain) {
      return res.status(404).json({ message: "Grain not found" });
    }
    if (type === "withdrawal" && (kg > grain.totalKg || amount > grain.balance)) {
      return res
        .status(400)
        .json({ message: `Can't withdraw more than the ${grain.totalKg}kg / ₨${grain.balance} available in this grain stock` });
    }

    grain.totalKg = type === "deposit" ? grain.totalKg + kg : grain.totalKg - kg;
    grain.balance = type === "deposit" ? grain.balance + amount : grain.balance - amount;
    grain.history.push({
      type,
      kg,
      amount,
      note,
      balanceAfterKg: grain.totalKg,
      balanceAfter: grain.balance,
      createdBy: await currentUserName(req),
    });
    await grain.save();

    res.json(serializeGrain(grain));
  } catch (error) {
    res.status(500).json({ message: "Could not record transaction", detail: error.message });
  }
};

// Internal helper - NOT a route handler. Called directly from
// customerController.js's applyUpdateCustomerDues ("+ Add Dues" via Grain
// Stock) and applySettleCustomerDues ("- Pay Dues" via Grain Stock) so a
// customer payment/credit routed through grain moves that grain's own
// kg/amount and shows up in its History, tagged with which customer it was
// to/from. Silently no-ops (returns null) if the grain id doesn't resolve
// within this shop, rather than failing the whole dues action over a
// missing/invalid grain pick.
exports.recordCustomerGrainMovement = async function recordCustomerGrainMovement({
  grainId,
  shopId,
  type,
  kg,
  amount,
  note,
  customerName,
  customerPhone,
  createdBy,
}) {
  if (!grainId || !shopId || !(amount > 0 || kg > 0)) return null;
  const grain = await Grain.findOne({ _id: grainId, shopId });
  if (!grain) return null;

  grain.totalKg = type === "deposit" ? grain.totalKg + (kg || 0) : grain.totalKg - (kg || 0);
  grain.balance = type === "deposit" ? grain.balance + (amount || 0) : grain.balance - (amount || 0);
  grain.history.push({
    type,
    kg: kg || 0,
    amount: amount || 0,
    note: note || "",
    balanceAfterKg: grain.totalKg,
    balanceAfter: grain.balance,
    relatedCustomerPhone: customerPhone || "",
    relatedCustomerName: customerName || "",
    createdBy: createdBy || "",
  });
  await grain.save();
  return grain;
};

exports.serializeGrain = serializeGrain;
