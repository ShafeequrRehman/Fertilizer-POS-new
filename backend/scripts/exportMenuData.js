// Logs in as a given shop account (same username/email + password check as
// the real /api/auth/login flow) and dumps every product for that shop to
// a JSON file, so a menu document can be built from it afterward.
//
// Run from pos-web/:
//   node backend/scripts/exportMenuData.js "admin@urbancrunch" "11223344"
// or:
//   npm run export-menu -- "admin@urbancrunch" "11223344"
//
// Writes menu-export.json to the pos-web/ project root. This only READS
// data - it never modifies the user/product collections.

require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Shop = require("../models/Shop");
const Product = require("../models/Product");

async function run() {
  const [loginIdentifier, password] = process.argv.slice(2);
  if (!loginIdentifier || !password) {
    console.error('Usage: node backend/scripts/exportMenuData.js "<username-or-email>" "<password>"');
    process.exitCode = 1;
    return;
  }

  const mongoURI = process.env.MONGO_URI;
  if (!mongoURI) {
    throw new Error("MONGO_URI is not set in pos-web/.env");
  }

  await mongoose.connect(mongoURI);
  console.log(`Connected to MongoDB Atlas. Database: "${mongoose.connection.name}"`);

  const user = await User.findOne({
    $or: [{ username: loginIdentifier }, { email: loginIdentifier.toLowerCase() }],
  });

  if (!user) {
    console.error(`No account found for "${loginIdentifier}".`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    console.error("Incorrect password for that account.");
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  if (!user.shopId) {
    console.error(`Account "${loginIdentifier}" has no shop attached (role: ${user.role}). Nothing to export.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const shop = await Shop.findById(user.shopId);
  const products = await Product.find({ shopId: user.shopId }).sort({ category: 1, name: 1, variation: 1 }).lean();

  const exportData = {
    exportedAt: new Date().toISOString(),
    shop: shop ? { id: String(shop._id), name: shop.name } : null,
    loggedInAs: { name: user.name, username: user.username, email: user.email, role: user.role },
    productCount: products.length,
    products: products.map((p) => ({
      id: String(p._id),
      category: p.category || "General",
      name: p.name,
      variation: p.variation || "",
      price: p.price,
      stock: p.stock,
      image: p.image || "",
      color: p.color || "",
      description: p.description || "",
      isDeal: !!p.isDeal,
      dealItems: p.dealItems || [],
    })),
  };

  const outPath = path.join(__dirname, "..", "..", "menu-export.json");
  fs.writeFileSync(outPath, JSON.stringify(exportData, null, 2), "utf-8");

  console.log("");
  console.log(`Shop: ${exportData.shop ? exportData.shop.name : "(unknown)"}`);
  console.log(`Products exported: ${products.length}`);
  console.log(`Written to: ${outPath}`);

  await mongoose.disconnect();
}

run().catch((error) => {
  console.error("Export failed:", error.message);
  process.exitCode = 1;
});
