// Retroactively assigns Tr# (Order.shopSequenceNumber) to every order a
// shop has ever placed, oldest first, so numbering covers the shop's whole
// history (1, 2, 3, ... N) instead of only orders placed after this
// feature shipped - see orderController.js's createOrder/importOfflineOrders
// for how NEW orders get numbered going forward, and models/Order.js's
// shopSequenceNumber / models/Shop.js's orderSequenceCounter for the field
// definitions.
//
// Run from pos-web/ (after building/deploying the Tr# feature itself):
//   node backend/scripts/backfillShopSequenceNumbers.js
// or:
//   npm run backfill-tr-numbers
//
// IMPORTANT - read before running:
//   - This OVERWRITES shopSequenceNumber on every order for every shop,
//     including any that already got a real number from a live order
//     placed after the feature shipped - everything is renumbered fresh,
//     oldest-created-first, so the final result is always a clean,
//     gapless 1..N with no regard for whatever was there before. Safe to
//     re-run any time (fully idempotent) - running it twice in a row
//     produces the exact same numbering both times.
//   - Every order counts, including cancelled ones - "every order for
//     each shop" means every order document that shop ever created, not
//     just completed sales.
//   - This changes what the SYSTEM shows as an old order's Tr# - it does
//     NOT and cannot change what was physically printed on old paper
//     receipts (those used the old id-derived Tr#, before this feature
//     existed). There is no way to make historical printed paper agree
//     with a sequential numbering scheme that didn't exist yet when it was
//     printed - this script only makes the system's own records
//     consistent going forward.
//   - After this runs, Shop.orderSequenceCounter is set to match each
//     shop's final count, so the very next NEW order continues at N+1
//     instead of colliding with anything just assigned here.

require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const Shop = require("../models/Shop");
const Order = require("../models/Order");

async function run() {
  const mongoURI = process.env.MONGO_URI;
  if (!mongoURI) {
    throw new Error("MONGO_URI is not set in pos-web/.env");
  }

  await mongoose.connect(mongoURI);
  console.log(`Connected to MongoDB Atlas. Database: "${mongoose.connection.name}"`);

  const shops = await Shop.find({}).select("_id name").lean();
  console.log(`Found ${shops.length} shop(s).`);

  let totalOrdersNumbered = 0;

  for (const shop of shops) {
    const orders = await Order.find({ shopId: shop._id })
      .select("_id createdAt")
      .sort({ createdAt: 1 })
      .lean();

    if (orders.length === 0) {
      console.log(`- ${shop.name || shop._id}: no orders, skipping.`);
      continue;
    }

    const bulkOps = orders.map((order, index) => ({
      updateOne: {
        filter: { _id: order._id },
        update: { $set: { shopSequenceNumber: index + 1 } },
      },
    }));

    await Order.bulkWrite(bulkOps);
    await Shop.updateOne({ _id: shop._id }, { $set: { orderSequenceCounter: orders.length } });

    console.log(`- ${shop.name || shop._id}: numbered ${orders.length} order(s), Tr# 1 through ${orders.length}.`);
    totalOrdersNumbered += orders.length;
  }

  console.log("");
  console.log(`Done. ${totalOrdersNumbered} order(s) numbered across ${shops.length} shop(s).`);

  await mongoose.disconnect();
}

run().catch((error) => {
  console.error("Failed to backfill Tr# numbers:", error.message);
  process.exitCode = 1;
});
