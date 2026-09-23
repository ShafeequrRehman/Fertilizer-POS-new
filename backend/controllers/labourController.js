const LabourAccount = require("../models/LabourAccount");
const User = require("../models/User");
const { shopScope } = require("../middleware/attachShopScope");

// Same pattern as cashController.currentUserName - the JWT never carries a
// display name, only id/role/shopId.
async function currentUserName(req) {
  if (!req.user?.id) return "";
  const user = await User.findById(req.user.id).select("name username").lean();
  return user?.name || user?.username || "";
}

async function getOrCreateAccount(shopId) {
  let account = await LabourAccount.findOne({ shopId });
  if (!account) {
    account = await LabourAccount.create({ shopId, balance: 0, history: [] });
  }
  return account;
}

function serializeAccount(account) {
  const obj = account.toObject ? account.toObject() : account;
  return {
    balance: obj.balance || 0,
    // Newest-first, same convention as Bank/Cash history rendering.
    history: (obj.history || [])
      .map((entry) => ({
        type: entry.type,
        direction: entry.direction,
        amount: entry.amount,
        note: entry.note || "",
        balanceAfter: entry.balanceAfter,
        relatedCustomerName: entry.relatedCustomerName || "",
        relatedCustomerPhone: entry.relatedCustomerPhone || "",
        createdBy: entry.createdBy || "",
        createdAt: entry.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  };
}

// GET /api/labour
exports.getLabourSummary = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const account = await getOrCreateAccount(shopId);
    res.json(serializeAccount(account));
  } catch (error) {
    res.status(500).json({ message: "Could not load Labour Khata", detail: error.message });
  }
};

// POST /api/labour/adjust  body: { amount, direction: 'in'|'out', note }
// A manual movement recorded directly on the Labour Khata page - e.g.
// actually paying a labourer their wages out of this khata, with no
// customer involved. Entries that come from a Customer Dues action never
// go through this endpoint - see recordCustomerLabourMovement below,
// called directly from customerController.js instead.
exports.adjustLabour = async (req, res) => {
  try {
    const amount = Math.max(Number(req.body.amount) || 0, 0);
    const direction = req.body.direction === "out" ? "out" : "in";
    const note = String(req.body.note || "").trim();
    if (amount <= 0) {
      return res.status(400).json({ message: "amount must be greater than 0" });
    }

    const { shopId } = shopScope(req);
    const account = await getOrCreateAccount(shopId);
    account.balance = direction === "in" ? account.balance + amount : account.balance - amount;
    account.history.push({
      type: "adjustment",
      direction,
      amount,
      note: note || "Manual entry",
      balanceAfter: account.balance,
      createdBy: await currentUserName(req),
    });
    await account.save();
    res.json(serializeAccount(account));
  } catch (error) {
    res.status(500).json({ message: "Could not update Labour Khata", detail: error.message });
  }
};

// Internal helper - NOT a route handler. Called directly from
// customerController.js's applyUpdateCustomerDues ("+ Add Dues" via
// Labour) and applySettleCustomerDues ("- Pay Dues" via Labour) - a
// Labour-method dues action moves BOTH this account's own balance AND
// Cash in Hand (see customerController.js's own comment on why Labour/
// Munshi are additive tracking on top of cash, unlike Bank/Grain Stock
// which move their own balance INSTEAD of Cash in Hand). Never throws
// over a missing shopId/non-positive amount - fire-and-forget bookkeeping,
// same convention as cashController.recordCashMovement.
exports.recordCustomerLabourMovement = async function recordCustomerLabourMovement({
  shopId,
  type,
  direction,
  amount,
  note,
  customerName,
  customerPhone,
  createdBy,
}) {
  if (!shopId || !(amount > 0)) return null;
  const account = await getOrCreateAccount(shopId);
  account.balance = direction === "in" ? account.balance + amount : account.balance - amount;
  account.history.push({
    type,
    direction,
    amount,
    note: note || "",
    balanceAfter: account.balance,
    relatedCustomerName: customerName || "",
    relatedCustomerPhone: customerPhone || "",
    createdBy: createdBy || "",
  });
  await account.save();
  return account;
};

exports.getOrCreateAccount = getOrCreateAccount;
exports.serializeAccount = serializeAccount;
