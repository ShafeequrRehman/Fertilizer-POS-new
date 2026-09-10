const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const { getTables, createTable, updateTable, deleteTable, getTableSettings, updateTableSettings } = require("../controllers/tableController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// NOTE: "/settings" routes must stay registered before the "/:id" routes
// below - Express matches path patterns in registration order, and "/:id"
// would otherwise swallow "/settings" requests (treating "settings" as the
// id) before they ever reach these handlers.
router.get("/settings", getTableSettings);
router.patch("/settings", requirePermission("settings.manage"), updateTableSettings);

// Broken Access Control fix: create/rename/re-categorize/delete a table
// used to be open to any authenticated shop member - the Dining Tables
// PAGE was already gated behind 'manage.tables' (see dashboard-pages.ts/
// App.tsx), but hiding the sidebar link never stopped these endpoints
// themselves from being reachable by anyone's token directly, exactly the
// "hide the link, forget the endpoint" pattern this whole pass closes.
// Reading the table list stays open to any shop member on purpose (unlike
// the writes below) - POSPage's Dine-In table grid and SalesPage's Change
// Table modal both need it for ordinary checkout, regardless of whether
// that cashier also happens to hold 'manage.tables'.
router.get("/", getTables);
router.post("/", requirePermission("manage.tables"), createTable);
router.patch("/:id", requirePermission("manage.tables"), updateTable);
router.delete("/:id", requirePermission("manage.tables"), deleteTable);

module.exports = router;
