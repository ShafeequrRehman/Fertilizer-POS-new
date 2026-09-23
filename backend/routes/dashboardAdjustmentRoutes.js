const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const ctrl = require("../controllers/dashboardAdjustmentController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// view.dashboard - anyone who can see the Dashboard can see its own
// correction totals/history; making one is gated to dues.manage, same
// trust boundary cashRoutes.js uses for its own Adjust Cash endpoint.
router.get("/", requirePermission("view.dashboard"), ctrl.getAllAdjustments);
router.get("/:key/history", requirePermission("view.dashboard"), ctrl.getHistory);
router.post("/:key/adjust", requirePermission("dues.manage"), ctrl.adjust);

module.exports = router;
