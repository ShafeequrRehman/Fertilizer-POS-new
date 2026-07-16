const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const ctrl = require("../controllers/purchaseController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/", ctrl.getPurchases);
router.get("/:id", ctrl.getPurchase);
router.post("/", requirePermission("purchases.manage"), ctrl.createPurchase);
router.patch("/:id", requirePermission("purchases.manage"), ctrl.updatePurchase);
router.delete("/:id", requirePermission("purchases.manage"), ctrl.deletePurchase);

module.exports = router;
