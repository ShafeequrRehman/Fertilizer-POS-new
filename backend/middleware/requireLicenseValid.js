const Shop = require("../models/Shop");
const License = require("../models/License");
const { isLicenseExpired } = License;

// Defense-in-depth: the frontend routes an expired-license shop to a
// dedicated "License Expired" screen instead of the dashboard right after
// login, but that's a client-side redirect and nothing stops a modified
// client (or a stale open tab) from still calling the API directly. This
// middleware re-checks shop status + license expiry on the backend for
// every shop-scoped data route (products, sales, customers, etc.), so
// access is actually blocked at the source of truth, not just hidden in
// the UI. Super Admin routes never go through this - the Super Admin must
// always be able to reach every shop regardless of that shop's license.
//
// This runs on nearly every authenticated request in the app, and each of
// its two lookups is its own round trip to the (remote, Atlas-hosted, see
// backend/config/db.js) database - on a till with anything less than a
// great connection, that's two full network round trips added on top of
// whatever the route's own actual query needs, before it even starts. Two
// things keep that from compounding into the multi-second stalls that were
// timing out the frontend's 8s axios timeout (customers/dues updates,
// dashboard orders, ledger, all of it): run the two lookups in parallel
// instead of one after another, and cache a shop's pass/fail result for a
// short window so a burst of requests from the same shop (a page loading
// five things at once, or a user clicking around) doesn't re-pay this cost
// on every single one. Suspension/license-expiry are not the kind of state
// that needs to be caught within milliseconds - the frontend's own gate at
// login is still the primary, instant check; this is the backstop.
const CACHE_TTL_MS = 30_000;
const cache = new Map(); // shopId -> { expiresAt, result }

function cacheGet(shopId) {
  const entry = cache.get(shopId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(shopId);
    return null;
  }
  return entry.result;
}

function cacheSet(shopId, result) {
  cache.set(shopId, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Exported so anything that changes a shop's status/license mid-session
// (suspend/reinstate, renew, etc.) can drop the cached verdict immediately
// instead of waiting out the TTL.
function invalidate(shopId) {
  if (shopId) cache.delete(String(shopId));
}

module.exports = async function requireLicenseValid(req, res, next) {
  try {
    if (!req.user || !req.user.shopId) {
      return res.status(403).json({ message: "No shop associated with this account" });
    }

    const shopId = String(req.user.shopId);
    const cached = cacheGet(shopId);
    if (cached) {
      if (!cached.ok) return res.status(cached.status).json(cached.body);
      req.shop = cached.shop;
      req.license = cached.license;
      return next();
    }

    // .lean() on both - neither req.shop nor req.license is ever read by
    // anything downstream of this middleware (grepped: nothing in the
    // codebase reads req.shop./req.license. besides here), and
    // isLicenseExpired below is now a plain-object helper, not the schema
    // method - so there's no need to pay for hydrating a full Mongoose
    // Document on what runs on nearly every authenticated request.
    const [shop, license] = await Promise.all([
      Shop.findById(req.user.shopId).lean(),
      License.findOne({ shopId: req.user.shopId }).lean(),
    ]);

    if (!shop) {
      const body = { message: "Shop not found", reason: "shop_not_found" };
      cacheSet(shopId, { ok: false, status: 404, body });
      return res.status(404).json(body);
    }

    if (shop.status === "suspended") {
      const body = {
        message: "This shop has been suspended by the software provider. Please contact support.",
        reason: "shop_suspended",
      };
      cacheSet(shopId, { ok: false, status: 402, body });
      return res.status(402).json(body);
    }

    if (!license) {
      const body = {
        message: "No license found for this shop. Please contact the software provider.",
        reason: "license_missing",
      };
      cacheSet(shopId, { ok: false, status: 402, body });
      return res.status(402).json(body);
    }

    if (isLicenseExpired(license)) {
      const body = {
        message: "Your license has expired. Please contact the software provider to renew your subscription.",
        reason: "license_expired",
        licenseStatus: license.status,
        expiryDate: license.expiryDate,
      };
      cacheSet(shopId, { ok: false, status: 402, body });
      return res.status(402).json(body);
    }

    cacheSet(shopId, { ok: true, shop, license });
    req.shop = shop;
    req.license = license;
    next();
  } catch (error) {
    res.status(500).json({ message: "Failed to validate license", detail: error.message });
  }
};

module.exports.invalidate = invalidate;
