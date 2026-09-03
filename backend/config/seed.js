const Permission = require("../models/Permission");
const User = require("../models/User");
const Customer = require("../models/Customer");
const ShopSession = require("../models/ShopSession");
const IngredientPurchase = require("../models/IngredientPurchase");
const Ingredient = require("../models/Ingredient");
const bcrypt = require("bcryptjs");
const { PERMISSIONS } = require("./permissions");

// Customer.js's schema declares a compound unique index on (shopId, phone) -
// see models/Customer.js - but this app used to have a single-shop era
// where `phone` alone was the unique index. Mongoose never drops an index
// just because the schema definition changed; that old `phone_1` index can
// silently keep living on in the real MongoDB collection forever unless
// something explicitly drops it. With it still in place, MongoDB rejects
// ANY new customer whose phone number collides with it (not just within
// the same shop), which surfaced as: orders saving fine, but the customer
// silently never getting created (an E11000 duplicate-key error was being
// swallowed as "non-fatal" in orderController.createOrder, since a failed
// customer sync must never fail the order itself) - so new/returning
// customers stopped appearing in the Customers list / Ledger even though
// their name, phone, and address were entered correctly every time. This
// runs on every startup and is a no-op once the legacy index is gone.
async function dropLegacyCustomerPhoneIndex() {
  try {
    const collection = Customer.collection;
    const indexes = await collection.indexes();
    const legacyIndex = indexes.find((index) => index.name === "phone_1");
    if (legacyIndex) {
      await collection.dropIndex("phone_1");
      console.log('[Seed] Dropped legacy global-unique "phone_1" index on customers (superseded by the per-shop shopId+phone index).');
    }
    // Recreate whatever the schema currently declares (the compound
    // shopId+phone unique index) if it's missing. If this throws because
    // real duplicate (shopId, phone) data already exists, it's logged
    // clearly below instead of silently leaving the collection unindexed -
    // that would mean two Customer documents already share the same phone
    // within the same shop and need to be merged/cleaned up by hand.
    await Customer.syncIndexes();
  } catch (error) {
    console.error("[Seed] Failed to migrate customers phone index:", error.message);
  }
}

// openSession's find-then-create check was not atomic, so two concurrent
// "Open Shop" requests (double-click, two tabs/devices) could each create
// their own "open" ShopSession for the same shop before a database-level
// safeguard existed. Each duplicate starts its own orderCounter at 0, and
// since createOrder's counter lookup matches on shopId+status:"open" with
// no way to prefer one over the other pre-fix, order numbers could jump
// back down to #001 mid-shift instead of continuing - exactly the "already
// on order #003, next order came back as #001" bug this fixes. A partial
// unique index now makes this impossible going forward (see
// models/ShopSession.js), but creating that index requires the data to
// already satisfy it - so any duplicates already sitting in the database
// must be merged away FIRST, before ShopSession.syncIndexes() runs.
async function mergeDuplicateOpenShopSessions() {
  try {
    const openSessions = await ShopSession.find({ status: "open" }).sort({ openedAt: 1 });
    const byShop = new Map();
    for (const session of openSessions) {
      const key = String(session.shopId);
      if (!byShop.has(key)) byShop.set(key, []);
      byShop.get(key).push(session);
    }

    for (const [shopId, sessions] of byShop.entries()) {
      if (sessions.length <= 1) continue;

      // Oldest stays open and canonical - it's the one whose openedAt the
      // rest of the app (Dashboard/Record/Sales "today" windows, shift
      // history) has been treating as the real shift start. Carry forward
      // the HIGHEST orderCounter seen across all the duplicates, so
      // whichever one actually issued the most recent order numbers isn't
      // the one that gets discarded.
      const [canonical, ...extras] = sessions;
      const maxCounter = Math.max(...sessions.map((s) => Number(s.orderCounter || 0)));

      if (canonical.orderCounter !== maxCounter) {
        canonical.orderCounter = maxCounter;
        await canonical.save();
      }

      for (const extra of extras) {
        extra.status = "closed";
        extra.closedAt = new Date();
        extra.closedByName = extra.closedByName || "Auto-merged duplicate session";
        await extra.save();
      }

      console.log(`[Seed] Shop ${shopId} had ${sessions.length} simultaneously-open sessions - merged into one (orderCounter=${maxCounter}), closed ${extras.length} duplicate(s).`);
    }
  } catch (error) {
    console.error("[Seed] Failed to merge duplicate open shop sessions:", error.message);
  }
}

