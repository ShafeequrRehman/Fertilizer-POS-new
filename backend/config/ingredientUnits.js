// Canonical list of measurement units an Ingredient (raw stock item) can be
// tracked in - shared by every model/controller that declares or validates
// a `unit` field (Ingredient, IngredientPurchase, Recipe's per-line unit,
// ingredientController's create/update checks) so they can never drift out
// of sync with each other.
//
// Stock itself (Ingredient.currentStock/averageCost, IngredientPurchase's
// quantity/rate) is still a plain number with NO conversion behind it - a
// Stock Manager just picks whichever unit matches how they actually buy and
// count that item (grams/kg for solids like cheese, millilitres/litres for
// liquids like oil, or "pcs" for anything unit-less like pizza boxes or
// tissues, tracked by plain count), and every purchase/restock is entered
// in that exact same unit, so no conversion is ever needed there.
//
// Recipe Management is the one place real unit conversion DOES happen (see
// getRecipeUnitOptions/convertQuantity below): a recipe line is allowed to
// be entered in a finer sub-unit than its ingredient's own base unit (grams
// against a kg-tracked ingredient, millilitres against an l-tracked one) for
// precision - "12g of cheese per slice" reads far more naturally than
// "0.012kg" - and stockService.js converts that sub-unit quantity back into
// the ingredient's own base unit before ever touching currentStock, so the
// stored stock figure itself never changes units or needs its own
// conversion.
const INGREDIENT_UNITS = ["g", "kg", "ml", "l", "pcs"];

// Which "family" each unit belongs to - conversion only ever makes sense
// within the same family (mass<->mass, volume<->volume); pcs/count never
// converts to or from anything.
const UNIT_FAMILY = { g: "mass", kg: "mass", ml: "volume", l: "volume", pcs: "count" };

// How many of this unit make up its family's smallest unit (g for mass, ml
// for volume) - e.g. 1kg = 1000g, so kg's own factor is 1000.
const UNIT_TO_SMALLEST_FACTOR = { g: 1, kg: 1000, ml: 1, l: 1000, pcs: 1 };

// Recipe Management's Sub-Unit Support: for a kg-tracked ingredient, a
// recipe line may ALSO be entered in g; for an l-tracked one, also in ml.
// A g/ml/pcs-tracked ingredient has no finer sub-unit, so it only ever
// offers its own unit. Order matters - the ingredient's own base unit
// always comes first, so a dropdown built straight from this array defaults
// to it.
const RECIPE_SUB_UNITS = {
  kg: ["kg", "g"],
  l: ["l", "ml"],
  g: ["g"],
  ml: ["ml"],
  pcs: ["pcs"],
};

// Every unit a recipe line is allowed to be saved in for an ingredient
// tracked in `baseUnit` - see recipeController.upsertRecipeForProduct
// (validates a submitted unit against this) and
// RecipeManagementSection.tsx (builds its own per-line unit dropdown from
// the exact same list).
function getRecipeUnitOptions(baseUnit) {
  return RECIPE_SUB_UNITS[baseUnit] || [baseUnit];
}

// Converts `value` (expressed in `fromUnit`) into the equivalent amount in
// `toUnit` - e.g. convertQuantity(400, "g", "kg") === 0.4. Only ever
// converts within the same family (mass<->mass, volume<->volume); an
// incompatible pair (or an unrecognized unit) returns `value` unchanged
// rather than throwing, since stock deduction must never fail a sale over a
// unit mismatch (see stockService.js's own "never throws" rule) - that case
// should never actually arise anyway, since every unit a recipe line can be
// saved in is already validated against this same family, via
// getRecipeUnitOptions above, before it's ever stored.
function convertQuantity(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  if (UNIT_FAMILY[fromUnit] !== UNIT_FAMILY[toUnit]) return value;
  const fromFactor = UNIT_TO_SMALLEST_FACTOR[fromUnit] ?? 1;
  const toFactor = UNIT_TO_SMALLEST_FACTOR[toUnit] ?? 1;
  return (value * fromFactor) / toFactor;
}

// Safe Math Deduction/Addition Logic (floating-point round-off fix):
// Ingredient.currentStock is a plain fractional number (e.g. kg), and every
// place that adds to or subtracts from it directly with `+`/`-` risks
// classic JS float noise compounding over hundreds of orders/purchases/
// restocks - `1 - 0.2` itself is fine, but many repeated operations can
// drift into something like `58.499999999999996`, which then prints as
// visible garbage on every screen/export that shows currentStock.
//
// Fix: never add/subtract the raw fractional numbers directly. Convert each
// operand to an integer "milli-unit" first (grams for a kg-tracked
// ingredient, millilitres for a litre-tracked one, thousandths of a piece
// for pcs - the *1000 scale is generic, not literally grams-only), do the
// actual arithmetic as plain integers (which floating point represents and
// adds/subtracts exactly, no rounding error possible), then convert back
// with a hard 3-decimal round via toFixed. Every mutation of
// Ingredient.currentStock in this codebase (stockService.js's
// deductStockForItems/restoreStockForOrder, ingredientController.js's
// restockIngredient, ingredientPurchaseController.js's
// applyPurchaseToIngredientStock) is built on these two primitives so none
// of them can reintroduce the drift on their own.
function toMilliUnits(value) {
  return Math.round(Number(value || 0) * 1000);
}
function fromMilliUnits(milliUnits) {
  return parseFloat((milliUnits / 1000).toFixed(3));
}

module.exports = { INGREDIENT_UNITS, UNIT_FAMILY, getRecipeUnitOptions, convertQuantity, toMilliUnits, fromMilliUnits };
