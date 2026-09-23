const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const labourController = require("../controllers/labourController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// Reuses dues.manage rather than a brand-new permission key - same reason
// as bankRoutes.js: the Labour Khata page exists specifically to back
// Customer Dues payments made "via Labour" (see customerController.js).
router.get("/", requirePermission("dues.manage"), labourController.getLabourSummary);
router.post("/adjust", requirePermission("dues.manage"), labourController.adjustLabour);

module.exports = router;
