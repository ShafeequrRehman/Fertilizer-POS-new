const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const bankController = require("../controllers/bankController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// Reuses dues.manage rather than a brand-new permission key: the Bank
// page exists specifically to back Customer Dues payments made "via Bank"
// (see customerController.js), so whoever can already adjust/settle a
// customer's dues is exactly who should manage the shop's own bank
// ledger too.
router.get("/", requirePermission("dues.manage"), bankController.getBanks);
router.post("/", requirePermission("dues.manage"), bankController.createBank);
router.post("/:id/transactions", requirePermission("dues.manage"), bankController.addTransaction);

module.exports = router;
