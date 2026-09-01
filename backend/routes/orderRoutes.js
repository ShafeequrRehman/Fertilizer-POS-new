const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const { checkPendingOrder, createOrder, getOrder, getOrders, updateOrder, cancelOrder, extendTableTimer, clearTableTimer } = require("../controllers/orderController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/", getOrders);
router.post("/", createOrder);
router.get("/pending/:phone", checkPendingOrder);
router.get("/:id", getOrder);
router.patch("/:id", updateOrder);
router.post("/:id/cancel", cancelOrder);
router.post("/:id/extend-timer", extendTableTimer);
router.post("/:id/clear-table", clearTableTimer);

module.exports = router;