// Dual-Status Stock Inventory Workflow: every IngredientPurchase document
// created before models/IngredientPurchase.js gained its `status` field has
// no `status` in the actual stored document at all (Mongoose's schema
// `default` only applies when a document is first created, never
// retroactively to rows already sitting in MongoDB) - so a plain query
// filter like `{ status: "received" }`, which the Ledger/Day-End/Inventory
// report queries now all use, would silently stop matching every one of
// them, making real historical purchases vanish from company dues and
// expense reports. Every one of those legacy rows was, by the OLD
// immediate-stock-effect behavior, already folded into
// Ingredient.currentStock/averageCost the moment it was created - i.e.
// already fully "received" in every way that matters - so backfilling them
// as status:"received" (with receivedAt set to their own original
// purchaseDate, since that's the closest real date to when the goods
// actually arrived) is not a guess, it's just recording what already
// happened. Uses an aggregation-pipeline update ($set reading another
// field, "$purchaseDate") rather than a plain object update, since a plain
// update can't copy one field's value into another. Runs on every startup
// but only ever touches rows still missing `status`, so it's a no-op once
// every row has been migrated once.
async function backfillIngredientPurchaseStatus() {
  try {
    const result = await IngredientPurchase.updateMany(
      { status: { $exists: false } },
      [{ $set: { status: "received", receivedAt: "$purchaseDate" } }]
    );
    if (result.modifiedCount > 0) {
      console.log(`[Seed] Backfilled status="received" on ${result.modifiedCount} pre-existing ingredient purchase(s).`);
    }
  } catch (error) {
    console.error("[Seed] Failed to backfill ingredient purchase status:", error.message);
  }
}

// Floating-Point Round-Off Fix: every NEW mutation of Ingredient.
// currentStock now goes through the Safe Math Deduction/Addition Logic (see
// ingredientUnits.js's toMilliUnits/fromMilliUnits, used by stockService.js/
// ingredientController.js/ingredientPurchaseController.js), which
// self-heals any already-corrupted value the next time it's touched. This
// backfill just fixes existing corrupted values (e.g. "58.499999999999996")
// immediately on startup, instead of waiting for each ingredient's next
// order/purchase/restock to happen to repair it. Uses MongoDB's own
// $round (server-side, no need to load every ingredient into Node) - runs
// on every startup but is a no-op past the first time, since a value
// already rounded to 3 decimals is unaffected by rounding it again.
async function backfillIngredientStockPrecision() {
  try {
    const result = await Ingredient.updateMany(
      {},
      [{ $set: { currentStock: { $round: ["$currentStock", 3] }, averageCost: { $round: ["$averageCost", 3] } } }]
    );
    if (result.modifiedCount > 0) {
      console.log(`[Seed] Rounded floating-point drift out of currentStock/averageCost on ${result.modifiedCount} ingredient(s).`);
    }
  } catch (error) {
    console.error("[Seed] Failed to backfill ingredient stock precision:", error.message);
  }
}

// Runs on every backend startup. Responsibilities, all safe to repeat:
//
// 1. Keep the Permission catalog collection in sync with
//    config/permissions.js (upsert - adding a new permission key to the
//    code and restarting is enough, no manual DB step needed).
// 2. Guarantee at least one Super Admin account always exists. This does
//    NOT create the "admin"/"admin123" identity, or any shop, or any
//    tenant data - that one-time, structural work is
//    backend/scripts/migrateToMultiTenant.js, which was already run
//    against this database. This is just a safety net so the software
//    can never end up with zero working Super Admin accounts.
// 3. Drop the legacy global-unique customers.phone index (see
//    dropLegacyCustomerPhoneIndex above).
// 4. Merge away any duplicate simultaneously-open shop sessions and put
//    the new one-open-session-per-shop unique index in place (see
//    mergeDuplicateOpenShopSessions above).
// 5. Backfill status="received" onto pre-existing IngredientPurchase rows
//    that predate the Dual-Status Purchase Order workflow (see
//    backfillIngredientPurchaseStatus above).
// 6. Round away any pre-existing floating-point drift in stored
//    Ingredient.currentStock/averageCost values (see
//    backfillIngredientStockPrecision above).
module.exports = async function seedDefaults() {
  try {
    for (const permission of PERMISSIONS) {
      await Permission.findOneAndUpdate(
        { key: permission.key },
        { $set: permission },
        { upsert: true }
      );
    }

    const superAdminExists = await User.exists({ role: "superadmin" });
    if (!superAdminExists) {
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await User.create({
        name: "Super Admin",
        username: "admin",
        password: hashedPassword,
        role: "superadmin",
        shopId: null,
      });
      console.log('[Seed] No Super Admin existed. Created one - username: "admin", password: "admin123". Change the password after logging in.');
    }

    await dropLegacyCustomerPhoneIndex();

    // Must run in this order: merge duplicates away BEFORE syncIndexes()
    // tries to create the new unique index, since MongoDB will refuse to
    // build a unique index over data that currently violates it.
    await mergeDuplicateOpenShopSessions();
    await ShopSession.syncIndexes().catch((error) => {
      console.error("[Seed] Failed to sync ShopSession indexes:", error.message);
    });

    await backfillIngredientPurchaseStatus();
    await backfillIngredientStockPrecision();
  } catch (error) {
    console.error("[Seed] Failed to run startup seed:", error.message);
  }
};
