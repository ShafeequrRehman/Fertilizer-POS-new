const Permission = require("../models/Permission");
const User = require("../models/User");
const Customer = require("../models/Customer");
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
  } catch (error) {
    console.error("[Seed] Failed to run startup seed:", error.message);
  }
};
