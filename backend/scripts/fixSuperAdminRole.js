// One-off repair script. The main migration (migrateToMultiTenant.js)
// creates the Shop first, then converts the "admin" user to
// role: "superadmin". If that script was interrupted between those two
// steps (e.g. a dropped Atlas connection), the Shop exists but "admin"
// is left with its old pre-redesign role value and no shopId - which is
// why login fails with "No shop is associated with this account" instead
// of skipping the shop check like a real superadmin does.
//
// Safe to run multiple times: only touches the single "admin" user, only
// sets role/shopId/employeeRoleId/isActive, does not touch password or
// create anything.
require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const User = require("../models/User");

async function run() {
  await connectDB();

  if (mongoose.connection.readyState !== 1) {
    console.error("[Fix] Could not establish a MongoDB connection. Aborting - no changes made.");
    process.exit(1);
  }

  const admin = await User.findOne({ username: "admin" });
  if (!admin) {
    console.error('[Fix] No user with username "admin" found. Nothing to fix.');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`[Fix] Found "admin" user (${admin._id}). Current role: "${admin.role}", current shopId: ${admin.shopId}`);

  if (admin.role === "superadmin" && !admin.shopId) {
    console.log('[Fix] Already correct (role="superadmin", shopId=null). No changes made.');
    await mongoose.disconnect();
    return;
  }

  admin.role = "superadmin";
  admin.shopId = null;
  admin.employeeRoleId = null;
  admin.isActive = true;
  await admin.save();

  console.log('[Fix] Updated "admin" user: role="superadmin", shopId=null, isActive=true.');
  console.log("[Fix] Done. Log in again with username=admin, your existing password.");

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error("[Fix] Failed:", error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
