const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requireAnyPermission = require("../middleware/requireAnyPermission");
const {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getIngredients,
  getIngredient,
  createIngredient,
  updateIngredient,
  restockIngredient,
  deleteIngredient,
  getIngredientLedger,
} = require("../controllers/ingredientController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

// Everything here accepts EITHER "inventory.manage" - the same permission
// key that already covers Manage Products (see permissions.js), since raw
// ingredient stock is squarely part of that same "Inventory" module - OR
// the narrower "stock.manage" (Stock Manager role, which should reach
// Ingredient Stock without also gaining Recipe Management, unlike
// inventory.manage - see requireAnyPermission.js's own comment).
router.use(requireAnyPermission("inventory.manage", "stock.manage"));

// NOTE: "/categories" must stay registered before "/:id" for the same
// reason tableRoutes.js's "/settings" does - Express matches route
// patterns in registration order, and "/:id" would otherwise swallow
// "/categories" as if it were an ingredient id.
router.get("/categories", getCategories);
router.post("/categories", createCategory);
router.patch("/categories/:id", updateCategory);
router.delete("/categories/:id", deleteCategory);

router.get("/", getIngredients);
router.post("/", createIngredient);
router.get("/:id", getIngredient);
router.patch("/:id", updateIngredient);
router.patch("/:id/restock", restockIngredient);
router.get("/:id/ledger", getIngredientLedger);
router.delete("/:id", deleteIngredient);

module.exports = router;
