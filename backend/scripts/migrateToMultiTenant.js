// One-time data migration: single-tenant restaurant POS -> multi-tenant
// commercial SaaS. Run once, directly against the live MongoDB Atlas
// database (per explicit approval - "Run it now as part of this build").
//
// What it does:
//   1. Seeds the global Permission catalog (config/permissions.js).
//   2. Creates a "Standard" Plan if none exists.
//   3. Creates one Shop ("The Heaven Slice" - the existing restaurant)
//      with an active License (12 months from today).
//   4. Converts the existing admin/admin123 account into the Super Admin
//      (role: "superadmin", shopId: null) - per explicit instruction to
//      keep admin/admin123 as the Super Admin login. If no admin/admin123
//      account exists, creates a fresh one.
//   5. Creates a brand-new, separate Shop Owner account for the shop that
//      receives the migrated data (admin/admin123 becomes Super Admin, so
//      it can no longer also be "the shop's" login - a shop needs its own
//      owner account). Credentials are printed at the end - save them.
//   6. Seeds the shop's default employee Roles (Cashier/Manager/
//      Accountant/Store Keeper) from DEFAULT_ROLE_PRESETS.
//   7. Tags every existing Product/Customer/Order/Waiter document that has
//      no shopId with the new shop's shopId.
//
// Idempotent: if a Shop already exists, the script logs that and exits
// without making changes - safe to re-run accidentally.
require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const { PERMISSIONS, DEFAULT_ROLE_PRESETS } = require("../config/permissions");

const User = require("../models/User");
const Shop = require("../models/Shop");
const License = require("../models/License");
const Plan = require("../models/Plan");
const Role = require("../models/Role");
const Permission = require("../models/Permission");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const Order = require("../models/Order");
const Waiter = require("../models/Waiter");

const SHOP_NAME = "The Heaven Slice";
const SHOP_PHONE = "0300-0310275";
const SHOP_ADDRESS = "Gojra Road Near Ali Merriage Hall";

function generatePassword() {
  // 12 chars, alphanumeric, plus a symbol - readable enough to type into
  // a login screen, strong enough for a real account.
  const raw = crypto.randomBytes(12).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  return `${raw.slice(0, 10)}!${Math.floor(Math.random() * 90 + 10)}`;
}

async function seedPermissions() {
  for (const permission of PERMISSIONS) {
    await Permission.findOneAndUpdate(
      { key: permission.key },
      { $set: permission },
      { upsert: true, new: true }
    );
  }
  console.log(`[Migration] Permission catalog seeded (${PERMISSIONS.length} keys).`);
}

async function ensurePlan() {
  let plan = await Plan.findOne({ name: "Standard" });
  if (!plan) {
    plan = await Plan.create({
      name: "Standard",
      price: 0,
      currency: "PKR",
      durationMonths: 12,
      maxEmployees: 10,
      features: ["Unlimited sales", "Inventory management", "Customer management", "Reports"],
      isActive: true,
    });
    console.log("[Migration] Created default 'Standard' plan.");
  }
  return plan;
}

