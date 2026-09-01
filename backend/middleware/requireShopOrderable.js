const mongoose = require("mongoose");
const Shop = require("../models/Shop");
const License = require("../models/License");
const { isLicenseExpired } = License;

// Public-route counterpart to requireLicenseValid.js - there is no logged-in
// user here at all (a customer scanning a QR code was never authenticated),
// so shop identity comes from the :shopId URL param instead of req.user.shopId,
// and there's no JWT to check. Attaches req.shop (never req.user - there
// isn't one) for every route under /api/public/:shopId/*.
//
// Returns 503, not 402, on a suspended shop or expired license - 402 is
// what the dashboard's own axios interceptor watches for to redirect a
// logged-in session to #/license-expired (see src/lib/api.ts), which makes
// no sense for a customer who was never logged in and has no dashboard to
// redirect. 503 just reads as "temporarily unavailable" to a plain fetch.
module.exports = async function requireShopOrderable(req, res, next) {
  try {
    const { shopId } = req.params;
    if (!shopId || !mongoose.Types.ObjectId.isValid(shopId)) {
      return res.status(404).json({ message: "This ordering link is invalid.", reason: "invalid_shop" });
    }

    const shop = await Shop.findById(shopId).lean();
    if (!shop) {
      return res.status(404).json({ message: "This ordering link is invalid.", reason: "shop_not_found" });
    }
    if (shop.status === "suspended") {
      return res.status(503).json({ message: "This shop isn't accepting orders right now.", reason: "shop_suspended" });
    }

    const license = shop.licenseId ? await License.findById(shop.licenseId).lean() : null;
    if (isLicenseExpired(license)) {
      return res.status(503).json({ message: "This shop isn't accepting orders right now.", reason: "license_expired" });
    }

    req.shop = shop;
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
