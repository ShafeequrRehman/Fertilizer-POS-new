// Bulk-imports the "Cheezy Pizza Bite" menu (from the two menu-board photos)
// into a shop's Products collection. Logs in the same way the real
// /api/auth/login flow does (username/email + bcrypt password check), then
// upserts every product so re-running this is always safe - it will never
// create duplicates, it just updates price/etc. if you run it again after
// editing the data below.
//
// Run from pos-web/:
//   node backend/scripts/importMenuData.js "admin@cheesypizza" "111222333"
// or:
//   npm run import-menu -- "admin@cheesypizza" "111222333"
//
// Each row below becomes one Product document. Sized items (pizzas, pasta,
// wings/nuggets) produce one document per size, all sharing the same
// name+category - that's how this app already represents "one card, many
// sizes" (see src/components/ProductManagementSection.tsx).

require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Shop = require("../models/Shop");
const Product = require("../models/Product");

// ---------------------------------------------------------------------
// Menu data
// ---------------------------------------------------------------------

// name, [Small, Medium, Large, XL]
const REGULAR_PIZZA = {
  category: "Regular Pizza",
  sizeLabels: ["Small", "Medium", "Large", "Extra Large"],
  image: "pizza-slice.svg",
  items: [
    ["Chicken Tikka Pizza", [550, 1050, 1350, 1900]],
    ["Chicken Barbecue Pizza", [550, 1050, 1350, 1900]],
    ["Chicken Achari Pizza", [550, 1050, 1350, 1900]],
    ["Chicken Fajita Pizza", [550, 1050, 1350, 1900]],
    ["Vegetable Pizza", [550, 1050, 1350, 1900]],
    ["Cheese Lover Pizza", [550, 1050, 1350, 1900]],
  ],
};

const SPECIAL_PIZZA = {
  category: "Special Pizza",
  sizeLabels: ["Small", "Medium", "Large", "Extra Large"],
  image: "chicken-tikka-pizza.svg",
  items: [
    ["Crown Trust Pizza", [600, 1100, 1500, 2000]],
    ["Peri Peri Pizza", [600, 1100, 1500, 2000]],
    ["Special Malai Boti Pizza", [600, 1100, 1500, 2000]],
    ["Special Cheesy Pizza", [600, 1100, 1500, 2000]],
    ["Special Cheesy White Sauce Pizza", [600, 1100, 1500, 2000]],
    ["Kabab Crust Pizza", [600, 1100, 1500, 2000]],
    ["Chicken Butter Lazania Pizza", [600, 1100, 1500, 2000]],
    ["Behari Kabab Pizza", [570, 1070, 1400, 1970]],
    ["Creamy Pizza", [600, 1100, 1500, 2000]],
    ["Crunchy Pizza", [600, 1100, 1500, 2000]],
    ["Crispy Pizza", [600, 1100, 1500, 2000]],
  ],
};

// name, price (single size)
const BURGERS = {
  category: "Burgers",
  image: "beef-burger-combo.svg",
  items: [
    ["Double Patty Burger", 400],
    ["Chicken Patty Burger", 270],
    ["Chicken Kabab Burger", 300],
    ["Cheesy Zinger Burger", 350],
    ["Zinger Burger", 300],
    ["Pizza Burger", 400],
    ["Monster Burger", 550],
    ["Mighty Burger", 500],
    ["Chicken Tikka Burger", 350],
    ["Chicken Double Burger", 400],
  ],
};

const SHAWARMA_WRAPS = {
  category: "Shawarma & Wraps",
  items: [
    ["Chicken Shawarma", 160, "zinger-shawarma.svg"],
    ["Chicken Zinger Shawarma", 350, "zinger-shawarma.svg"],
    ["Arabic Shawarma", 250, "zinger-shawarma.svg"],
    ["Special Plater Shawarma", 400, "zinger-shawarma.svg"],
    ["Chicken Paratha Roll", 300, "paratha-roll.svg"],
    ["Chicken Cheese Paratha Roll", 350, "paratha-roll.svg"],
    ["Chicken Malai Boti Paratha", 300, "malai-boti-roll.svg"],
    ["Cheese Malai Boti Paratha", 350, "malai-boti-roll.svg"],
    ["Chicken Kabab Paratha Roll", 300, "chicken-roll.svg"],
    ["Kabab Cheese Paratha Roll", 350, "chicken-roll.svg"],
  ],
};

const SPECIAL_PLATTER = {
  category: "Special Platter",
  items: [
    ["Special Platter Burger", 550, "beef-burger-combo.svg"],
    ["Special Pizza Sandwich", 750, "sandwich.svg"],
    ["Special Platter", 950, ""],
  ],
};

// name, [Small, Large]
const SPECIAL_PASTA = {
  category: "Special Pasta",
  sizeLabels: ["Small", "Large"],
  items: [
    ["Special Crunchi Pasta", [500, 750]],
    ["Special White Sauce Pasta", [550, 800]],
    ["Special Chicken Pasta", [550, 800]],
    ["Special Malai Buti Pasta", [530, 730]],
    ["Special Chicken Kebab Pasta", [550, 800]],
    ["Pasta", [450, 750]],
  ],
};

