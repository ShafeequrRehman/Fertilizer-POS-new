const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const grainController = require("../controllers/grainController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// Reuses dues.manage rather than a brand-new permission key - same reason
// as bankRoutes.js: the Grain Stock page exists specifically to back
// Customer Dues payments made "via Grain Stock" (see customerController.js),
// so whoever can already adjust/settle a customer's dues is exactly who
// should manage the shop's own grain stock ledger too.
router.get("/", requirePermission("dues.manage"), grainController.getGrains);
router.post("/", requirePermission("dues.manage"), grainController.createGrain);
router.post("/:id/transactions", requirePermission("dues.manage"), grainController.addTransaction);

module.exports = router;
