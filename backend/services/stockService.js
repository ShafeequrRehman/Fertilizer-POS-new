const Recipe = require("../models/Recipe");
const Ingredient = require("../models/Ingredient");
const Product = require("../models/Product");
const { convertQuantity, UNIT_FAMILY, toMilliUnits, fromMilliUnits } = require("../config/ingredientUnits");

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

// Deal/Combo bug fix: a Deal is just a regular Product document with
// isDeal:true and a `dealItems` array of its component Products' own _ids
// (see Product.js/ProductManagementSection.tsx's checkbox picker) - there is
// deliberately no separate "Deal" model, and Recipe Management explicitly
// hides deal products from its own picker (a Deal has no ingredients of its
// own; its sub-products do). Order.items never carries a productId though -
// only name/variation/price/quantity, same as every other order line - so
// resolving "is this order line actually a deal, and if so what's inside it"
// needs its own name::variation-keyed lookup over every isDeal Product in
// the shop, built the same way buildRecipeLookup above builds its own.
async function buildDealProductLookup(shopId) {
  const deals = await Product.find({ shopId, isDeal: true }).select("name variation dealItems").lean();
  const map = new Map();
  for (const deal of deals) {
    map.set(recipeKey(deal.name, deal.variation), deal);
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

    // Deal/Combo bug fix: split this order's lines into ones that are
    // themselves a Deal product (matched against buildDealProductLookup
    // below) versus everything else, so a Deal's own component Pizza/Burger
    // recipes get resolved and deducted too - previously an order line for
    // "Family Deal 1" simply had no Recipe of its own (Recipe Management
    // hides deal products - see buildDealProductLookup's own comment) and
    // matched nothing in recipeMap, so a Deal order silently deducted
    // NOTHING at all.
    const dealMap = await buildDealProductLookup(shopId);
    const directOrderItems = [];
    const dealOrderEntries = []; // { item, deal }
    for (const item of orderItems) {
      const deal = dealMap.get(recipeKey(item.name, item.variation));
      if (deal) {
        dealOrderEntries.push({ item, deal });
      } else {
        directOrderItems.push(item);
      }
    }

    // Resolve every sub-product referenced by any ordered deal in ONE query,
    // rather than once per deal line - dealItems only stores each component
    // Product's own _id (see Product.js), so this is the only way to learn
    // ITS name+variation and look ITS OWN recipe up in recipeMap above.
    let subProductById = new Map();
    if (dealOrderEntries.length > 0) {
      const subProductIds = new Set();
      for (const { deal } of dealOrderEntries) {
        for (const id of deal.dealItems || []) subProductIds.add(String(id));
      }
      if (subProductIds.size > 0) {
        const subProducts = await Product.find({ _id: { $in: Array.from(subProductIds) }, shopId })
          .select("name variation")
          .lean();
        subProductById = new Map(subProducts.map((p) => [String(p._id), p]));
      }
    }

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
    function addRecipeToTotals(recipe, multiplier) {
      for (const line of recipe.ingredients || []) {
        const id = String(line.ingredientId);
        const rawQuantity = Number(line.quantity || 0) * multiplier;
        if (rawQuantity <= 0) continue;
        if (!totals.has(id)) totals.set(id, []);
        totals.get(id).push({ quantity: rawQuantity, unit: line.unit });
      }
    }

    for (const item of directOrderItems) {
      const recipe = recipeMap.get(recipeKey(item.name, item.variation));
      if (!recipe) continue;
      const quantity = Number(item.quantity) || 0;
      if (quantity <= 0) continue;
      addRecipeToTotals(recipe, quantity);
    }

    // Deal/Combo expansion: for each ordered deal line, count how many
    // times each component Product appears WITHIN one deal (today's
    // checkbox-picker UI can only ever pick each component once, but this
    // stays correct even if a future deal editor allows repeating one), then
    // deduct that component's own recipe scaled by
    // (how many deals were ordered) x (how many times it appears in the
    // deal) - exactly "multiply the recipe quantities by the ordered deal
    // count" from the bug report, just done per component instead of once
    // for the deal as a whole, since the deal itself has no recipe/ingredient
    // list of its own.
    for (const { item, deal } of dealOrderEntries) {
      const dealQuantity = Number(item.quantity) || 0;
      if (dealQuantity <= 0) continue;
      const subProductCounts = new Map(); // sub-product id -> occurrences within one deal
      for (const id of deal.dealItems || []) {
        const key = String(id);
        subProductCounts.set(key, (subProductCounts.get(key) || 0) + 1);
      }
      for (const [subProductId, countPerDeal] of subProductCounts) {
        const subProduct = subProductById.get(subProductId);
        if (!subProduct) continue; // component product deleted since the deal was built
        const recipe = recipeMap.get(recipeKey(subProduct.name, subProduct.variation));
        if (!recipe) continue; // no recipe configured for this component - nothing to deduct for it
        addRecipeToTotals(recipe, dealQuantity * countPerDeal);
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
      // Safe Math Deduction Logic (floating-point round-off fix) - see
      // toMilliUnits/fromMilliUnits's own comment in ingredientUnits.js.
      // `before` and `needed` are converted to integer milli-units BEFORE
      // ever being subtracted, so repeated deductions across many orders
      // can never drift into floating-point noise (e.g.
      // `58.499999999999996`) the way plain `before - needed` eventually
      // could - the stored/returned figure is always a clean multiple of
      // 0.001.
      const beforeMilli = toMilliUnits(before);
      const neededMilli = toMilliUnits(needed);
      const newStockMilli = Math.max(beforeMilli - neededMilli, 0);
      const actuallyDeducted = fromMilliUnits(beforeMilli - newStockMilli);
      // Task 2: real-time cost tracking. Priced using the ingredient's
      // averageCost as it stands RIGHT NOW - i.e. before this save, since
      // consuming stock never itself moves the average (only a new
      // purchase batch does, see Ingredient.js/ingredientPurchaseController).
      // Costed on what was ACTUALLY deducted, not the recipe's theoretical
      // `needed` amount - if a shortage meant less than the recipe called
      // for was really taken off the shelf, that's the true cost incurred,
      // same reasoning stockDeductions itself already uses.
      result.costPrice += actuallyDeducted * Number(ingredient.averageCost || 0);
      ingredient.currentStock = fromMilliUnits(newStockMilli);
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
//
// Fetch-then-save rather than a raw Mongo `$inc` - a bare `$inc` would add
// the two floating-point numbers exactly the way the old, buggy deduction
// code did, silently reintroducing the same round-off drift on the way
// stock comes back IN. Same Safe Math Addition Logic (toMilliUnits/
// fromMilliUnits) as every other Ingredient.currentStock mutation in this
// codebase - see ingredientUnits.js's own comment.
async function restoreStockForOrder(order) {
  try {
    const deductions = Array.isArray(order?.stockDeductions) ? order.stockDeductions : [];
    if (deductions.length === 0) return;
    for (const entry of deductions) {
      const ingredient = await Ingredient.findById(entry.ingredientId);
      if (!ingredient) continue;
      const beforeMilli = toMilliUnits(ingredient.currentStock);
      const addMilli = toMilliUnits(entry.quantity);
      ingredient.currentStock = fromMilliUnits(beforeMilli + addMilli);
      await ingredient.save();
    }
  } catch (error) {
    console.error("Non-fatal: stock restore failed while cancelling an order", order?._id, error);
  }
}

module.exports = { deductStockForItems, restoreStockForOrder };
