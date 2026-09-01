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
  extendTableTimer,
  clearTableTimer,
  getUnprintedKitchenOrders,
  claimKitchenPrint,
  getUnprintedReceiptOrders,
  claimReceiptPrint,
  getUnprintedKitchenUpdateOrders,
  claimKitchenUpdatePrint,
  importOfflineOrders,
  importOfflineOrderUpdates,
  importOfflineCancellations,
  getOccupiedDineInTables,
  updateTrackingStatus,
  assignRider,
  respondToChangeRequest,
} = require("../controllers/orderController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/", getOrders);
router.post("/", createOrder);
// Offline sync engine (see pos-web/src/lib/offline-sync.ts) - must come
// before the generic "/:id" GET below, same reason as the kitchen/receipts
// routes.
router.post("/import-offline", importOfflineOrders);
router.post("/import-offline-updates", importOfflineOrderUpdates);
router.post("/import-offline-cancellations", importOfflineCancellations);
router.get("/pending/:phone", checkPendingOrder);
// Must come before the generic "/:id" GET below, or Express would try to
// treat "kitchen"/"receipts"/"kitchen-updates" as an order id.
router.get("/kitchen/unprinted", getUnprintedKitchenOrders);
router.get("/receipts/unprinted", getUnprintedReceiptOrders);
router.get("/kitchen-updates/unprinted", getUnprintedKitchenUpdateOrders);
router.get("/dinein/occupied-tables", getOccupiedDineInTables);
router.get("/:id", getOrder);
router.patch("/:id", updateOrder);
router.patch("/:id/claim-kitchen-print", claimKitchenPrint);
router.patch("/:id/claim-receipt-print", claimReceiptPrint);
router.patch("/:id/claim-kitchen-update-print", claimKitchenUpdatePrint);
router.patch("/:id/tracking-status", updateTrackingStatus);
router.patch("/:id/assign-rider", assignRider);
router.patch("/:id/change-request", respondToChangeRequest);
router.post("/:id/cancel", cancelOrder);
router.post("/:id/extend-timer", extendTableTimer);
router.post("/:id/clear-table", clearTableTimer);

module.exports = router;
