const Recipe = require("../models/Recipe");
const Ingredient = require("../models/Ingredient");
const { convertQuantity, UNIT_FAMILY } = require("../config/ingredientUnits");

// Order.items (see models/Order.js) never carries a productId - only
// name/variation/price/quantity, the same shape kitchen-print-routing.ts's
// buildCategoryLookup already matches products by on the frontend. This is
// the backend equivalent: a case-insensitive `${name}::${variation}` key so
// "Chicken Pizza" / "Large" resolves to exactly the Recipe saved against
// that specific Product document (see Recipe.js's own comment on why a
// recipe is naturally per-size just by being per-Product).
function recipeKey(name, variation) {
  return `${String(name || "").trim().toLowerCase()}::${String(variation || "").trim().toLowerCase()}`;
}

async function buildRecipeLookup(shopId) {
  const recipes = await Recipe.find({ shopId }).lean();
  const map = new Map();
  for (const recipe of recipes) {
    map.set(recipeKey(recipe.productName, recipe.variation), recipe);
  }
  return map;
}

// Task 3 (Recipe/Stock Management): "the backend must look up the exact
// recipe... and automatically deduct [ingredients] from the current
// inventory stock in real time." Also Task 2 (Purchasing/Financial Logic):
// "the system calculates its exact product cost based on the recipe
// ingredients and their current purchase rates" - returned as
// `costPrice`, the total ingredient cost of everything this order actually
// consumed, priced at each ingredient's live averageCost. Called BEFORE
// the Order document is created (see orderController.js's
// createOrder/importOfflineOrders), so its returned `deductions`/
// `costPrice` can be saved directly onto the new order's own
// stockDeductions/costPrice fields in the same Order.create call - that
// snapshot is what restoreStockForOrder below reverses on cancellation,
// deliberately re-reading it from the order itself rather than
// recomputing against whatever the recipe/cost looks like NOW (which may
// have changed since).
//
// Never throws. Ingredient stock is real-world, physical inventory - a
// missing recipe, a deleted ingredient, or a shortage must never block a
// sale from going through (the same principle createOrder already applies
// to its own customer-contact-sync step, which also only ever produces a
// warning string, never a failure). Stock simply floors at 0 instead of
// going negative, and a shortage is surfaced back to the caller as
// `warning` so staff can see it and restock, not as an error.
async function deductStockForItems(items, shopId) {
  const result = { deductions: [], warning: null, costPrice: 0 };
  try {
    const orderItems = Array.isArray(items) ? items : [];
    if (orderItems.length === 0) return result;

    const recipeMap = await buildRecipeLookup(shopId);
    if (recipeMap.size === 0) return result;

    // Collapse every matched line, across every item on the order, into one
    // list of "still needs converting" entries per ingredient - a Pizza
    // recipe and a Combo recipe could easily both call for "Cheese", and
    // each ingredient should only be loaded/saved once per order regardless
    // of how many recipe lines reference it. Kept as raw {quantity, unit}
    // entries rather than summed here, because Sub-Unit Support means two
    // lines against the SAME ingredient can legitimately be in different
    // units (one recipe wrote "400g", another "0.5kg") - they can't be
    // added together until each is converted into the ingredient's own base
    // unit below, which needs the live Ingredient doc (not loaded yet here).
    const totals = new Map(); // ingredientId (string) -> Array<{ quantity, unit }>
    for (const item of orderItems) {
      const recipe = recipeMap.get(recipeKey(item.name, item.variation));
      if (!recipe) continue;
      const quantity = Number(item.quantity) || 0;
      if (quantity <= 0) continue;
      for (const line of recipe.ingredients || []) {
        const id = String(line.ingredientId);
        const rawQuantity = Number(line.quantity || 0) * quantity;
        if (rawQuantity <= 0) continue;
        if (!totals.has(id)) totals.set(id, []);
        totals.get(id).push({ quantity: rawQuantity, unit: line.unit });
      }
    }

    if (totals.size === 0) return result;

    const shortages = [];
    const driftedIngredientNames = [];
    for (const [ingredientId, entries] of totals) {
      const ingredient = await Ingredient.findOne({ _id: ingredientId, shopId });
      // Ingredient was deleted after the recipe was saved - skip it rather
      // than fail the whole order over one dangling reference.
      if (!ingredient) continue;

      // Automated Conversion & Mathematical Deduction Logic: every entry is
      // converted from whatever unit its own recipe line was saved in (its
      // own base unit, or a finer sub-unit like g/ml - see Sub-Unit Support
      // above) into THIS ingredient's actual base unit, before they're ever
      // summed or subtracted - e.g. a "400g" recipe line against a
      // kg-tracked ingredient converts to 0.4 here, so 1kg in stock becomes
      // exactly 0.6kg after deduction, never 600 (which would be 600kg).
      //
      // Bug fix (recipe/ingredient unit drift): recipeController.
      // upsertRecipeForProduct only ever validates a line's unit against
      // this exact ingredient's unit AT SAVE TIME. If the ingredient's own
      // `unit` is changed afterward (ingredientController.updateIngredient -
      // now guarded against this for a different measurement FAMILY, but
      // pre-existing recipes saved before that guard existed can still be
      // stale), the recipe line's saved unit can end up in a completely
      // different family than the ingredient's CURRENT one (e.g. a Burger
      // Patty first tracked by count "pcs", later switched to weight "g"
      // for accurate stock tracking - Pizza ingredients like dough/cheese/
      // sauce are almost always weight-tracked from day one, so they never
      // hit this). convertQuantity, by design, refuses to convert across
      // families and returns the entry's raw number completely
      // UNCONVERTED (1 "pcs" silently standing in for 1 "g") rather than
      // throwing - this was the real bug behind "Burger recipes not
      // subtracting the correct gram quantities": a wildly wrong (usually
      // far too small) deduction, not a rejected/failed one, so it went
      // unnoticed. Detected here and handled by instead treating that
      // entry's quantity as already expressed in the ingredient's CURRENT
      // unit (the same "best available assumption" recipeController.
      // upsertRecipeForProduct itself already makes when a line's unit is
      // omitted entirely) - never a perfect recovery of what was
      // originally intended, but always dimensionally consistent with
      // currentStock, and surfaced below as a warning so staff know to
      // re-open and re-save that recipe.
      //
      // Rounded to 6 decimal places purely to collapse floating-point
      // division noise (e.g. 400/1000 landing on 0.4000000000000001) -
      // still far finer than any real-world recipe measurement needs.
      let entryDrifted = false;
      const needed = Math.round(entries.reduce((sum, entry) => {
        if (UNIT_FAMILY[entry.unit] !== UNIT_FAMILY[ingredient.unit]) {
          entryDrifted = true;
          return sum + entry.quantity;
        }
        return sum + convertQuantity(entry.quantity, entry.unit, ingredient.unit);
      }, 0) * 1e6) / 1e6;
      if (entryDrifted) driftedIngredientNames.push(ingredient.name);

      const before = Number(ingredient.currentStock || 0);
      if (before < needed) {
        shortages.push(`${ingredient.name} (needed ${needed}${ingredient.unit}, had ${before}${ingredient.unit})`);
      }
      const actuallyDeducted = before - Math.max(before - needed, 0);
      // Task 2: real-time cost tracking. Priced using the ingredient's
      // averageCost as it stands RIGHT NOW - i.e. before this save, since
      // consuming stock never itself moves the average (only a new
      // purchase batch does, see Ingredient.js/ingredientPurchaseController).
      // Costed on what was ACTUALLY deducted, not the recipe's theoretical
      // `needed` amount - if a shortage meant less than the recipe called
      // for was really taken off the shelf, that's the true cost incurred,
      // same reasoning stockDeductions itself already uses.
      result.costPrice += actuallyDeducted * Number(ingredient.averageCost || 0);
      ingredient.currentStock = Math.max(before - needed, 0);
      await ingredient.save();
      // Record what was ACTUALLY taken off the shelf (clamped, same as
      // currentStock above) - not the theoretical `needed` amount - so a
      // later restore on cancellation can never hand back more than this
      // order really removed.
      result.deductions.push({ ingredientId: ingredient._id, quantity: actuallyDeducted });
    }

    const warnings = [];
    if (shortages.length > 0) {
      warnings.push(`This order used more of some ingredients than were in stock: ${shortages.join("; ")}. Please restock soon.`);
    }
    if (driftedIngredientNames.length > 0) {
      warnings.push(`These ingredients' recipe lines are out of date (unit changed since the recipe was saved) and may have deducted the wrong amount: ${driftedIngredientNames.join(", ")}. Re-open and re-save the affected recipe(s) in Recipe Management.`);
    }
    if (warnings.length > 0) result.warning = warnings.join(" ");
    result.costPrice = Math.round(result.costPrice * 100) / 100;
    return result;
  } catch (error) {
    console.error("Non-fatal: stock deduction failed while placing an order", error);
    result.warning = "The order was saved, but ingredient stock could not be updated automatically. Ask your admin to check the backend logs.";
    return result;
  }
}

// Reverses exactly the deductions recorded on an order's own
// `stockDeductions` (set at creation time by deductStockForItems above) -
// called when an order is cancelled (see orderController.js's
// cancelOrderCore) so ingredients that were never actually cooked/served
// go back into available stock. Deliberately additive with no upper clamp
// (unlike the deduction side, which floors at 0) - there's no real ceiling
// on how much of an ingredient can be "back in stock". Never throws, same
// non-fatal reasoning as deductStockForItems - a stock-restore hiccup must
// never block a cancellation the Cancel Order Key already authorized.
async function restoreStockForOrder(order) {
  try {
    const deductions = Array.isArray(order?.stockDeductions) ? order.stockDeductions : [];
    if (deductions.length === 0) return;
    for (const entry of deductions) {
      await Ingredient.findByIdAndUpdate(entry.ingredientId, { $inc: { currentStock: Number(entry.quantity) || 0 } });
    }
  } catch (error) {
    console.error("Non-fatal: stock restore failed while cancelling an order", order?._id, error);
  }
}

module.exports = { deductStockForItems, restoreStockForOrder };
