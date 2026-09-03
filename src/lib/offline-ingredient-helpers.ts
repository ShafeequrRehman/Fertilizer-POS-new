import type { Ingredient, Recipe } from '@/lib/pos-types';
import { convertQuantity } from '@/lib/pos-types';
import { getPendingLocalOrders, type LocalOrderRecord } from '@/lib/local-hub-api';

// Client-side mirror of backend/services/stockService.js's
// deductStockForItems - but purely an ESTIMATE, never authoritative. The
// real, authoritative stock deduction still only ever happens server-side,
// exactly as before: for an order placed OFFLINE, that's still at
// cloud-import time (orderController.js's importOfflineOrders), not here.
//
// What this exists for: IngredientStockSection.tsx's "Current Stock
// Available" reads from the Local Hub's cached ingredient snapshot (see
// ingredientsCache.js) the moment the live cloud call fails - and that
// snapshot is frozen at whatever it was when this till last had internet.
// Without this, a shop that takes 20 orders during a long outage would see
// the SAME stock numbers for all 20 of them, silently wrong the whole time.
// This layers a locally-computed "how much has THIS till's own queued
// order backlog already implicitly used" on top of that frozen snapshot,
// so the displayed number moves in the right direction as orders are
// placed, even though it can never be as exact as the server's own
// (it can't see purchases/edits from other tills, and floating point
// recipe math is inherently approximate) - hence "estimate", surfaced to
// the user as such (see IngredientStockSection.tsx).

function recipeKey(name: string, variation: string): string {
  return `${String(name || '').trim().toLowerCase()}::${String(variation || '').trim().toLowerCase()}`;
}

function buildRecipeLookup(recipes: Recipe[]): Map<string, Recipe> {
  const map = new Map<string, Recipe>();
  for (const recipe of recipes) {
    map.set(recipeKey(recipe.productName, recipe.variation), recipe);
  }
  return map;
}

// Only orders that are still sitting in the Local Hub's own create queue
// count here - anything already synced has already had its real deduction
// applied server-side and is already reflected in the cached ingredients
// snapshot as of whenever this till last pulled it. Cancelled entries are
// excluded (a cancelled offline order never actually consumed anything).
function isConsumingOrder(record: LocalOrderRecord): boolean {
  const payload = record.payload as { status?: string } | undefined;
  return payload?.status !== 'cancelled';
}

// Applies a locally-computed consumption estimate to a cached ingredient
// snapshot, converting
// each recipe line's own unit into the ingredient's real base unit exactly
// the way stockService.js's deductStockForItems does server-side, and
// floors at 0 the same way (never shown as negative). Consumption is keyed
// by ingredientId only (not yet unit-converted - see
// estimateOfflineConsumption above), so the conversion has to happen here,
// per-ingredient, once its real base unit is known.
export function applyOfflineConsumptionEstimate(ingredients: Ingredient[], recipes: Recipe[], pendingOrders: LocalOrderRecord[]): Ingredient[] {
  if (pendingOrders.length === 0) return ingredients;

  // Rebuilt per-ingredient (not reusing the raw totals Map directly) since
  // estimateOfflineConsumption's totals are pre-conversion - each
  // ingredient's own recipe lines could be in different units (e.g. one
  // recipe wrote "400g", another "0.5kg" against the same kg-tracked
  // ingredient), same reasoning as stockService.js's own totals Map.
  const recipeLookup = buildRecipeLookup(recipes);
  const rawEntriesByIngredientId = new Map<string, Array<{ quantity: number; unit: string }>>();

  for (const record of pendingOrders) {
    if (!isConsumingOrder(record)) continue;
    const payload = record.payload as { items?: Array<{ name: string; variation?: string; quantity: number }> } | undefined;
    for (const item of payload?.items || []) {
      const recipe = recipeLookup.get(recipeKey(item.name, item.variation || ''));
      if (!recipe) continue;
      const orderedQuantity = Number(item.quantity) || 0;
      if (orderedQuantity <= 0) continue;
      for (const line of recipe.ingredients || []) {
        const needed = (Number(line.quantity) || 0) * orderedQuantity;
        if (needed <= 0) continue;
        if (!rawEntriesByIngredientId.has(line.ingredientId)) rawEntriesByIngredientId.set(line.ingredientId, []);
        rawEntriesByIngredientId.get(line.ingredientId)!.push({ quantity: needed, unit: line.unit });
      }
    }
  }

  if (rawEntriesByIngredientId.size === 0) return ingredients;

  return ingredients.map((ingredient) => {
    const entries = rawEntriesByIngredientId.get(ingredient.id);
    if (!entries || entries.length === 0) return ingredient;
    const consumed = entries.reduce((sum, entry) => sum + convertQuantity(entry.quantity, entry.unit as Ingredient['unit'], ingredient.unit), 0);
    return { ...ingredient, currentStock: Math.max(ingredient.currentStock - consumed, 0) };
  });
}

// Convenience wrapper - fetches this till's own pending order queue and
// applies the estimate in one call. Used by IngredientStockSection.tsx's
// offline fallback load.
export async function estimateOfflineIngredients(ingredients: Ingredient[], recipes: Recipe[]): Promise<Ingredient[]> {
  try {
    const pendingOrders = await getPendingLocalOrders();
    return applyOfflineConsumptionEstimate(ingredients, recipes, pendingOrders);
  } catch {
    // Local Hub itself unreachable - just show the cached snapshot as-is,
    // same as before this estimate existed.
    return ingredients;
  }
}
