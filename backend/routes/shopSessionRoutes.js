const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const ctrl = require("../controllers/shopSessionController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/current", ctrl.getCurrent);
router.get("/history", requirePermission("shop.session.manage"), ctrl.getHistory);
router.post("/open", requirePermission("shop.session.manage"), ctrl.openSession);
router.post("/close", requirePermission("shop.session.manage"), ctrl.closeSession);

module.exports = router;
