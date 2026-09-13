// One-off backfill script. createShop (superAdminController.js) now seeds
// the "Electricity Bill" and "Cash" special products (Product.specialType)
// automatically for every NEW shop - this script does the same thing for
// every shop that already existed before that changed, one at a time.
//
// Safe to run multiple times: for each shop, it only ever ADDS a product
// that shop doesn't already have (checked by specialType, not by name - so
// a shop that renamed either product keeps its own copy untouched). Never
// updates, deletes, or touches any other product, order, customer, or any
// other data. Nothing about existing products/orders/customers changes.
require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Shop = require("../models/Shop");
const Product = require("../models/Product");

// Kept in sync with DEFAULT_SPECIAL_PRODUCTS in
// backend/controllers/superAdminController.js - see that file's own comment
// for why each field is what it is (image especially - it must stay a
// data: URI, not a "/products/<file>.svg" path).
const DEFAULT_SPECIAL_PRODUCTS = [
  {
    name: "Electricity Bill",
    category: "Services",
    variation: "Standard",
    price: 0,
    stock: 999999,
    color: "bg-amber-50",
    image: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjI0MCIgdmlld0JveD0iMCAwIDMyMCAyNDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIyNDAiIHJ4PSIyOCIgZmlsbD0iI0ZGRjdFMCIvPgogIDxyZWN0IHg9Ijk2IiB5PSI1MiIgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxNTAiIHJ4PSIxMCIgZmlsbD0iI0ZGRkZGRiIgc3Ryb2tlPSIjRThDNDY4IiBzdHJva2Utd2lkdGg9IjYiLz4KICA8cmVjdCB4PSIxMTIiIHk9Ijc0IiB3aWR0aD0iOTYiIGhlaWdodD0iMTAiIHJ4PSI1IiBmaWxsPSIjRThDNDY4Ii8+CiAgPHJlY3QgeD0iMTEyIiB5PSI5NCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjgiIHJ4PSI0IiBmaWxsPSIjRjBEQTlBIi8+CiAgPHJlY3QgeD0iMTEyIiB5PSIxMTAiIHdpZHRoPSI4MCIgaGVpZ2h0PSI4IiByeD0iNCIgZmlsbD0iI0YwREE5QSIvPgogIDxyZWN0IHg9IjExMiIgeT0iMTY4IiB3aWR0aD0iNjAiIGhlaWdodD0iMTAiIHJ4PSI1IiBmaWxsPSIjRThDNDY4Ii8+CiAgPHBhdGggZD0iTTE3MiAxMjhMMTQ2IDE1OEgxNjJMMTUwIDE4NkwxODggMTQ4SDE3MEwxNzIgMTI4WiIgZmlsbD0iI0Y1QTYyMyIgc3Ryb2tlPSIjQzk3RjBGIiBzdHJva2Utd2lkdGg9IjUiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K",
    description: "FESCO / electricity bill payment - enter the bill's TID and Bill Name at checkout.",
    specialType: "electricity_bill",
  },
  {
    name: "Cash",
    category: "Services",
    variation: "Standard",
    price: 0,
    stock: 999999,
    color: "bg-emerald-50",
    image: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjI0MCIgdmlld0JveD0iMCAwIDMyMCAyNDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIyNDAiIHJ4PSIyOCIgZmlsbD0iI0U4RjZFQyIvPgogIDxyZWN0IHg9IjcwIiB5PSI5NiIgd2lkdGg9IjE1MCIgaGVpZ2h0PSI4OCIgcng9IjEwIiBmaWxsPSIjREZGM0UzIiBzdHJva2U9IiM0QzlBNjMiIHN0cm9rZS13aWR0aD0iNSIvPgogIDxyZWN0IHg9IjEwMCIgeT0iNjQiIHdpZHRoPSIxNTAiIGhlaWdodD0iODgiIHJ4PSIxMCIgZmlsbD0iI0VBRjlFRSIgc3Ryb2tlPSIjM0U4QTU1IiBzdHJva2Utd2lkdGg9IjYiLz4KICA8Y2lyY2xlIGN4PSIxNzUiIGN5PSIxMDgiIHI9IjI2IiBmaWxsPSJub25lIiBzdHJva2U9IiMzRThBNTUiIHN0cm9rZS13aWR0aD0iNCIvPgogIDx0ZXh0IHg9IjE3NSIgeT0iMTE1IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMyRjZFNDMiPlJzPC90ZXh0PgogIDx0ZXh0IHg9IjIyMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIGZvbnQtd2VpZ2h0PSI4MDAiIGZpbGw9IiMyRjZFNDMiPjEwMDA8L3RleHQ+CiAgPHJlY3QgeD0iMTA4IiB5PSI3MiIgd2lkdGg9IjIwIiBoZWlnaHQ9IjcyIiByeD0iNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjM0U4QTU1IiBzdHJva2Utd2lkdGg9IjMiLz4KPC9zdmc+Cg==",
    description: "Cash handed over to a customer - enter who it's being given to at checkout.",
    specialType: "cash",
  },
];

async function run() {
  await connectDB();

  if (mongoose.connection.readyState !== 1) {
    console.error("[SeedSpecialProducts] Could not establish a MongoDB connection. Aborting - no changes made.");
    process.exit(1);
  }

  const shops = await Shop.find({}).lean();
  console.log(`[SeedSpecialProducts] Found ${shops.length} shop(s).`);

  let created = 0;
  let skipped = 0;

  for (const shop of shops) {
    for (const preset of DEFAULT_SPECIAL_PRODUCTS) {
      const existing = await Product.findOne({ shopId: shop._id, specialType: preset.specialType }).lean();
      if (existing) {
        skipped += 1;
        continue;
      }
      await Product.create({ ...preset, shopId: shop._id });
      created += 1;
      console.log(`[SeedSpecialProducts] Added "${preset.name}" to shop "${shop.name}" (${shop._id}).`);
    }
  }

  console.log(`[SeedSpecialProducts] Done. Created ${created}, already present (skipped) ${skipped}.`);
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error("[SeedSpecialProducts] Failed:", error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
