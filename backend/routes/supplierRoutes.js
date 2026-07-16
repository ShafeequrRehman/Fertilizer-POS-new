const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const ctrl = require("../controllers/supplierController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/", ctrl.getSuppliers);
router.get("/:id", ctrl.getSupplier);
router.post("/", requirePermission("suppliers.manage"), ctrl.createSupplier);
router.patch("/:id", requirePermission("suppliers.manage"), ctrl.updateSupplier);
router.delete("/:id", requirePermission("suppliers.manage"), ctrl.deleteSupplier);

module.exports = router;
