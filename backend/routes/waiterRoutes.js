const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const { getWaiters, getRiders } = require("../controllers/waiterController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// Read-only: waiters/order takers are now added and edited exclusively
// from the Manage Staff page (see waiterController.js for why).
router.get("/", getWaiters);
// Must come before "/" would ever be interpreted as a catch-all - it
// doesn't here since "/" is an exact match, but kept as its own route for
// clarity alongside it. See waiterController.getRiders.
router.get("/riders", getRiders);

module.exports = router;
