const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const { getWaiters, createWaiter, updateWaiter, deleteWaiter } = require("../controllers/waiterController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/", getWaiters);
router.post("/", createWaiter);
router.patch("/:id", updateWaiter);
router.delete("/:id", deleteWaiter);

module.exports = router;
