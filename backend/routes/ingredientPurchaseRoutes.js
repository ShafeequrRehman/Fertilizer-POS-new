const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requireAnyPermission = require("../middleware/requireAnyPermission");
const { getPurchases, getPurchase, createPurchase, createPurchaseOrder, receivePurchaseOrder, recordPayment, cancelPurchase, getCompanyLedger } = require("../controllers/ingredientPurchaseController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);
// "purchases.manage" (module: Purchasing, see permissions.js) rather than
// "inventory.manage" - logging a batch and paying a supplier down is a
// purchasing/financial action, distinct from the stock/recipe management
// inventory.manage already covers for Ingredient/Recipe CRUD. Also accepts
// "stock.manage" (Stock Manager role) so logging a purchase works from the
// Ingredient Stock page without granting purchases.manage, which would also
// unlock the standalone Purchase page/nav item - see
// requireAnyPermission.js's own comment.
router.use(requireAnyPermission("purchases.manage", "stock.manage"));

// NOTE: "/company-ledger" and "/orders..." must stay registered before
// "/:id" - same reasoning as tableRoutes.js's "/settings"/"/:id" ordering
// comment - Express matches path patterns in registration order, and
// "/:id" would otherwise swallow "GET /company-ledger" as if
// "company-ledger" were an id. "/orders"/"/orders/:x/receive" don't
// actually collide with any existing "/:id"-shaped route today (different
// HTTP verbs/segment counts), but are kept up here anyway for the same
// discipline.
router.get("/company-ledger", getCompanyLedger);
// Dual-Status Stock Inventory Workflow (Purchase page): Phase 1 (Order
// Placed - multi-item, "pending", no stock effect yet) and Phase 2 (Maal
// Received & Paid - flips every line of the order to "received" and only
// then applies the stock/cost effect) - see ingredientPurchaseController's
// own comments on createPurchaseOrder/receivePurchaseOrder.
router.post("/orders", createPurchaseOrder);
router.patch("/orders/:purchaseOrderNumber/receive", receivePurchaseOrder);
router.get("/", getPurchases);
router.post("/", createPurchase);
router.get("/:id", getPurchase);
router.patch("/:id/pay", recordPayment);
// Unified Khata: the audited cancel-a-purchase endpoint - see
// ingredientPurchaseController.cancelPurchase's own comment. Gated by the
// same purchases.manage/stock.manage permission as every other mutating
// route in this router (no separate permission invented).
router.post("/:id/cancel", cancelPurchase);

module.exports = router;
