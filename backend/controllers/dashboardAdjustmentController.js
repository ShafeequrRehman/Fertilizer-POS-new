const DashboardAdjustment = require("../models/DashboardAdjustment");
const User = require("../models/User");
const { shopScope } = require("../middleware/attachShopScope");

// Same pattern as cashController/customerController/bankController's own
// copy - the JWT never carries a display name, only id/role/shopId.
async function currentUserName(req) {
  if (!req.user?.id) return "";
  const user = await User.findById(req.user.id).select("name username").lean();
  return user?.name || user?.username || "";
}

// Every Accounting Overview tile this endpoint accepts a manual correction
// for - deliberately NOT "cashInHand" (CashRegister/cashController already
// owns that one, with its own Adjust modal) or "balanceOnBank" (each Bank
// document owns its own balance/history from the Bank page) - those two
// already have a real editable home of their own, so routing them through
// here too would let the same figure drift out of sync with itself.
const ALLOWED_KEYS = new Set([
  "totalSaleToday",
  "customerUdharTotal",
  "customerAdvanceTotal",
  "stockValue",
  "vendorBalance",
  "totalPurchaseToday",
  "totalExpensesToday",
  "saleOnCash",
  "saleOnBank",
  "saleOnCredit",
  "totalRecoveryToday",
]);

async function getOrCreate(shopId, key) {
  let doc = await DashboardAdjustment.findOne({ shopId, key });
  if (!doc) {
    doc = await DashboardAdjustment.create({ shopId, key, total: 0, history: [] });
  }
  return doc;
}

// GET /api/dashboard-adjustments
// Returns { [key]: totalAdjustment } for every tile this shop has ever
// corrected - reportController.getDashboardSummary adds each one onto its
// own real computed figure before sending the Dashboard its numbers.
exports.getAllAdjustments = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const docs = await DashboardAdjustment.find({ shopId }).select("key total").lean();
    const byKey = {};
    docs.forEach((doc) => {
      byKey[doc.key] = doc.total;
    });
    res.json(byKey);
  } catch (error) {
    res.status(500).json({ message: "Could not load dashboard adjustments", detail: error.message });
  }
};

// GET /api/dashboard-adjustments/:key/history
exports.getHistory = async (req, res) => {
  try {
    const { key } = req.params;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ message: "This tile can't be corrected here." });
    }
    const { shopId } = shopScope(req);
    const doc = await getOrCreate(shopId, key);
    const history = [...doc.history].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ key, total: doc.total, history });
  } catch (error) {
    res.status(500).json({ message: "Could not load correction history", detail: error.message });
  }
};

// POST /api/dashboard-adjustments/:key/adjust  body: { amount, direction: 'in'|'out', note }
// The owner's own explicit ask - every dashboard money figure must be
// editable so a mistake can be corrected, mirroring cashController.adjustCash's
// own pattern exactly.
exports.adjust = async (req, res) => {
  try {
    const { key } = req.params;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ message: "This tile can't be corrected here." });
    }
    const amount = Math.max(Number(req.body.amount) || 0, 0);
    const direction = req.body.direction === "out" ? "out" : "in";
    const note = String(req.body.note || "").trim();
    if (amount <= 0) {
      return res.status(400).json({ message: "amount must be greater than 0" });
    }

    const { shopId } = shopScope(req);
    const doc = await getOrCreate(shopId, key);
    doc.total = direction === "in" ? doc.total + amount : doc.total - amount;
    doc.history.push({
      direction,
      amount,
      note: note || "Manual correction",
      totalAfter: doc.total,
      createdBy: await currentUserName(req),
    });
    await doc.save();
    res.json({ key, total: doc.total });
  } catch (error) {
    res.status(500).json({ message: "Could not save correction", detail: error.message });
  }
};
