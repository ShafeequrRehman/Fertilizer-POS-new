const IngredientCategory = require("../models/IngredientCategory");
const Ingredient = require("../models/Ingredient");
const Recipe = require("../models/Recipe");
const { shopScope } = require("../middleware/attachShopScope");
const { escapeRegex } = require("../utils/escapeRegex");
const { INGREDIENT_UNITS, UNIT_FAMILY } = require("../config/ingredientUnits");

// ---------------------------------------------------------------------
// Ingredient Categories (Task 1: "the Stock Manager can categorize these
// ingredients so daily/monthly incoming stock can be managed by category")
// ---------------------------------------------------------------------

exports.getCategories = async (req, res) => {
  const categories = await IngredientCategory.find({ ...shopScope(req) }).sort({ name: 1 }).lean();
  res.json(categories);
};

exports.createCategory = async (req, res) => {
  try {
    const category = await IngredientCategory.create({
      name: String(req.body?.name || "").trim(),
      shopId: req.user.shopId,
    });
    res.status(201).json(category);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "A category with this name already exists." });
    }
    res.status(500).json({ error: error.message });
  }
};

exports.updateCategory = async (req, res) => {
  const { shopId, ...updates } = req.body;
  try {
    const category = await IngredientCategory.findOneAndUpdate(
      { _id: req.params.id, ...shopScope(req) },
      updates,
      { new: true, runValidators: true }
    );
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json(category);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "A category with this name already exists." });
    }
    res.status(500).json({ error: error.message });
  }
};

// Deleting a category never deletes the ingredients in it - they just
// become uncategorized (categoryId: null), same "don't cascade-delete
// someone's stock data because they renamed/removed a folder" reasoning as
// leaving a Product's `category` string alone when nothing else changes it.
exports.deleteCategory = async (req, res) => {
  const category = await IngredientCategory.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!category) return res.status(404).json({ error: "Category not found" });
  await Ingredient.updateMany({ categoryId: category._id, ...shopScope(req) }, { categoryId: null });
  res.json({ message: "Category deleted", id: req.params.id });
};

// ---------------------------------------------------------------------
// Ingredients (Task 1: "add raw items/ingredients to the inventory in
// grams or milliliters")
// ---------------------------------------------------------------------

exports.getIngredients = async (req, res) => {
  const { search, categoryId } = req.query;
  const query = { ...shopScope(req) };
  if (categoryId) query.categoryId = categoryId;
  if (search) {
    query.name = { $regex: escapeRegex(search), $options: "i" };
  }
  // .lean() - read-only list, loaded on every Ingredient Stock page open and
  // every Recipe Management ingredient picker, same reasoning as
  // productController.getProducts.
  const ingredients = await Ingredient.find(query).sort({ name: 1 }).lean();
  res.json(ingredients);
};

exports.getIngredient = async (req, res) => {
  const ingredient = await Ingredient.findOne({ _id: req.params.id, ...shopScope(req) }).lean();
  if (!ingredient) return res.status(404).json({ error: "Ingredient not found" });
  res.json(ingredient);
};

exports.createIngredient = async (req, res) => {
  try {
    const { name, unit, categoryId, currentStock, lowStockThreshold } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Ingredient name is required." });
    }
    if (!INGREDIENT_UNITS.includes(unit)) {
      return res.status(400).json({ error: `Unit must be one of: ${INGREDIENT_UNITS.join(", ")}.` });
    }
    const ingredient = await Ingredient.create({
      name: String(name).trim(),
      unit,
      categoryId: categoryId || null,
      currentStock: Math.max(Number(currentStock) || 0, 0),
      lowStockThreshold: Math.max(Number(lowStockThreshold) || 0, 0),
      shopId: req.user.shopId,
    });
    res.status(201).json(ingredient);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "An ingredient with this name already exists." });
    }
    res.status(500).json({ error: error.message });
  }
};

