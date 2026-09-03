const mongoose = require("mongoose");
const { INGREDIENT_UNITS } = require("../config/ingredientUnits");

// A raw stock item the Stock Manager tracks by weight/volume/count (Cheese,
// Chicken, Jalapeno, Beef, Sauce, Pizza Boxes, ...) - distinct from
// Product.stock, which counts finished, sellable menu items/units.
// `currentStock` is always in `unit` (grams/kg, millilitres/litres, or
// "pcs" for unit-less items - see config/ingredientUnits.js - never mixed
// for the same ingredient), and is the single running balance every
// restock (see ingredientController.restockIngredient) and every
// recipe-driven sale deduction (see services/stockService.js) reads and
// writes. Clamped at 0 everywhere it's decremented - this tracks what's
// actually on the shelf, never a negative "owed" balance.
const ingredientSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, enum: INGREDIENT_UNITS, required: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "IngredientCategory", default: null },
    currentStock: { type: Number, default: 0, min: 0 },
    // Weighted-average purchase cost per unit (per single g/kg/ml/l/pcs -
    // whichever this ingredient is tracked in), updated
    // ONLY by ingredientPurchaseController.createPurchase - never by a
    // plain quantity-only restock (restockIngredient), which has no rate to
    // fold in. Formula: newAverage = (oldStock*oldAverage + qty*rate) /
    // (oldStock+qty) - see createPurchase's own comment. This is what
    // services/stockService.js reads at sale time to compute an order's
    // real-time costPrice (Task 2 of Recipe/Stock Management), and never
    // changes just from selling/consuming stock - only a new purchase batch
    // moves it.
    averageCost: { type: Number, default: 0, min: 0 },
    // Optional - purely for the Stock Manager's own "running low" banner
    // (see IngredientStockSection.tsx). Never blocks a sale on its own;
    // nothing in the order flow reads this.
    lowStockThreshold: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ingredientSchema.index({ shopId: 1, name: 1 }, { unique: true });
ingredientSchema.index({ shopId: 1, categoryId: 1 });

module.exports = mongoose.model("Ingredient", ingredientSchema);
