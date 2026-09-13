const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const { getRecipes } = require("../controllers/recipeController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);
router.use(requirePermission("inventory.manage"));

// The Recipe Management admin page (create/edit/delete a recipe) has been
// removed - see recipeController.js's own comment. Only the read-only list
// stays, since stock deduction and the offline ingredient cache still need
// it.
router.get("/", getRecipes);

module.exports = router;
