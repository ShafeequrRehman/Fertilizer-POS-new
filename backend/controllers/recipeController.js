const mongoose = require("mongoose");
const Recipe = require("../models/Recipe");
const Product = require("../models/Product");
const Ingredient = require("../models/Ingredient");
const { shopScope } = require("../middleware/attachShopScope");
const { getRecipeUnitOptions } = require("../config/ingredientUnits");

// GET /api/recipes - every recipe this shop has defined, newest product
// first. Used by RecipeManagementSection.tsx to show which of a product
// group's size variations already have a recipe configured, without a
// round-trip per variation.
exports.getRecipes = async (req, res) => {
  const recipes = await Recipe.find({ ...shopScope(req) }).sort({ productName: 1, variation: 1 }).lean();
  res.json(recipes);
};

// GET /api/recipes/product/:productId - the recipe for one specific
// size/variation (one Product document). Returns null (not 404) when none
// has been defined yet - "no recipe configured" is an expected, normal
// state for a brand new product, not an error.
exports.getRecipeForProduct = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.productId)) {
    return res.status(404).json({ error: "Product not found" });
  }
  const recipe = await Recipe.findOne({ productId: req.params.productId, ...shopScope(req) }).lean();
  res.json(recipe || null);
};

// PUT /api/recipes/product/:productId  body: { ingredients: [{ ingredientId, quantity, unit? }] }
// Task 2: "define the recipe for each food item based on its size" - since
// each size is already its own Product document, this defines/replaces the
// WHOLE recipe for exactly that one size in a single call (upsert), same
// "replace the full list, don't diff it" approach applyOrderPatch already
// uses for an order's replaceItems action.
//
// Sub-Unit Support: `unit` is optional per line and, when given, must be
// either the ingredient's own base unit or its registered finer sub-unit
// (g for a kg-tracked ingredient, ml for an l-tracked one - see
// getRecipeUnitOptions) - never anything else, since stockService.js's
// convertQuantity only ever knows how to convert within that exact pair.
// Omitting it defaults to the ingredient's own unit, same as every recipe
// saved before this feature existed.
exports.upsertRecipeForProduct = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.productId)) {
    return res.status(404).json({ error: "Product not found" });
  }

  const product = await Product.findOne({ _id: req.params.productId, ...shopScope(req) }).lean();
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }

  const rawIngredients = Array.isArray(req.body?.ingredients) ? req.body.ingredients : [];
  if (rawIngredients.length === 0) {
    return res.status(400).json({ error: "A recipe needs at least one ingredient." });
  }

  const ingredientIds = rawIngredients.map((line) => line.ingredientId).filter(Boolean);
  if (ingredientIds.length !== rawIngredients.length) {
    return res.status(400).json({ error: "Every recipe line needs an ingredient selected." });
  }

  // Loaded fresh from the DB (never trust the client's own name/unit) so a
  // renamed ingredient or a since-changed unit is always reflected
  // correctly in what gets denormalized onto the recipe below.
  const ingredients = await Ingredient.find({ _id: { $in: ingredientIds }, ...shopScope(req) }).lean();
  const ingredientMap = new Map(ingredients.map((ing) => [String(ing._id), ing]));

  const lines = [];
  for (const line of rawIngredients) {
    const ingredient = ingredientMap.get(String(line.ingredientId));
    if (!ingredient) {
      return res.status(400).json({ error: "One of the selected ingredients no longer exists." });
    }
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: `Enter a quantity greater than 0 for "${ingredient.name}".` });
    }
    const allowedUnits = getRecipeUnitOptions(ingredient.unit);
    const requestedUnit = line.unit || ingredient.unit;
    if (!allowedUnits.includes(requestedUnit)) {
      return res.status(400).json({ error: `Unit for "${ingredient.name}" must be one of: ${allowedUnits.join(", ")}.` });
    }
    lines.push({
      ingredientId: ingredient._id,
      ingredientName: ingredient.name,
      unit: requestedUnit,
      quantity,
    });
  }

  const recipe = await Recipe.findOneAndUpdate(
    { productId: product._id, ...shopScope(req) },
    {
      productId: product._id,
      productName: product.name,
      variation: product.variation || "",
      ingredients: lines,
      ...shopScope(req),
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

  res.json(recipe);
};

exports.deleteRecipeForProduct = async (req, res) => {
  const recipe = await Recipe.findOneAndDelete({ productId: req.params.productId, ...shopScope(req) });
  if (!recipe) return res.status(404).json({ error: "Recipe not found" });
  res.json({ message: "Recipe deleted", productId: req.params.productId });
};
