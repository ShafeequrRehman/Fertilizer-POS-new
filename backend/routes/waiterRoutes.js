const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const { getWaiters } = require("../controllers/waiterController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// Read-only: waiters/order takers are now added and edited exclusively
// from the Manage Staff page (see waiterController.js for why).
router.get("/", getWaiters);

module.exports = router;
