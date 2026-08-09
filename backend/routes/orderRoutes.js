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
  getUnprintedKitchenUpdateOrders,
  claimKitchenUpdatePrint,
} = require("../controllers/orderController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/", getOrders);
router.post("/", createOrder);
router.get("/pending/:phone", checkPendingOrder);
// Must come before the generic "/:id" GET below, or Express would try to
// treat "kitchen"/"receipts"/"kitchen-updates" as an order id.
router.get("/kitchen/unprinted", getUnprintedKitchenOrders);
router.get("/receipts/unprinted", getUnprintedReceiptOrders);
router.get("/kitchen-updates/unprinted", getUnprintedKitchenUpdateOrders);
router.get("/:id", getOrder);
router.patch("/:id", updateOrder);
router.patch("/:id/claim-kitchen-print", claimKitchenPrint);
router.patch("/:id/claim-receipt-print", claimReceiptPrint);
router.patch("/:id/claim-kitchen-update-print", claimKitchenUpdatePrint);
router.post("/:id/cancel", cancelOrder);

module.exports = router;
