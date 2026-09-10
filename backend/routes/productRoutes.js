const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const requireAnyPermission = require("../middleware/requireAnyPermission");
const { createProduct, deleteProduct, getProduct, getProducts, updateProduct } = require("../controllers/productController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// Broken Access Control fix, reads (GET): deliberately left open to any
// shop member, unlike orderRoutes.js/customerRoutes.js's own equivalent
// fix. DashboardShell.tsx's kitchen-print category-lookup poller (see
// buildCategoryLookup) calls GET /products on EVERY dashboard page for
// EVERY logged-in employee regardless of role - it's shared, page-agnostic
// infrastructure, not something reachable only via a specific page/URL, so
// there is no single permission that could gate it here without breaking
// kitchen-ticket routing for roles that hold none of POS/Sales/Inventory's
// own permissions.
//
// Writes: create/update also happen outside Inventory - AddItemsManager.tsx
// (SalesPage's "Add Items To Order" modal) lets a cashier define a brand
// new product/price inline while building an order, so sales.create/
// sales.edit have to be accepted here too, not just inventory.manage.
// Delete has no such caller (nothing outside Product Management removes a
// product outright), so it stays narrowly inventory.manage-only.
router.get("/", getProducts);
router.post("/", requireAnyPermission("inventory.manage", "sales.create", "sales.edit"), createProduct);
router.get("/:id", getProduct);
router.patch("/:id", requireAnyPermission("inventory.manage", "sales.create", "sales.edit"), updateProduct);
router.delete("/:id", requirePermission("inventory.manage"), deleteProduct);

module.exports = router;
