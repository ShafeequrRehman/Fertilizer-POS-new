const Recipe = require("../models/Recipe");
const { shopScope } = require("../middleware/attachShopScope");

// GET /api/recipes - every recipe this shop has defined, newest product
// first. The dedicated Recipe Management admin UI (which used to read/
// write individual recipes via /product/:productId) has been removed, but
// this list endpoint stays: services/stockService.js's automatic
// ingredient-stock deduction on every order still depends on each
// product's recipe existing in MongoDB (queried directly there, not via
// this API), and the offline sync snapshot (offline-sync.ts's
// pushIngredientsCache, consumed by IngredientStockSection.tsx's offline
// consumption estimate) still calls this same endpoint to cache recipes
// for use with no internet.
exports.getRecipes = async (req, res) => {
  const recipes = await Recipe.find({ ...shopScope(req) }).sort({ productName: 1, variation: 1 }).lean();
  res.json(recipes);
};
