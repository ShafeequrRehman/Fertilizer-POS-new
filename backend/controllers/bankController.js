const Bank = require("../models/Bank");
const User = require("../models/User");
const { shopScope } = require("../middleware/attachShopScope");

// Same pattern as customerController.currentUserName - the JWT never
// carries a display name, only id/role/shopId, so recording who made a
// bank-page action needs one extra lookup.
async function currentUserName(req) {
  if (!req.user?.id) return "";
  const user = await User.findById(req.user.id).select("name username").lean();
  return user?.name || user?.username || "";
}

function serializeBank(bank) {
  const obj = bank.toObject ? bank.toObject() : bank;
  return {
    id: String(obj._id),
    name: obj.name,
    balance: obj.balance,
    createdAt: obj.createdAt,
    // Newest-first, same convention as Customer.duesHistory rendering on
    // DuesPage.tsx - a bank's history can get long, and whoever opens this
    // page cares about the latest movement first.
    history: (obj.history || [])
      .map((entry) => ({
        type: entry.type,
        amount: entry.amount,
        note: entry.note,
        balanceAfter: entry.balanceAfter,
        relatedCustomerPhone: entry.relatedCustomerPhone || "",
        relatedCustomerName: entry.relatedCustomerName || "",
        createdBy: entry.createdBy || "",
        createdAt: entry.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  };
}

// GET /api/banks
exports.getBanks = async (req, res) => {
  try {
    const banks = await Bank.find(shopScope(req)).sort({ createdAt: 1 });
    res.json(banks.map(serializeBank));
  } catch (error) {
    res.status(500).json({ message: "Could not load banks", detail: error.message });
  }
};

// POST /api/banks  body: { name, openingBalance?, note? }
// Adding a bank and its very first payment in one step - exactly the
// "go to the Bank page, add my bank, add a payment" flow this was built
// for (e.g. "MCB Bank" with an opening amount of 300000). openingBalance
// is optional - a bank can also be added with nothing in it yet, with
// money added afterwards via addTransaction below.
exports.createBank = async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const openingBalance = Math.max(Number(req.body.openingBalance) || 0, 0);
    const note = String(req.body.note || "").trim();
    if (!name) {
      return res.status(400).json({ message: "Bank name is required" });
    }

    const scope = shopScope(req);
    const existing = await Bank.findOne({ ...scope, name });
    if (existing) {
      return res.status(409).json({ message: "A bank with this name already exists" });
    }

    const bank = new Bank({ ...scope, name, balance: 0, history: [] });
    if (openingBalance > 0) {
      bank.balance = openingBalance;
      bank.history.push({
        type: "deposit",
        amount: openingBalance,
        note: note || "Opening balance",
        balanceAfter: bank.balance,
        createdBy: await currentUserName(req),
      });
    }
    await bank.save();
    res.status(201).json(serializeBank(bank));
  } catch (error) {
    res.status(500).json({ message: "Could not create bank", detail: error.message });
  }
};

// POST /api/banks/:id/transactions  body: { type: 'deposit'|'withdrawal', amount, note }
// A manual movement recorded directly on the Bank page - money the owner
// put into this bank or took out of it themselves, with no customer
// involved. Entries that come from a customer's Add/Pay Dues action never
// go through this endpoint - see recordCustomerBankMovement below, called
// directly from customerController.js instead.
exports.addTransaction = async (req, res) => {
  try {
    const type = req.body.type === "withdrawal" ? "withdrawal" : "deposit";
    const amount = Math.max(Number(req.body.amount) || 0, 0);
    const note = String(req.body.note || "").trim();
    if (amount <= 0) {
      return res.status(400).json({ message: "amount must be greater than 0" });
    }

    const bank = await Bank.findOne({ _id: req.params.id, ...shopScope(req) });
    if (!bank) {
      return res.status(404).json({ message: "Bank not found" });
    }
    if (type === "withdrawal" && amount > bank.balance) {
      return res.status(400).json({ message: `Can't withdraw more than the ₨${bank.balance} available in this bank` });
    }

    bank.balance = type === "deposit" ? bank.balance + amount : bank.balance - amount;
    bank.history.push({ type, amount, note, balanceAfter: bank.balance, createdBy: await currentUserName(req) });
    await bank.save();

    res.json(serializeBank(bank));
  } catch (error) {
    res.status(500).json({ message: "Could not record transaction", detail: error.message });
  }
};

// Internal helper - NOT a route handler. Called directly from
// customerController.js's updateCustomerDues ("+ Add Dues" via Bank) and
// settleCustomerDues ("- Pay Dues" via Bank) so a customer payment routed
// through a bank moves that bank's own balance and shows up in its
// History, tagged with which customer it was to/from. Silently no-ops
// (returns null) if the bank id doesn't resolve within this shop, rather
// than failing the whole dues action over a missing/invalid bank pick.
exports.recordCustomerBankMovement = async function recordCustomerBankMovement({
  bankId,
  shopId,
  type,
  amount,
  note,
  customerName,
  customerPhone,
  createdBy,
}) {
  if (!bankId || !shopId || !(amount > 0)) return null;
  const bank = await Bank.findOne({ _id: bankId, shopId });
  if (!bank) return null;

  bank.balance = type === "deposit" ? bank.balance + amount : bank.balance - amount;
  bank.history.push({
    type,
    amount,
    note: note || "",
    balanceAfter: bank.balance,
    relatedCustomerPhone: customerPhone || "",
    relatedCustomerName: customerName || "",
    createdBy: createdBy || "",
  });
  await bank.save();
  return bank;
};

exports.serializeBank = serializeBank;
