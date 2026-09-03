const mongoose = require("mongoose");

// Groups raw ingredients for the Stock Manager (e.g. "Pizza Items", "Burger
// Items") so incoming daily/monthly stock can be reviewed and topped up a
// category at a time instead of scrolling one long flat ingredient list.
// Deliberately its own collection (not a free-text `category` string on
// Ingredient, unlike Product.category) so renaming a category updates every
// ingredient in it at once, and so the Ingredient Stock screen can offer a
// real dropdown of existing categories the same way Products does for its
// own category field.
const ingredientCategorySchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ingredientCategorySchema.index({ shopId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("IngredientCategory", ingredientCategorySchema);
