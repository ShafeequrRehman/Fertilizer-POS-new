const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const requireAnyPermission = require("../middleware/requireAnyPermission");
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
  importOfflineOrders,
  importOfflineOrderUpdates,
  importOfflineCancellations,
  updateTrackingStatus,
  assignRider,
  respondToChangeRequest,
} = require("../controllers/orderController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// Broken Access Control fix: every route below used to stop at
// requireShopMember - "logged in as SOME employee of this shop", not "has
// the specific permission this action needs". A Cashier's sidebar link to
// e.g. Purchase is hidden, but nothing stopped their token from reading or
// writing order data directly via the API either - exactly the "hide the
// link, forget the endpoint" gap this pass closes app-wide (see also
// productController.js/purchaseRoutes.js/etc. for the same pattern already
// used elsewhere). Read access is granted to any permission whose PAGE
// legitimately calls these same endpoints today (see pos-api.ts's own
// callers): sales.create (POS/Sales), orders.record.view (Record),
// view.dashboard (the Dashboard home's own order-summary read). Deliberately
// NOT gating the kitchen/receipts/kitchen-updates "unprinted" + claim-*
// endpoints or the import-offline* sync endpoints below - those are
// till-level print-queue/offline-sync machinery (see DashboardShell.tsx,
// which polls the unprinted-ticket endpoints on EVERY dashboard page
// regardless of the logged-in employee's role, since the printer is
// physically attached to the till, not to a specific permission) rather
// than a page a person navigates to, so gating them by permission would
// break kitchen printing on a till logged in as, say, a pure Accountant.
const canReadOrders = requireAnyPermission("sales.create", "orders.record.view", "view.dashboard");

router.get("/", canReadOrders, getOrders);
// Ring up a new order - the exact action sales.create's own catalog
// description ("Ring up new orders at the POS screen") names.
router.post("/", requirePermission("sales.create"), createOrder);
// Offline sync engine (see pos-web/src/lib/offline-sync.ts) - must come
// before the generic "/:id" GET below, same reason as the kitchen/receipts
// routes. Left ungated - see the comment above canReadOrders.
router.post("/import-offline", importOfflineOrders);
router.post("/import-offline-updates", importOfflineOrderUpdates);
// Gated by sales.delete, same as the live POST /:id/cancel below - this is
// the offline-replay path for the exact same action, so it needs the same
// permission. This one used to lean on the Cancel Order Key itself as the
// real authorization here; now that cancelOrderCore no longer requires
// that key (the shop owner asked to drop it - see cancelOrderCore's own
// comment), this permission check is what actually stops a till without
// sales.delete from cancelling orders through this route.
router.post("/import-offline-cancellations", requirePermission("sales.delete"), importOfflineCancellations);
router.get("/pending/:phone", canReadOrders, checkPendingOrder);
// Must come before the generic "/:id" GET below, or Express would try to
// treat "kitchen"/"receipts"/"kitchen-updates" as an order id. Left
// ungated - see the comment above canReadOrders.
router.get("/kitchen/unprinted", getUnprintedKitchenOrders);
router.get("/receipts/unprinted", getUnprintedReceiptOrders);
router.get("/kitchen-updates/unprinted", getUnprintedKitchenUpdateOrders);
router.get("/:id", canReadOrders, getOrder);
// Add items, change details, or complete/settle payment on a pending order
// - anyone who can either create sales (checkout is part of that same POS
// workflow) or edit sales can reach this.
router.patch("/:id", requireAnyPermission("sales.create", "sales.edit"), updateOrder);
// Print-claim endpoints - till-level, left ungated, see canReadOrders' comment.
router.patch("/:id/claim-kitchen-print", claimKitchenPrint);
router.patch("/:id/claim-receipt-print", claimReceiptPrint);
router.patch("/:id/claim-kitchen-update-print", claimKitchenUpdatePrint);
router.patch("/:id/tracking-status", requireAnyPermission("sales.create", "sales.edit"), updateTrackingStatus);
router.patch("/:id/assign-rider", requireAnyPermission("sales.create", "sales.edit"), assignRider);
router.patch("/:id/change-request", requireAnyPermission("sales.create", "sales.edit"), respondToChangeRequest);
// Cancelling a sale is its own catalog permission. This used to sit on top
// of the shop-wide Cancel Order Key required inside cancelOrderCore itself
// as a second, defense-in-depth layer - the shop owner asked to drop that
// key step, so this permission check is now the real (and only) gate.
router.post("/:id/cancel", requirePermission("sales.delete"), cancelOrder);

module.exports = router;
