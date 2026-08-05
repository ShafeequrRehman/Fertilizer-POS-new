const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const {
  checkPendingOrder,
  createOrder,
  getOrder,
  getOrders,
  updateOrder,
  cancelOrder,
  getUnprintedKitchenOrders,
  claimKitchenPrint,
  getUnprintedReceiptOrders,
  claimReceiptPrint,
} = require("../controllers/orderController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/", getOrders);
router.post("/", createOrder);
router.get("/pending/:phone", checkPendingOrder);
// Must come before the generic "/:id" GET below, or Express would try to
// treat "kitchen"/"receipts" as an order id.
router.get("/kitchen/unprinted", getUnprintedKitchenOrders);
router.get("/receipts/unprinted", getUnprintedReceiptOrders);
router.get("/:id", getOrder);
router.patch("/:id", updateOrder);
router.patch("/:id/claim-kitchen-print", claimKitchenPrint);
router.patch("/:id/claim-receipt-print", claimReceiptPrint);
router.post("/:id/cancel", cancelOrder);

module.exports = router;
