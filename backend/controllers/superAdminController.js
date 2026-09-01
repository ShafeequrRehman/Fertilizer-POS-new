const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/User");
const Shop = require("../models/Shop");
const License = require("../models/License");
const Plan = require("../models/Plan");
const Payment = require("../models/Payment");
const Role = require("../models/Role");
const SystemSettings = require("../models/SystemSettings");
const { DEFAULT_ROLE_PRESETS } = require("../config/permissions");
// requireLicenseValid caches its shop/license verdict for 30s per shop (see
// that file's own comment) to keep it from adding two extra DB round trips
// to nearly every request - every place below that changes a shop's status
// or its license must drop that shop's cached entry immediately, or a
// suspend/renew done here wouldn't actually take effect for up to 30s.
const invalidateLicenseCache = require("../middleware/requireLicenseValid").invalidate;

const DAY_MS = 24 * 60 * 60 * 1000;

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + Number(months));
  return d;
}

function safeUser(user) {
  const obj = user.toObject ? user.toObject() : user;
  delete obj.password;
  delete obj.refreshTokenHash;
  delete obj.refreshTokenExpiresAt;
  return obj;
}

// ---------------------------------------------------------------------
// Shops (+ their owning Shop Owner account, license, plan)
// ---------------------------------------------------------------------

// GET /api/superadmin/shops
exports.listShops = async (req, res) => {
  try {
    const shops = await Shop.find().sort({ createdAt: -1 }).populate("planId").lean();
    const shopIds = shops.map((s) => s._id);

    const [licenses, owners] = await Promise.all([
      License.find({ shopId: { $in: shopIds } }).lean(),
      User.find({ shopId: { $in: shopIds }, role: "shopowner" }).lean(),
    ]);
    const licenseByShop = new Map(licenses.map((l) => [String(l.shopId), l]));
    const ownerByShop = new Map(owners.map((o) => [String(o.shopId), o]));

    const result = shops.map((shop) => {
      const license = licenseByShop.get(String(shop._id)) || null;
      const owner = ownerByShop.get(String(shop._id)) || null;
      // Never send the hashes themselves to the client - only whether one
      // has been set, so the Shops table can flag shops that still need a
      // Cancel Order Key or a Page Visibility Key set up, without exposing
      // anything secret.
      const { cancelOrderKeyHash, pageVisibilityKeyHash, ...shopWithoutKeyHashes } = shop;
      return {
        ...shopWithoutKeyHashes,
        hasCancelOrderKey: Boolean(cancelOrderKeyHash),
        hasPageVisibilityKey: Boolean(pageVisibilityKeyHash),
        license: license ? { ...license, isExpired: license.status === "suspended" || new Date(license.expiryDate).getTime() < Date.now() } : null,
        owner: owner ? safeUser(owner) : null,
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to load shops", detail: error.message });
  }
};

// GET /api/superadmin/shops/:id
exports.getShop = async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id).populate("planId");
    if (!shop) return res.status(404).json({ message: "Shop not found" });

    const [license, owner, employees] = await Promise.all([
      License.findOne({ shopId: shop._id }),
      User.findOne({ shopId: shop._id, role: "shopowner" }),
      User.find({ shopId: shop._id, role: "employee" }),
    ]);

    res.json({
      shop,
      license,
      owner: owner ? safeUser(owner) : null,
      employees: employees.map(safeUser),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load shop", detail: error.message });
  }
};

// POST /api/superadmin/shops
// Creates a Shop + its Shop Owner account + its License in one action, and
// seeds the shop's default employee Roles (Cashier/Manager/Accountant/Store
// Keeper) from DEFAULT_ROLE_PRESETS so the Shop Owner has something to
// assign employees to immediately, without a separate setup step.
exports.createShop = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const {
      shopName, phone, email, address, notes,
      ownerUsername, ownerPassword, ownerName, ownerEmail, ownerPhone,
      planId, licenseMonths, licenseStatus, cancelOrderKey,
    } = req.body;

    if (!shopName || !ownerUsername || !ownerPassword) {
      return res.status(400).json({ message: "shopName, ownerUsername, and ownerPassword are required", reason: "validation_error" });
    }
    if (!cancelOrderKey || String(cancelOrderKey).length < 4) {
      return res.status(400).json({ message: "cancelOrderKey is required and must be at least 4 characters", reason: "validation_error" });
    }

    const existingUsername = await User.findOne({ username: ownerUsername });
    if (existingUsername) {
      return res.status(400).json({ message: "That username is already taken", reason: "username_taken" });
    }

    let plan = null;
    if (planId) {
      plan = await Plan.findById(planId);
      if (!plan) return res.status(400).json({ message: "Plan not found", reason: "plan_not_found" });
    }

    let createdShop, createdOwner, createdLicense;

    const cancelOrderKeyHash = await bcrypt.hash(String(cancelOrderKey), 10);

    await session.withTransaction(async () => {
      const shopDocs = await Shop.create([{ name: shopName, phone, email, address, notes, planId: plan ? plan._id : undefined, cancelOrderKeyHash }], { session });
      createdShop = shopDocs[0];

      const hashedPassword = await bcrypt.hash(ownerPassword, 10);
      const ownerDocs = await User.create(
        [{
          name: ownerName || shopName,
          username: ownerUsername,
          email: ownerEmail || "",
          phone: ownerPhone || "",
          password: hashedPassword,
          role: "shopowner",
          shopId: createdShop._id,
        }],
        { session }
      );
      createdOwner = ownerDocs[0];

      createdShop.ownerUserId = createdOwner._id;
      await createdShop.save({ session });

      const months = Number(licenseMonths) > 0 ? Number(licenseMonths) : (plan ? plan.durationMonths : 1);
      const startDate = new Date();
      const licenseDocs = await License.create(
        [{
          shopId: createdShop._id,
          planId: plan ? plan._id : undefined,
          startDate,
          expiryDate: addMonths(startDate, months),
          status: licenseStatus === "trial" ? "trial" : "active",
        }],
        { session }
      );
      createdLicense = licenseDocs[0];

      createdShop.licenseId = createdLicense._id;
      await createdShop.save({ session });

      const roleDocs = Object.entries(DEFAULT_ROLE_PRESETS).map(([name, permissions]) => ({
        shopId: createdShop._id,
        name,
        permissions,
        isSystem: true,
      }));
      await Role.create(roleDocs, { session, ordered: true });
    });

    res.status(201).json({
      shop: createdShop,
      owner: safeUser(createdOwner),
      license: createdLicense,
      credentials: { username: ownerUsername, password: ownerPassword },
      cancelOrderKey,
    });
  } catch (error) {
    console.error("[createShop] Failed:", error);
    res.status(500).json({ message: "Failed to create shop", detail: error.message });
  } finally {
    session.endSession();
  }
};

