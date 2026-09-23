const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const munshiController = require("../controllers/munshiController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// Reuses dues.manage rather than a brand-new permission key - same reason
// as bankRoutes.js: the Munshi Khata page exists specifically to back
// Customer Dues payments made "via Munshi" (see customerController.js).
router.get("/", requirePermission("dues.manage"), munshiController.getMunshiSummary);
router.post("/adjust", requirePermission("dues.manage"), munshiController.adjustMunshi);

module.exports = router;
