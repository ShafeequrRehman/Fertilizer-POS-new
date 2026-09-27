// One-off cleanup script. The "Electricity Bill" and "Cash" special
// products (Product.specialType) - previously auto-seeded into every shop
// by createShop (superAdminController.js) and backfilled by the now-
// removed scripts/seedSpecialProducts.js - and all the special checkout
// behavior tied to them (TID/Bill Name/Recipient Name fields on the POS
// screen) have been removed from the app per the shop owner's request. New
// shops no longer get these two products, but any shop created before this
// change still has its own copies sitting in its product catalog. This
// script removes exactly those two, for every shop, in one run.
//
// Safe to run multiple times: it only ever DELETES Product documents
// matching specialType "electricity_bill" or "cash" (never matched by
// name, so a shop that renamed either product is still matched correctly,
// and no other product can ever accidentally match). It never touches
// Orders, Customers, dues history, or any other data - historical orders
// that already used these products keep their own saved copy of the item
// (name/price/specialType) embedded on the order itself, so past receipts,
// Sales/Record history, and reports are completely unaffected.
//
// Usage (run once, from the project root, on the server where the real
// .env / MONGO_URI lives):
//   node backend/scripts/removeSpecialProducts.js
require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Product = require("../models/Product");

async function run() {
  await connectDB();

  if (mongoose.connection.readyState !== 1) {
    console.error("[RemoveSpecialProducts] Could not establish a MongoDB connection. Aborting - no changes made.");
    process.exit(1);
  }

  const matches = await Product.find({ specialType: { $in: ["electricity_bill", "cash"] } }).lean();
  console.log(`[RemoveSpecialProducts] Found ${matches.length} special product(s) to remove.`);
  for (const product of matches) {
    console.log(`[RemoveSpecialProducts]  - "${product.name}" (shop ${product.shopId})`);
  }

  const result = await Product.deleteMany({ specialType: { $in: ["electricity_bill", "cash"] } });
  console.log(`[RemoveSpecialProducts] Done. Deleted ${result.deletedCount} product(s).`);

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error("[RemoveSpecialProducts] Failed:", error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