// PATCH /api/superadmin/shops/:id - edit shop profile fields
exports.updateShop = async (req, res) => {
  try {
    const { name, phone, email, address, notes, planId } = req.body;
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: "Shop not found" });

    if (name !== undefined) shop.name = name;
    if (phone !== undefined) shop.phone = phone;
    if (email !== undefined) shop.email = email;
    if (address !== undefined) shop.address = address;
    if (notes !== undefined) shop.notes = notes;
    if (planId !== undefined) shop.planId = planId || null;

    await shop.save();
    res.json(shop);
  } catch (error) {
    res.status(500).json({ message: "Failed to update shop", detail: error.message });
  }
};

// PATCH /api/superadmin/shops/:id/owner - edit the Shop Owner's account fields
exports.updateShopOwner = async (req, res) => {
  try {
    const { name, email, phone, username } = req.body;
    const owner = await User.findOne({ shopId: req.params.id, role: "shopowner" });
    if (!owner) return res.status(404).json({ message: "Shop Owner not found for this shop" });

    if (username && username !== owner.username) {
      const clash = await User.findOne({ username, _id: { $ne: owner._id } });
      if (clash) return res.status(400).json({ message: "That username is already taken", reason: "username_taken" });
      owner.username = username;
    }
    if (name !== undefined) owner.name = name;
    if (email !== undefined) owner.email = email;
    if (phone !== undefined) owner.phone = phone;

    await owner.save();
    res.json(safeUser(owner));
  } catch (error) {
    res.status(500).json({ message: "Failed to update shop owner", detail: error.message });
  }
};

// DELETE /api/superadmin/shops/:id - deletes the shop and everything scoped
// to it (owner account, employees, roles, license). Business data
// (products/customers/sales/etc.) is intentionally left untouched here -
// permanently destroying a paying customer's business records on a shop
// deletion is too destructive for a single click; that's a separate,
// explicit data-purge action if it's ever needed.
exports.deleteShop = async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: "Shop not found" });

    await Promise.all([
      User.deleteMany({ shopId: shop._id }),
      Role.deleteMany({ shopId: shop._id }),
      License.deleteMany({ shopId: shop._id }),
      Shop.deleteOne({ _id: shop._id }),
    ]);
    invalidateLicenseCache(shop._id);

    res.json({ message: "Shop and its accounts have been deleted. Business records (products, sales, etc.) were preserved." });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete shop", detail: error.message });
  }
};

