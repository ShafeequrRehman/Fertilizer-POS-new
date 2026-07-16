const Shop = require("../models/Shop");
const License = require("../models/License");

// Defense-in-depth: the frontend routes an expired-license shop to a
// dedicated "License Expired" screen instead of the dashboard right after
// login, but that's a client-side redirect and nothing stops a modified
// client (or a stale open tab) from still calling the API directly. This
// middleware re-checks shop status + license expiry on the backend for
// every shop-scoped data route (products, sales, customers, etc.), so
// access is actually blocked at the source of truth, not just hidden in
// the UI. Super Admin routes never go through this - the Super Admin must
// always be able to reach every shop regardless of that shop's license.
module.exports = async function requireLicenseValid(req, res, next) {
  try {
    if (!req.user || !req.user.shopId) {
      return res.status(403).json({ message: "No shop associated with this account" });
    }

    const shop = await Shop.findById(req.user.shopId);
    if (!shop) {
      return res.status(404).json({ message: "Shop not found", reason: "shop_not_found" });
    }

    if (shop.status === "suspended") {
      return res.status(402).json({
        message: "This shop has been suspended by the software provider. Please contact support.",
        reason: "shop_suspended",
      });
    }

    const license = await License.findOne({ shopId: shop._id });
    if (!license) {
      return res.status(402).json({
        message: "No license found for this shop. Please contact the software provider.",
        reason: "license_missing",
      });
    }

    if (license.isExpired()) {
      return res.status(402).json({
        message: "Your license has expired. Please contact the software provider to renew your subscription.",
        reason: "license_expired",
        licenseStatus: license.status,
        expiryDate: license.expiryDate,
      });
    }

    req.shop = shop;
    req.license = license;
    next();
  } catch (error) {
    res.status(500).json({ message: "Failed to validate license", detail: error.message });
  }
};
