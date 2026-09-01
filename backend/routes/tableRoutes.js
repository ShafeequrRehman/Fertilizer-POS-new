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

router.get("/", getTables);
router.post("/", createTable);
router.patch("/:id", updateTable);
router.delete("/:id", deleteTable);

module.exports = router;