// PATCH /api/superadmin/shops/:id/status  body: { status: "active" | "suspended" }
exports.setShopStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "suspended"].includes(status)) {
      return res.status(400).json({ message: "status must be 'active' or 'suspended'", reason: "validation_error" });
    }
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: "Shop not found" });

    shop.status = status;
    await shop.save();
    invalidateLicenseCache(shop._id);
    res.json(shop);
  } catch (error) {
    res.status(500).json({ message: "Failed to update shop status", detail: error.message });
  }
};

// PATCH /api/superadmin/shops/:id/owner/reset-password  body: { newPassword }
exports.resetShopOwnerPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: "newPassword must be at least 6 characters", reason: "validation_error" });
    }
    const owner = await User.findOne({ shopId: req.params.id, role: "shopowner" });
    if (!owner) return res.status(404).json({ message: "Shop Owner not found for this shop" });

    owner.password = await bcrypt.hash(newPassword, 10);
    owner.failedLoginAttempts = 0;
    owner.lockUntil = null;
    owner.refreshTokenHash = null;
    owner.refreshTokenExpiresAt = null;
    await owner.save();

    res.json({ message: "Shop Owner password has been reset", username: owner.username });
  } catch (error) {
    res.status(500).json({ message: "Failed to reset password", detail: error.message });
  }
};

// PATCH /api/superadmin/shops/:id/cancel-order-key  body: { newKey }
// Sets (or replaces) the shop's Cancel Order Key - the secret an employee
// must enter, on top of having the sales.delete permission, to cancel an
// order (see orderController.exports.cancelOrder). Only ever stored
// hashed; the plaintext is returned once here so the Super Admin can hand
// it to the Shop Owner, then never persisted or logged again.
exports.resetCancelOrderKey = async (req, res) => {
  try {
    const { newKey } = req.body;
    if (!newKey || String(newKey).length < 4) {
      return res.status(400).json({ message: "newKey must be at least 4 characters", reason: "validation_error" });
    }
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: "Shop not found" });

    shop.cancelOrderKeyHash = await bcrypt.hash(String(newKey), 10);
    await shop.save();

    res.json({ message: "Cancel Order Key has been set", cancelOrderKey: newKey });
  } catch (error) {
    res.status(500).json({ message: "Failed to set Cancel Order Key", detail: error.message });
  }
};

// PATCH /api/superadmin/shops/:id/page-visibility-key  body: { newKey }
// Sets (or replaces) the shop's Page Visibility Key - the secret the Shop
// Owner must enter, from their own Settings page, to change which sidebar
// pages their dashboard shows (see shopOwnerController.exports.
// updateEnabledPages). Only ever stored hashed; the plaintext is returned
// once here so the Super Admin can hand it to the Shop Owner, then never
// persisted or logged again.
exports.resetPageVisibilityKey = async (req, res) => {
  try {
    const { newKey } = req.body;
    if (!newKey || String(newKey).length < 4) {
      return res.status(400).json({ message: "newKey must be at least 4 characters", reason: "validation_error" });
    }
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: "Shop not found" });

    shop.pageVisibilityKeyHash = await bcrypt.hash(String(newKey), 10);
    await shop.save();

    res.json({ message: "Page Visibility Key has been set", pageVisibilityKey: newKey });
  } catch (error) {
    res.status(500).json({ message: "Failed to set Page Visibility Key", detail: error.message });
  }
};

// POST /api/superadmin/shops/:id/license/extend  body: { months, note, planId? }
// The only way a License's expiryDate ever moves forward. Also flips
// status back to "active" (out of trial/expired/suspended), and appends a
// renewalHistory entry for the audit trail / "Renewal History" screen.
exports.extendLicense = async (req, res) => {
  try {
    const { months, note, planId } = req.body;
    const monthsNum = Number(months);
    if (!monthsNum || monthsNum <= 0) {
      return res.status(400).json({ message: "months must be a positive number", reason: "validation_error" });
    }

    const license = await License.findOne({ shopId: req.params.id });
    if (!license) return res.status(404).json({ message: "License not found for this shop" });

    const previousExpiry = license.expiryDate;
    // Extend from "now" if already expired, otherwise stack on top of the
    // remaining time so early renewals aren't wasted.
    const base = previousExpiry && previousExpiry.getTime() > Date.now() ? previousExpiry : new Date();
    const newExpiry = addMonths(base, monthsNum);

    license.expiryDate = newExpiry;
    license.status = "active";
    license.lastRenewal = new Date();
    if (planId) license.planId = planId;
    license.renewalHistory.push({
      date: new Date(),
      months: monthsNum,
      previousExpiry,
      newExpiry,
      extendedBy: req.user.id,
      note: note || "",
    });

    await license.save();
    invalidateLicenseCache(license.shopId);
    res.json(license);
  } catch (error) {
    res.status(500).json({ message: "Failed to extend license", detail: error.message });
  }
};

