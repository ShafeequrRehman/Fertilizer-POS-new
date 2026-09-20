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

// No-setup-required stock deduction: a shop that just resells its own raw
// stock directly under a Product with the SAME name it's tracked under in
// Ingredient Stock (e.g. a "Urea" product and a "Urea" ingredient) gets
// automatic 1:1 deduction with nothing to configure - no Recipe Management
// page, no per-product "set this up" step. Keyed on the ingredient's name
// alone (case-insensitive, trimmed - not name+variation like recipeKey,
// since an ingredient has no notion of "variation") so "Urea" / "Standard"
// and "Urea" / "50kg Bag" both match the one "Urea" ingredient. An explicit
// Recipe (still supported, just no UI to create one anymore - see
// recipeController.js's own comment) always wins over this fallback when
// both exist for the same product, since it's a deliberate, more detailed
// configuration.
function ingredientNameKey(name) {
  return String(name || "").trim().toLowerCase();
}

async function buildIngredientNameLookup(shopId) {
  const ingredients = await Ingredient.find({ shopId }).select("name unit").lean();
  const map = new Map();
  for (const ingredient of ingredients) {
    map.set(ingredientNameKey(ingredient.name), ingredient);
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

// Order-edit stock sync: reducing a line's quantity (or removing it
// entirely) via applyOrderPatch's addItems/replaceItems branches needs to
// hand ingredients BACK, and increasing a quantity needs to take MORE off
// the shelf - both cases need to resolve "which ingredients, how much"
// exactly the same way the original deduction at order-creation time did
// (same Recipe lookup, same Deal/Combo expansion, same same-name
// Ingredient auto-match fallback, same unit-family conversion/drift
// handling). Rather than duplicate that ~100 lines of resolution logic
// once for "subtract" and again for "add", it's factored out here into one
// shared resolver that ONLY figures out the quantities - it loads each
// Ingredient document (so the caller has its current unit/averageCost/
// currentStock to work with) but never mutates or saves anything itself.
// deductStockForItems and restoreStockForItems below are now both thin
// wrappers: call this, then apply their own +/- side to the loaded
// documents. This function alone is intentionally NOT exported - callers
// always want one of the two effects below, never the bare resolution.
async function resolveIngredientQuantities(items, shopId) {
  const orderItems = Array.isArray(items) ? items : [];
  if (orderItems.length === 0) return { resolved: [], driftedIngredientNames: [] };

  const recipeMap = await buildRecipeLookup(shopId);
  // Deliberately no early-return when recipeMap is empty (unlike before) -
  // the name-matched fallback below (ingredientNameMap) can still produce
  // real deductions with zero Recipes configured at all, which is now the
  // normal/expected case for a shop that never sets any up.
  const ingredientNameMap = await buildIngredientNameLookup(shopId);

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
    const quantity = Number(item.quantity) || 0;
    if (quantity <= 0) continue;
    const recipe = recipeMap.get(recipeKey(item.name, item.variation));
    if (recipe) {
      addRecipeToTotals(recipe, quantity);
      continue;
    }
    // No recipe for this product - fall back to the same-name Ingredient
    // auto-match (see buildIngredientNameLookup's own comment). Taken 1:1
    // in the ingredient's own base unit: the piece count leaving the
    // shelf really is the same count just sold, no conversion to reason
    // about the way a recipe's per-unit quantity/unit pair needs.
    const autoIngredient = ingredientNameMap.get(ingredientNameKey(item.name));
    if (!autoIngredient) continue;
    const id = String(autoIngredient._id);
    if (!totals.has(id)) totals.set(id, []);
    totals.get(id).push({ quantity, unit: autoIngredient.unit });
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
      const multiplier = dealQuantity * countPerDeal;
      const recipe = recipeMap.get(recipeKey(subProduct.name, subProduct.variation));
      if (recipe) {
        addRecipeToTotals(recipe, multiplier);
        continue;
      }
      // Same same-name Ingredient auto-match fallback as directOrderItems
      // above, applied to the deal's own component product.
      const autoIngredient = ingredientNameMap.get(ingredientNameKey(subProduct.name));
      if (!autoIngredient) continue;
      const id = String(autoIngredient._id);
      if (!totals.has(id)) totals.set(id, []);
      totals.get(id).push({ quantity: multiplier, unit: autoIngredient.unit });
    }
  }

  if (totals.size === 0) return { resolved: [], driftedIngredientNames: [] };

  // Second pass: load each referenced Ingredient once and convert its
  // entries into one final needed-quantity, expressed in THAT ingredient's
  // own current base unit - same conversion/drift-detection reasoning as
  // before, just returned to the caller instead of immediately applied, so
  // deductStockForItems and restoreStockForItems can each do their own
  // +/- with it.
  const resolved = [];
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
    if (needed <= 0) continue;
    if (entryDrifted) driftedIngredientNames.push(ingredient.name);

    resolved.push({ ingredientId: String(ingredient._id), ingredient, quantity: needed });
  }

  return { resolved, driftedIngredientNames };
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
// have changed since). Also called by applyOrderPatch (orderController.js)
// for the "increase" half of an order edit - resolving/deducting whatever
// quantity a line went UP by uses exactly this same function; the item
// list passed in is just that increase delta, not the whole order.
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
    const { resolved, driftedIngredientNames } = await resolveIngredientQuantities(items, shopId);
    if (resolved.length === 0) return result;

    const shortages = [];
    for (const { ingredient, quantity: needed } of resolved) {
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
      warnings.push(`These ingredients' recipe lines are out of date (unit changed since the recipe was saved) and may have deducted the wrong amount: ${driftedIngredientNames.join(", ")}. Ask your admin to check the backend logs.`);
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

// Order-edit stock sync (see resolveIngredientQuantities' own comment for
// the full context): the "quantity went DOWN" half of editing an order
// through applyOrderPatch (orderController.js) - a line's quantity reduced,
// or a line removed entirely, before it was ever actually deducted a
// second time. `items` here is only the DECREASE delta (e.g.
// {name, variation, quantity: 2} meaning "2 fewer of this than before"),
// never the whole order - the caller (applyOrderPatch) is responsible for
// diffing old vs new item lists into that delta first, same as the
// existing kitchen-ticket delta already does for increases.
//
// Resolves through the exact same recipe/deal/ingredient-name-match logic
// as deductStockForItems (via the shared resolveIngredientQuantities), so
// an edit refunds precisely what an equivalent-sized original order would
// have taken - then ADDS it back to currentStock, uncapped, the same way
// restoreStockForOrder above does for a full cancellation. `creditValue` is
// priced at each ingredient's CURRENT averageCost (same convention as
// deductStockForItems' costPrice), and is what the caller subtracts back
// out of order.costPrice so a partial refund lowers the order's recorded
// cost, not just its stock.
//
// Never throws - same non-fatal reasoning as deductStockForItems and
// restoreStockForOrder: a stock hiccup must never block an order edit.
async function restoreStockForItems(items, shopId) {
  const result = { restorations: [], creditValue: 0 };
  try {
    const { resolved } = await resolveIngredientQuantities(items, shopId);
    if (resolved.length === 0) return result;

    for (const { ingredient, quantity } of resolved) {
      const beforeMilli = toMilliUnits(ingredient.currentStock);
      const addMilli = toMilliUnits(quantity);
      ingredient.currentStock = fromMilliUnits(beforeMilli + addMilli);
      // Priced at averageCost as it stands right now, same convention
      // deductStockForItems' costPrice uses - see its own comment.
      result.creditValue += quantity * Number(ingredient.averageCost || 0);
      await ingredient.save();
      result.restorations.push({ ingredientId: ingredient._id, quantity });
    }

    result.creditValue = Math.round(result.creditValue * 100) / 100;
    return result;
  } catch (error) {
    console.error("Non-fatal: stock restore failed while editing an order", error);
    return result;
  }
}

module.exports = { deductStockForItems, restoreStockForOrder, restoreStockForItems };
