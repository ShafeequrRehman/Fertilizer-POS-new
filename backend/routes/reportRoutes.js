const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const requireAnyPermission = require("../middleware/requireAnyPermission");
const { getDayEndReport, getMySalesReport, getInventoryReport, getLedgerTransactions } = require("../controllers/reportController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// The full restaurant-wide Day-End report stays exclusive to "reports.view" -
// unlike the two routes below, no scoped key substitutes for it.
router.get("/day-end", requirePermission("reports.view"), getDayEndReport);

// Shop Ledger's unified transaction list (cash sales, credit sales, due
// payments, purchases, expenses) - same "reports.view" gate as Day-End,
// since it's the same Reports/Accounting area of the app.
router.get("/ledger-transactions", requirePermission("reports.view"), getLedgerTransactions);

// Receptionist's own daily sales, and Stock Manager's kitchen-stock/supplier
// view - each accepts the full "reports.view" too (so a Manager/Owner
// browsing as themselves never 403s on these), OR its own narrow scoped key.
// See reportController.js's own comments on exactly what each returns.
router.get("/my-sales", requireAnyPermission("reports.view", "reports.view.own_sales"), getMySalesReport);
router.get("/inventory", requireAnyPermission("reports.view", "reports.view.inventory"), getInventoryReport);

module.exports = router;
