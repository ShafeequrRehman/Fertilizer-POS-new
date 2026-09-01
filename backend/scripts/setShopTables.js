// Sets a shop's custom DineIn table labels (Shop.tables - see
// models/Shop.js) so POSPage.tsx's Table Number dropdown and
// SalesPage.tsx's Change Table grid offer those instead of the default
// plain "Table 1".."Table 20" numbering. Every other shop is completely
// unaffected - this only ever touches the one shop matched below.
//
// Run from pos-web/:
//   node backend/scripts/setShopTables.js
//
// To point this at a different shop or table list later, just edit
// TARGET_USERNAME and TABLES below and run it again - it's safe to re-run,
// it always just overwrites that one shop's tables with whatever's listed
// here.

require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const User = require("../models/User");
const Shop = require("../models/Shop");

// The shop is identified by looking up this login (username or email) and
// following its shopId - not by shop name, since shop names aren't
// guaranteed unique the way login identifiers are.
const TARGET_USERNAME = "admin@urbancrunch";

// Male section (M1-M8), Family section (FM1-FM8), Outdoor section
// (OUT1-OUT8) - order here is the order they'll appear in both the
// dropdown and the grid.
const TABLES = [
  ...Array.from({ length: 8 }, (_, i) => `M${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `FM${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `OUT${i + 1}`),
];

async function run() {
  const mongoURI = process.env.MONGO_URI;
  if (!mongoURI) {
    throw new Error("MONGO_URI is not set in pos-web/.env");
  }

  await mongoose.connect(mongoURI);
  console.log(`Connected to MongoDB Atlas. Database: "${mongoose.connection.name}"`);

  const user = await User.findOne({
    $or: [{ username: TARGET_USERNAME }, { email: TARGET_USERNAME }],
  });

  if (!user) {
    throw new Error(`No user found with username/email "${TARGET_USERNAME}".`);
  }
  if (!user.shopId) {
    throw new Error(`User "${TARGET_USERNAME}" (_id: ${user._id}) has no shopId - not a shop owner/employee account?`);
  }

  const shop = await Shop.findById(user.shopId);
  if (!shop) {
    throw new Error(`User "${TARGET_USERNAME}" points at shopId ${user.shopId}, but no Shop document exists with that _id.`);
  }

  shop.tables = TABLES;
  await shop.save();

  console.log(`Updated shop "${shop.name}" (_id: ${shop._id}) - tables set to:`);
  console.log(TABLES.join(", "));
  console.log("");
  console.log("Takes effect the next time each till/paired phone refreshes its shop profile (immediately if online right now, or on next launch/sync if not).");

  await mongoose.disconnect();
}

run().catch((error) => {
  console.error("Failed to set shop tables:", error.message);
  process.exitCode = 1;
});