async function run() {
  await connectDB();

  if (mongoose.connection.readyState !== 1) {
    console.error("[Migration] Could not establish a MongoDB connection. Aborting - no changes made.");
    process.exit(1);
  }

  const existingShopCount = await Shop.countDocuments();
  if (existingShopCount > 0) {
    console.log(`[Migration] ${existingShopCount} shop(s) already exist - migration has already run. No changes made.`);
    await mongoose.disconnect();
    return;
  }

  console.log("[Migration] Starting multi-tenant migration...");

  await seedPermissions();
  const plan = await ensurePlan();

  // --- Shop + License -----------------------------------------------
  const shop = await Shop.create({
    name: SHOP_NAME,
    phone: SHOP_PHONE,
    address: SHOP_ADDRESS,
    status: "active",
    planId: plan._id,
  });

  const startDate = new Date();
  const expiryDate = new Date(startDate);
  expiryDate.setMonth(expiryDate.getMonth() + 12);

  const license = await License.create({
    shopId: shop._id,
    planId: plan._id,
    startDate,
    expiryDate,
    status: "active",
    lastRenewal: startDate,
    renewalHistory: [{ date: startDate, months: 12, previousExpiry: null, newExpiry: expiryDate, note: "Initial migration grant" }],
  });

  shop.licenseId = license._id;

  console.log(`[Migration] Created shop "${shop.name}" (${shop._id}) with a 12-month active license (expires ${expiryDate.toDateString()}).`);

  // --- Super Admin: convert admin/admin123, or create fresh ----------
  let superAdmin = await User.findOne({ username: "admin" });
  if (superAdmin) {
    superAdmin.role = "superadmin";
    superAdmin.shopId = null;
    superAdmin.employeeRoleId = null;
    superAdmin.isActive = true;
    await superAdmin.save();
    console.log(`[Migration] Converted existing "admin" account (${superAdmin._id}) into the Super Admin. Password unchanged (admin123, unless changed since).`);
  } else {
    const hashedPassword = await bcrypt.hash("admin123", 10);
    superAdmin = await User.create({
      name: "Super Admin",
      username: "admin",
      password: hashedPassword,
      role: "superadmin",
      shopId: null,
    });
    console.log(`[Migration] No existing "admin" account found - created a fresh Super Admin (admin / admin123).`);
  }

  // --- New Shop Owner account for the migrated shop -------------------
  const ownerUsername = "shopowner";
  const ownerPassword = generatePassword();
  const hashedOwnerPassword = await bcrypt.hash(ownerPassword, 10);

  const shopOwner = await User.create({
    name: SHOP_NAME,
    username: ownerUsername,
    password: hashedOwnerPassword,
    role: "shopowner",
    shopId: shop._id,
  });

  shop.ownerUserId = shopOwner._id;
  await shop.save();

  console.log(`[Migration] Created Shop Owner account for "${shop.name}": username="${ownerUsername}" password="${ownerPassword}" - SAVE THIS PASSWORD NOW, it is not stored anywhere in plaintext.`);

  // --- Default employee roles for the shop ----------------------------
  const roleDocs = Object.entries(DEFAULT_ROLE_PRESETS).map(([name, permissions]) => ({
    shopId: shop._id,
    name,
    permissions,
    isSystem: true,
  }));
  await Role.insertMany(roleDocs);
  console.log(`[Migration] Seeded ${roleDocs.length} default employee roles (${Object.keys(DEFAULT_ROLE_PRESETS).join(", ")}).`);

  // --- Tag existing business data with the new shopId ------------------
  const [productResult, customerResult, orderResult, waiterResult] = await Promise.all([
    Product.updateMany({ shopId: { $exists: false } }, { $set: { shopId: shop._id } }),
    Customer.updateMany({ shopId: { $exists: false } }, { $set: { shopId: shop._id } }),
    Order.updateMany({ shopId: { $exists: false } }, { $set: { shopId: shop._id } }),
    Waiter.updateMany({ shopId: { $exists: false } }, { $set: { shopId: shop._id } }),
  ]);

  console.log("[Migration] Tagged existing data with shopId:");
  console.log(`  Products: ${productResult.modifiedCount}`);
  console.log(`  Customers: ${customerResult.modifiedCount}`);
  console.log(`  Orders: ${orderResult.modifiedCount}`);
  console.log(`  Waiters: ${waiterResult.modifiedCount}`);

  console.log("\n[Migration] Complete. Summary:");
  console.log(`  Super Admin login: username="admin" password="admin123" (unchanged)`);
  console.log(`  Shop Owner login:  username="${ownerUsername}" password="${ownerPassword}"`);
  console.log(`  Shop: "${shop.name}" (${shop._id})`);
  console.log(`  License: active until ${expiryDate.toDateString()}`);

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error("[Migration] Failed:", error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
