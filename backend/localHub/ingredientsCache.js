const store = require("./jsonStore");

// A read-only offline snapshot of "enough Ingredient Stock / Recipe
// Management data to see stock levels and recipes with no internet" -
// ingredients, ingredient categories, and recipes, pushed down by the till
// (while it still has internet) via POST /ingredients-cache, and read back
// by IngredientStockSection.tsx/RecipeManagementSection.tsx via
// GET /ingredients-cache the moment a live cloud call fails. Same
// "loopback pushes, pairing-key reads, last-snapshot-only" shape as
// referenceData.js/orderCache.js/occupiedTablesCache.js.
//
// Deliberately READ-ONLY offline: creating an ingredient, logging a
// purchase, or editing a recipe still requires being online (same as Role
// management in referenceData.js's own comment) - none of that is part of
// the four explicit "must keep working offline" operations (POS checkout,
// billing, recipe stock deduction, table timers, sales records logs).
// What this cache exists for is narrower: so "Current Stock Available"
// doesn't just go blank with an error toast during an outage, and so an
// order placed offline can still be matched against a recipe to estimate
// what it consumed (see src/lib/offline-ingredient-helpers.ts) - the real,
// authoritative stock deduction still only ever happens server-side, at
// cloud-import time (see stockService.js's deductStockForItems), exactly as
// before.
const CACHE_KEY = "ingredientsCache";

function get() {
  return store.load(CACHE_KEY, {
    updatedAt: null,
    ingredients: [],
    categories: [],
    recipes: [],
  });
}

function set(data) {
  const snapshot = {
    updatedAt: new Date().toISOString(),
    ingredients: Array.isArray(data.ingredients) ? data.ingredients : [],
    categories: Array.isArray(data.categories) ? data.categories : [],
    recipes: Array.isArray(data.recipes) ? data.recipes : [],
  };
  store.save(CACHE_KEY, snapshot);
  return snapshot;
}

module.exports = { get, set };