// PATCH /api/superadmin/shops/:id/license/expiry  body: { expiryDate, note }
// Directly sets the expiry date to an exact value - unlike extendLicense
// (which only ever stacks months on top of the current expiry), this can
// move the date backward too, e.g. to correct a mistake or match a
// license the shop actually paid for. Logged to renewalHistory the same
// way so the audit trail stays complete either way.
exports.setLicenseExpiry = async (req, res) => {
  try {
    const { expiryDate, note } = req.body;
    const newExpiry = new Date(expiryDate);
    if (!expiryDate || Number.isNaN(newExpiry.getTime())) {
      return res.status(400).json({ message: "expiryDate must be a valid date", reason: "validation_error" });
    }

    const license = await License.findOne({ shopId: req.params.id });
    if (!license) return res.status(404).json({ message: "License not found for this shop" });

    const previousExpiry = license.expiryDate;
    const approxMonths = Math.round((newExpiry.getTime() - (previousExpiry?.getTime() || Date.now())) / (30 * DAY_MS));

    license.expiryDate = newExpiry;
    license.lastRenewal = new Date();
    license.renewalHistory.push({
      date: new Date(),
      months: approxMonths,
      previousExpiry,
      newExpiry,
      extendedBy: req.user.id,
      note: note || "Manually set expiry date",
    });

    await license.save();
    invalidateLicenseCache(license.shopId);
    res.json(license);
  } catch (error) {
    res.status(500).json({ message: "Failed to update license expiry", detail: error.message });
  }
};

// PATCH /api/superadmin/shops/:id/license/status  body: { status }
// Manual override (e.g. force "suspended" independent of expiryDate).
exports.setLicenseStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["trial", "active", "expired", "suspended"].includes(status)) {
      return res.status(400).json({ message: "Invalid license status", reason: "validation_error" });
    }
    const license = await License.findOne({ shopId: req.params.id });
    if (!license) return res.status(404).json({ message: "License not found for this shop" });

    license.status = status;
    await license.save();
    invalidateLicenseCache(license.shopId);
    res.json(license);
  } catch (error) {
    res.status(500).json({ message: "Failed to update license status", detail: error.message });
  }
};

// ---------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------

exports.listPlans = async (req, res) => {
  try {
    res.json(await Plan.find().sort({ price: 1 }));
  } catch (error) {
    res.status(500).json({ message: "Failed to load plans", detail: error.message });
  }
};

exports.createPlan = async (req, res) => {
  try {
    const { name, price, currency, durationMonths, maxEmployees, features } = req.body;
    if (!name || price === undefined || !durationMonths) {
      return res.status(400).json({ message: "name, price, and durationMonths are required", reason: "validation_error" });
    }
    const plan = await Plan.create({ name, price, currency, durationMonths, maxEmployees, features });
    res.status(201).json(plan);
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: "A plan with that name already exists", reason: "duplicate_plan" });
    res.status(500).json({ message: "Failed to create plan", detail: error.message });
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const { name, price, currency, durationMonths, maxEmployees, features, isActive } = req.body;
    if (name !== undefined) plan.name = name;
    if (price !== undefined) plan.price = price;
    if (currency !== undefined) plan.currency = currency;
    if (durationMonths !== undefined) plan.durationMonths = durationMonths;
    if (maxEmployees !== undefined) plan.maxEmployees = maxEmployees;
    if (features !== undefined) plan.features = features;
    if (isActive !== undefined) plan.isActive = isActive;

    await plan.save();
    res.json(plan);
  } catch (error) {
    res.status(500).json({ message: "Failed to update plan", detail: error.message });
  }
};

exports.deletePlan = async (req, res) => {
  try {
    const inUse = await Shop.exists({ planId: req.params.id });
    if (inUse) {
      return res.status(400).json({ message: "Cannot delete a plan that is still assigned to a shop. Deactivate it instead.", reason: "plan_in_use" });
    }
    await Plan.deleteOne({ _id: req.params.id });
    res.json({ message: "Plan deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete plan", detail: error.message });
  }
};

// ---------------------------------------------------------------------
// Payments (internal record-keeping only - no live payment gateway)
// ---------------------------------------------------------------------