// General edit - name/unit/category/threshold, and (for manual
// corrections, e.g. a stock-take) currentStock itself. Prefer
// exports.restockIngredient below for a normal "stock just came in" entry -
// that one adds to the running balance instead of overwriting it, which is
// what actually matches how a Stock Manager thinks about receiving a daily/
// monthly delivery.
exports.updateIngredient = async (req, res) => {
  const { shopId, ...updates } = req.body;
  if (updates.unit !== undefined && !INGREDIENT_UNITS.includes(updates.unit)) {
    return res.status(400).json({ error: `Unit must be one of: ${INGREDIENT_UNITS.join(", ")}.` });
  }
  if (updates.currentStock !== undefined) {
    updates.currentStock = Math.max(Number(updates.currentStock) || 0, 0);
  }
  if (updates.lowStockThreshold !== undefined) {
    updates.lowStockThreshold = Math.max(Number(updates.lowStockThreshold) || 0, 0);
  }
  // Bug fix (recipe/ingredient unit drift - see stockService.js's
  // deductStockForItems for the full story): a Recipe line's unit is only
  // ever validated against THIS ingredient's unit at the moment the recipe
  // is saved. Letting the ingredient's own unit later change to a
  // different measurement FAMILY (count "pcs" <-> weight "g"/"kg" <->
  // volume "ml"/"l") behind an existing recipe's back leaves that recipe
  // silently deducting the wrong amount forever after - exactly what was
  // happening for Burger-style ingredients (commonly count-tracked at
  // first, then switched to weight-tracked for accurate stock alerts).
  // Changing within the SAME family (e.g. kg -> g) stays allowed - every
  // recipe line referencing it is still dimensionally compatible either
  // way (see getRecipeUnitOptions/convertQuantity).
  if (updates.unit !== undefined) {
    const existing = await Ingredient.findOne({ _id: req.params.id, ...shopScope(req) }).lean();
    if (existing && UNIT_FAMILY[updates.unit] !== UNIT_FAMILY[existing.unit]) {
      const referencingRecipeCount = await Recipe.countDocuments({
        ...shopScope(req),
        "ingredients.ingredientId": existing._id,
      });
      if (referencingRecipeCount > 0) {
        return res.status(400).json({
          error: `Can't change "${existing.name}" from ${existing.unit} to ${updates.unit} - ${referencingRecipeCount} recipe${referencingRecipeCount === 1 ? "" : "s"} still use${referencingRecipeCount === 1 ? "s" : ""} it in a different measurement type. Update or remove those recipes in Recipe Management first, then change the unit.`,
        });
      }
    }
  }
  try {
    const ingredient = await Ingredient.findOneAndUpdate(
      { _id: req.params.id, ...shopScope(req) },
      updates,
      { new: true, runValidators: true }
    );
    if (!ingredient) return res.status(404).json({ error: "Ingredient not found" });
    res.json(ingredient);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "An ingredient with this name already exists." });
    }
    res.status(500).json({ error: error.message });
  }
};

// PATCH /api/ingredients/:id/restock  body: { quantity, note? }
// The Stock Manager's "daily/monthly incoming stock" entry point (Task 1) -
// adds `quantity` (in the ingredient's own unit) to the running
// currentStock rather than replacing it, and accepts a negative quantity
// for manual wastage/correction write-offs (clamped so the balance itself
// never goes below 0). `note` isn't persisted anywhere yet - accepted now
// so the frontend/a future stock-ledger feature has somewhere to put it
// without another endpoint shape change.
exports.restockIngredient = async (req, res) => {
  const quantity = Number(req.body?.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) {
    return res.status(400).json({ error: "A non-zero quantity is required." });
  }
  const ingredient = await Ingredient.findOne({ _id: req.params.id, ...shopScope(req) });
  if (!ingredient) return res.status(404).json({ error: "Ingredient not found" });
  ingredient.currentStock = Math.max(Number(ingredient.currentStock || 0) + quantity, 0);
  await ingredient.save();
  res.json(ingredient);
};

exports.deleteIngredient = async (req, res) => {
  const ingredient = await Ingredient.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!ingredient) return res.status(404).json({ error: "Ingredient not found" });
  res.json({ message: "Ingredient deleted", id: req.params.id });
};
