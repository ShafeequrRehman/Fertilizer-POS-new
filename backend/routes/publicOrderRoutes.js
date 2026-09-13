const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const requireShopOrderable = require("../middleware/requireShopOrderable");
const ctrl = require("../controllers/publicOrderController");

// Every route here is reachable with no login (see requireShopOrderable's
// own comment) - there's no auth gate to slow down a bot the way
// authRoutes.js's loginLimiter slows down credential stuffing, so this is
// the only thing standing between the menu/status endpoints and casual
// scraping/abuse.
const readLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: { message: "Too many requests - please slow down and try again shortly." },
});

// Stricter - an actual order writes to the database and (once claimed)
// fires a kitchen ticket, so spamming this one is worse than spamming a
// read. 8 orders per 10 minutes is generous for a real customer.
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  message: { message: "Too many orders from this device - please wait a few minutes and try again." },
});

router.use("/:shopId", requireShopOrderable);

router.get("/:shopId/manifest.json", readLimiter, ctrl.getManifest);
router.get("/:shopId/menu", readLimiter, ctrl.getMenu);
router.get("/:shopId/customer-status", readLimiter, ctrl.getCustomerStatus);
router.get("/:shopId/orders/:orderId", readLimiter, ctrl.getOrderStatus);
router.post("/:shopId/orders", orderLimiter, ctrl.createOrder);
router.post("/:shopId/orders/:orderId/change-request", orderLimiter, ctrl.requestOrderChange);

// Payment gateway: initiatePayment is called by CustomerOrderPage.tsx right
// after placing an order paid via JazzCash/EasyPaisa, to get the signed
// redirect payload. The callback routes are hit by the gateway itself
// (server-to-server postback and/or the customer's browser redirecting
// back through it) - not by CustomerOrderPage.tsx directly, so they're
// NOT behind readLimiter/orderLimiter (a legitimate gateway callback
// shouldn't get rate-limited alongside customer traffic), but they're
// still under requireShopOrderable above so an invalid/suspended shop id
// still gets rejected the same way.
router.post("/:shopId/orders/:orderId/pay/:provider", orderLimiter, ctrl.initiatePayment);
router.all("/:shopId/payments/jazzcash/callback", ctrl.jazzCashCallback);
router.all("/:shopId/payments/easypaisa/callback", ctrl.easyPaisaCallback);

module.exports = router;
