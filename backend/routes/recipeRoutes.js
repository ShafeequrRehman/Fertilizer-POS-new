const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const {
  getRecipes,
  getRecipeForProduct,
  upsertRecipeForProduct,
  deleteRecipeForProduct,
} = require("../controllers/recipeController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);
router.use(requirePermission("inventory.manage"));

router.get("/", getRecipes);
router.get("/product/:productId", getRecipeForProduct);
router.put("/product/:productId", upsertRecipeForProduct);
router.delete("/product/:productId", deleteRecipeForProduct);

module.exports = router;