// name, [6 pcs, 10 pcs]
const WINGS_NUGGETS = {
  category: "Wings & Nuggets",
  sizeLabels: ["6 Pieces", "10 Pieces"],
  items: [
    ["Hot Wings", [350, 600], "chicken-wings.svg"],
    ["Oven Baked Wings", [380, 700], "chicken-wings.svg"],
    ["Chicken Nuggets", [300, 500], "nuggets.svg"],
  ],
};

// name, price, dealItems[], image
const DEALS = {
  category: "Deals",
  items: [
    ["Deal 1", 530, ["1 Zinger Burger", "1 Fries", "500ml Drink"], "couple-deal.svg"],
    ["Deal 2", 850, ["1 Zinger Burger", "1 Patty Burger", "1 Fries", "1 Litre Drink"], "couple-deal.svg"],
    ["Deal 3", 1300, ["2 Zinger Burger", "10 Wings", "1 Litre Drink"], "family-deal.svg"],
    ["Deal 4", 1700, ["1 Medium Pizza", "3 Chicken Shawarma", "1 Litre Drink"], "family-deal.svg"],
    ["Deal 5", 2150, ["2 Medium Pizza", "1 Litre Drink"], "family-deal.svg"],
    ["Deal 6", 3950, ["1 XL Pizza (Special)", "5 Zinger Burger", "1.5 Litre Drink"], "mega-deal.svg"],
    ["Deal 7A", 4000, ["2 XL Pizza (Any Flavour)", "1.5 Litre Drink"], "mega-deal.svg"],
    ["Deal 7B", 4800, ["1 XL Pizza (Special)", "5 Zinger Burger", "2 Plain Fries", "3 Chicken Shawarma", "1.5 Litre Drink"], "mega-deal.svg"],
    ["Deal 8", 3050, ["1 XL Pizza (Special)", "1 Plain Fries", "2 Zinger Burger", "1.5 Litre Drink"], "mega-deal.svg"],
    ["Deal 9", 2250, ["1 Large Pizza", "1 Special Platter", "1 Litre Drink"], ""],
    ["Birthday Deal", 4750, ["1 XL Pizza (Any Flavour)", "1 Large Pizza", "3 Zinger Burger", "2 Fries", "1 Piece Cake", "1.5 Litre Drink"], "party-deal.svg"],
    ["Student Deal", 1100, ["2 Small Pizza", "1 Litre Drink"], "kids-meal.svg"],
    ["Lunch Deal", 1400, ["1 Large Pizza", "1 Litre Drink"], "lunch-deal.svg"],
  ],
};

function buildSizedProducts(group) {
  const out = [];
  for (const [name, prices, image] of group.items) {
    prices.forEach((price, i) => {
      out.push({
        category: group.category,
        name,
        variation: group.sizeLabels[i],
        price,
        image: image || group.image || "",
      });
    });
  }
  return out;
}

function buildFlatProducts(group) {
  return group.items.map(([name, price, image]) => ({
    category: group.category,
    name,
    variation: "Standard",
    price,
    image: image !== undefined ? image : group.image || "",
  }));
}

function buildDealProducts(group) {
  return group.items.map(([name, price, dealItems, image]) => ({
    category: group.category,
    name,
    variation: "",
    price,
    image: image || "",
    isDeal: true,
    dealItems,
  }));
}

const ALL_PRODUCTS = [
  ...buildSizedProducts(REGULAR_PIZZA),
  ...buildSizedProducts(SPECIAL_PIZZA),
  ...buildFlatProducts(BURGERS),
  ...buildFlatProducts(SHAWARMA_WRAPS),
  ...buildFlatProducts(SPECIAL_PLATTER),
  ...buildSizedProducts(SPECIAL_PASTA),
  ...buildSizedProducts(WINGS_NUGGETS),
  ...buildDealProducts(DEALS),
];

// ---------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------

async function run() {
  const [loginIdentifier, password] = process.argv.slice(2);
  if (!loginIdentifier || !password) {
    console.error('Usage: node backend/scripts/importMenuData.js "<username-or-email>" "<password>"');
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
    console.error(`Account "${loginIdentifier}" has no shop attached (role: ${user.role}). Nothing to import.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const shop = await Shop.findById(user.shopId);
  console.log(`Shop: ${shop ? shop.name : "(unknown)"}  (${ALL_PRODUCTS.length} product rows to import)`);

  let created = 0;
  let updated = 0;

  for (const p of ALL_PRODUCTS) {
    const filter = { shopId: user.shopId, category: p.category, name: p.name, variation: p.variation };
    const result = await Product.findOneAndUpdate(
      filter,
      {
        $set: {
          price: p.price,
          image: p.image || "",
          isDeal: !!p.isDeal,
          dealItems: p.dealItems || [],
        },
        $setOnInsert: { shopId: user.shopId, stock: 0, color: "bg-slate-50", description: "" },
      },
      { upsert: true, new: true, rawResult: true }
    );
    if (result.lastErrorObject && result.lastErrorObject.upserted) {
      created += 1;
    } else {
      updated += 1;
    }
  }

  console.log("");
  console.log(`Created: ${created}`);
  console.log(`Updated (already existed): ${updated}`);
  console.log(`Total products for this shop now covers ${ALL_PRODUCTS.length} menu rows.`);

  await mongoose.disconnect();
}

run().catch((error) => {
  console.error("Import failed:", error.message);
  process.exitCode = 1;
});