// GET /api/superadmin/payments?shopId=
exports.listPayments = async (req, res) => {
  try {
    const filter = {};
    if (req.query.shopId) filter.shopId = req.query.shopId;
    const payments = await Payment.find(filter).sort({ date: -1 }).populate("shopId", "name").populate("planId", "name");
    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: "Failed to load payments", detail: error.message });
  }
};

// POST /api/superadmin/payments
// Manually logs a payment. Does NOT automatically extend the license -
// that's a deliberate two-step process (log the payment, then separately
// call extendLicense) so a logged payment is never silently out of sync
// with what the Super Admin actually decided to grant.
exports.recordPayment = async (req, res) => {
  try {
    const { shopId, planId, amount, currency, method, monthsCovered, note, date } = req.body;
    if (!shopId || amount === undefined) {
      return res.status(400).json({ message: "shopId and amount are required", reason: "validation_error" });
    }
    const payment = await Payment.create({
      shopId, planId, amount, currency, method, monthsCovered, note,
      date: date || new Date(),
      recordedBy: req.user.id,
    });
    res.status(201).json(payment);
  } catch (error) {
    res.status(500).json({ message: "Failed to record payment", detail: error.message });
  }
};

// ---------------------------------------------------------------------
// System statistics
// ---------------------------------------------------------------------

exports.getStats = async (req, res) => {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * DAY_MS);

    const [totalShops, activeShops, suspendedShops, totalEmployees, totalOwners, expiringSoon, expiredLicenses, revenueAgg] = await Promise.all([
      Shop.countDocuments(),
      Shop.countDocuments({ status: "active" }),
      Shop.countDocuments({ status: "suspended" }),
      User.countDocuments({ role: "employee" }),
      User.countDocuments({ role: "shopowner" }),
      License.countDocuments({ expiryDate: { $gte: now, $lte: soon }, status: { $ne: "suspended" } }),
      License.countDocuments({ $or: [{ status: "expired" }, { status: "suspended" }, { expiryDate: { $lt: now } }] }),
      Payment.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]),
    ]);

    res.json({
      totalShops,
      activeShops,
      suspendedShops,
      totalOwners,
      totalEmployees,
      licensesExpiringSoon: expiringSoon,
      expiredOrSuspendedLicenses: expiredLicenses,
      totalRevenue: revenueAgg[0]?.total || 0,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load statistics", detail: error.message });
  }
};

// ---------------------------------------------------------------------
// Software settings (singleton)
// ---------------------------------------------------------------------

exports.getSettings = async (req, res) => {
  try {
    res.json(await SystemSettings.getSingleton());
  } catch (error) {
    res.status(500).json({ message: "Failed to load settings", detail: error.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const settings = await SystemSettings.getSingleton();
    const fields = ["supportEmail", "supportPhone", "defaultCurrency", "defaultTrialDays", "licenseExpiryWarningDays", "maintenanceMode", "announcement"];
    fields.forEach((field) => {
      if (req.body[field] !== undefined) settings[field] = req.body[field];
    });
    await settings.save();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: "Failed to update settings", detail: error.message });
  }
};

// ---------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------

// GET /api/superadmin/logs
// There is no standing AuditLog collection (kept deliberately out of scope
// for this pass - see final report). This assembles a best-effort activity
// feed from data that already exists: license renewals and payments,
// merged and sorted by date. Good enough for "what happened recently"
// without adding a new always-on write path to every controller.
exports.getLogs = async (req, res) => {
  try {
    const [licenses, payments] = await Promise.all([
      License.find({ "renewalHistory.0": { $exists: true } }).populate("shopId", "name"),
      Payment.find().populate("shopId", "name").populate("recordedBy", "name username"),
    ]);

    const entries = [];
    licenses.forEach((license) => {
      license.renewalHistory.forEach((entry) => {
        entries.push({
          type: "license_renewal",
          date: entry.date,
          shop: license.shopId ? { id: license.shopId._id, name: license.shopId.name } : null,
          detail: `Extended ${entry.months} month(s) — new expiry ${new Date(entry.newExpiry).toDateString()}`,
          note: entry.note,
        });
      });
    });
    payments.forEach((payment) => {
      entries.push({
        type: "payment",
        date: payment.date,
        shop: payment.shopId ? { id: payment.shopId._id, name: payment.shopId.name } : null,
        detail: `Payment of ${payment.amount} ${payment.currency} via ${payment.method}`,
        recordedBy: payment.recordedBy ? (payment.recordedBy.name || payment.recordedBy.username) : null,
      });
    });

    entries.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(entries.slice(0, 200));
  } catch (error) {
    res.status(500).json({ message: "Failed to load logs", detail: error.message });
  }
};
