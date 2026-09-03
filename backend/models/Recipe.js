const mongoose = require("mongoose");
const { INGREDIENT_UNITS } = require("../config/ingredientUnits");

// One line of a recipe: "this many grams/kg/ml/l/pcs of this ingredient go
// into one unit of the parent product". `unit` defaults to the ingredient's
// own base unit at save time (see recipeController.upsertRecipeForProduct),
// but Sub-Unit Support means it can also be that ingredient's registered
// finer sub-unit instead - g for a kg-tracked ingredient, ml for an
// l-tracked one (see config/ingredientUnits.js's getRecipeUnitOptions) -
// never anything outside that pair, which is what keeps
// stockService.js's convertQuantity able to always convert a line back into
// the live Ingredient's real base unit before ever touching currentStock.
const recipeIngredientSchema = new mongoose.Schema(
  {
    ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: "Ingredient", required: true },
    ingredientName: { type: String, required: true },
    unit: { type: String, enum: INGREDIENT_UNITS, required: true },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// A Recipe is keyed 1:1 to a single Product document - and since each
// size/variation of a menu item is already its OWN Product document (see
// Product.js/productController.js's own comment: "Small Chicken Pizza" and
// "Large Chicken Pizza" are two separate rows), a Recipe is automatically
// per-size just by being per-product. There is deliberately no separate
// "recipe group" concept - Task 2's Small/Large/XL example is just three
// Recipe documents, one per Product._id.
//
// productName/variation are denormalized from the Product at save time.
// Order.items (models/Order.js) never carries a productId - only
// name/variation/price/quantity, the same shape every other name-based
// matching in this codebase already relies on (see
// kitchen-print-routing.ts's buildCategoryLookup, matched the same way on
// the frontend). services/stockService.js builds a
// `${name}::${variation}` lookup map from every one of a shop's Recipes for
// exactly this reason - keeping productId as the source of truth here,
// while still being able to resolve a plain order line straight to its
// recipe without a second round-trip to Product.
const recipeSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },
    variation: { type: String, default: "" },
    ingredients: { type: [recipeIngredientSchema], default: [] },
  },
  { timestamps: true }
);

recipeSchema.index({ shopId: 1, productId: 1 }, { unique: true });
// Matches the exact lookup stockService.js runs at order time - see its
// buildRecipeLookup, which loads every one of a shop's recipes and keys
// them the same way in memory. This index just keeps that shop-wide load
// itself fast as recipes accumulate.
recipeSchema.index({ shopId: 1, productName: 1, variation: 1 });

module.exports = mongoose.model("Recipe", recipeSchema);
