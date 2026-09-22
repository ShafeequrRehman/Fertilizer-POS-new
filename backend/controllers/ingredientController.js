const mongoose = require("mongoose");
const IngredientCategory = require("../models/IngredientCategory");
const Ingredient = require("../models/Ingredient");
const Recipe = require("../models/Recipe");
const IngredientPurchase = require("../models/IngredientPurchase");
const Order = require("../models/Order");
const { shopScope } = require("../middleware/attachShopScope");
const { escapeRegex } = require("../utils/escapeRegex");
const { INGREDIENT_UNITS, UNIT_FAMILY, toMilliUnits, fromMilliUnits } = require("../config/ingredientUnits");

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
  // Safe Math Addition Logic (floating-point round-off fix) - same
  // integer-milli-unit round-trip as stockService.js/
  // ingredientPurchaseController.js (see ingredientUnits.js's own comment),
  // so a manual restock/wastage-correction entry can't reintroduce the
  // same drift plain `+`/`-` on the raw fractional numbers would.
  const beforeMilli = toMilliUnits(ingredient.currentStock);
  const deltaMilli = toMilliUnits(quantity);
  ingredient.currentStock = Math.max(fromMilliUnits(beforeMilli + deltaMilli), 0);
  await ingredient.save();
  res.json(ingredient);
};

exports.deleteIngredient = async (req, res) => {
  const ingredient = await Ingredient.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!ingredient) return res.status(404).json({ error: "Ingredient not found" });
  res.json({ message: "Ingredient deleted", id: req.params.id });
};

// GET /api/ingredients/:id/ledger
//
// Per-Ingredient Stock Khata - the Stock Manager's own ask: clicking the
// History icon on a stock item (IngredientStockSection.tsx, which used to
// only show that COMPANY's purchase-order history) should instead show a
// full ledger of "kis se kitna purchase kiya aur kitna kis ko sale kiya" -
// same shape as Customer/Bank's own khata (an in/out entry list with a
// running balance column), just for this one ingredient's stock instead of
// money. Two sources, merged and sorted chronologically:
//   - IN:  every received IngredientPurchase batch of this ingredient
//          (who it was bought from, how much).
//   - OUT: every non-cancelled Order whose stockDeductions (see
//          Order.js's own comment - the frozen per-order record of exactly
//          how much of each ingredient that order's items actually
//          consumed, written once by services/stockService.js at creation
//          and never recomputed later) includes this ingredient.
// Running Remaining is computed oldest-first purely from these two
// sources, then the WHOLE series is shifted by a single constant offset
// so the most recent row always lands exactly on Ingredient.currentStock -
// the same "always reconciles to the real current balance on the last
// row" approach DuesPage.tsx's own Dues Statement replay uses, needed here
// because a plain quantity-only restock (exports.restockIngredient above)
// moves currentStock without leaving a ledger entry of its own.
exports.getIngredientLedger = async (req, res) => {
  try {
    const scope = shopScope(req);
    const ingredient = await Ingredient.findOne({ _id: req.params.id, ...scope }).lean();
    if (!ingredient) return res.status(404).json({ error: "Ingredient not found" });

    const [purchases, orders] = await Promise.all([
      IngredientPurchase.find({ ...scope, ingredientId: ingredient._id, status: "received" })
        .select("purchaseOrderNumber companyName quantity rate totalAmount purchaseDate receivedAt")
        .lean(),
      Order.find({ ...scope, status: { $ne: "cancelled" }, "stockDeductions.ingredientId": ingredient._id })
        .select("dailyOrderNumber shopSequenceNumber customer createdAt stockDeductions")
        .lean(),
    ]);

    const entries = [];
    for (const purchase of purchases) {
      entries.push({
        date: purchase.receivedAt || purchase.purchaseDate,
        type: "purchase",
        label: purchase.purchaseOrderNumber || "Purchase",
        detail: purchase.companyName || "Unspecified supplier",
        quantity: Number(purchase.quantity || 0),
        direction: "in",
        rate: purchase.rate || 0,
        totalAmount: purchase.totalAmount || 0,
      });
    }
    for (const order of orders) {
      const deduction = (order.stockDeductions || []).find((d) => String(d.ingredientId) === String(ingredient._id));
      if (!deduction || !(deduction.quantity > 0)) continue;
      entries.push({
        date: order.createdAt,
        type: "sale",
        label: `Order #${order.dailyOrderNumber ?? order.shopSequenceNumber ?? String(order._id).slice(-4)}`,
        detail: order.customer?.name || "Walk-in Customer",
        quantity: Number(deduction.quantity || 0),
        direction: "out",
      });
    }

    entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let running = 0;
    for (const entry of entries) {
      running += entry.direction === "in" ? entry.quantity : -entry.quantity;
      entry.runningBeforeOffset = running;
    }
    // Shift the whole series so the most recent row reconciles exactly to
    // the ingredient's real current stock - see this function's own header
    // comment on why (untracked manual restocks/corrections).
    const offset = entries.length > 0 ? Number(ingredient.currentStock || 0) - running : 0;
    for (const entry of entries) {
      entry.remaining = Math.round((entry.runningBeforeOffset + offset) * 1000) / 1000;
      delete entry.runningBeforeOffset;
    }

    entries.reverse(); // newest-first, same convention as every other khata in this app

    res.json({
      ingredient: {
        id: String(ingredient._id),
        name: ingredient.name,
        unit: ingredient.unit,
        currentStock: ingredient.currentStock,
        averageCost: ingredient.averageCost,
      },
      entries,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
