import { useEffect, useMemo, useState } from "react";
import { ChefHat, ChevronDown, ChevronRight, Plus, Trash2, Save, X, Search, FlaskConical } from "lucide-react";
import { fetchProducts, fetchIngredients, fetchRecipes, saveRecipeForProduct, deleteRecipeForProduct } from "@/lib/pos-api";
import { getRecipeUnitOptions, Ingredient, IngredientUnit, Product, Recipe } from "@/lib/pos-types";
import { useToast } from "@/lib/toast";
import { isDesktopApp } from "@/lib/api";
import { getIngredientsCache, getReferenceData } from "@/lib/local-hub-api";

type ProductGroup = {
  key: string;
  name: string;
  category: string;
  variations: Product[];
};

type DraftLine = { id: string; ingredientId: string; quantity: string; unit: IngredientUnit | "" };

// Task 2: "Create a section where the user can define the recipe for each
// food item based on its size." Since each size (Small/Large/XL) is
// already its own Product document (see ProductManagementSection.tsx's own
// comment on this), a "recipe" here is just a per-Product ingredient+
// quantity list - defining Small/Large/XL recipes for one item means
// expanding that item's group and filling in a recipe for each variation
// row underneath, one at a time.
export function RecipeManagementSection({
  title = "Recipe Management",
  description = "Define how much of each ingredient goes into a single unit of every product size - the exact amounts automatically deducted from stock when it's sold.",
  cardClassName = "rounded-[28px] border border-slate-200 bg-white p-6",
}: {
  title?: string;
  description?: string;
  cardClassName?: string;
}) {
  const { popup, confirm } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [recipesByProductId, setRecipesByProductId] = useState<Map<string, Recipe>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  // Offline fallback (see loadAll's catch below) - set to the cache's own
  // timestamp when this screen is showing last-known-while-online data
  // instead of a live load. Recipe EDITING stays online-only (unlike
  // Ingredient Stock's read side - see IngredientStockSection.tsx's own
  // comment): a saved recipe has to be validated against the live
  // Ingredient catalog server-side (recipeController.js's
  // upsertRecipeForProduct), and this isn't one of the four operations the
  // "must keep working offline" requirement actually names (POS checkout,
  // billing, recipe stock DEDUCTION, table timers, sales records) - editing
  // the recipe itself is back-office configuration, not a sale in progress.
  const [offlineSnapshotAt, setOfflineSnapshotAt] = useState<string | null>(null);

  useEffect(() => {
    void loadAll();
  }, []);

  async function loadAll() {
    try {
      setIsLoading(true);
      const [productsResult, ingredientsResult, recipesResult] = await Promise.all([
        fetchProducts(),
        fetchIngredients(),
        fetchRecipes(),
      ]);
      setProducts(productsResult?.products || []);
      setIngredients(ingredientsResult || []);
      const map = new Map<string, Recipe>();
      (recipesResult || []).forEach((recipe) => map.set(String(recipe.productId), recipe));
      setRecipesByProductId(map);
      setOfflineSnapshotAt(null);
    } catch (error) {
      const fellBackOffline = isDesktopApp() && (await loadFromCacheOffline());
      if (!fellBackOffline) {
        popup({ tone: "error", title: "Couldn't load recipes", message: error instanceof Error ? error.message : "Failed to load." });
      }
    } finally {
      setIsLoading(false);
    }
  }

  // Falls back to the Local Hub's cached products (referenceData.js) and
  // ingredients/recipes (ingredientsCache.js) - both pushed down while this
  // till last had internet - so this screen can still show every product's
  // recipe for reference during an outage, just not let it be edited (see
  // offlineSnapshotAt's own comment above).
  async function loadFromCacheOffline(): Promise<boolean> {
    try {
      const [reference, ingredientsCache] = await Promise.all([getReferenceData(), getIngredientsCache()]);
      if (!reference.updatedAt && !ingredientsCache.updatedAt) return false;
      setProducts((reference.products || []) as Product[]);
      setIngredients((ingredientsCache.ingredients || []) as Ingredient[]);
      const map = new Map<string, Recipe>();
      ((ingredientsCache.recipes || []) as Recipe[]).forEach((recipe) => map.set(String(recipe.productId), recipe));
      setRecipesByProductId(map);
      setOfflineSnapshotAt(ingredientsCache.updatedAt || reference.updatedAt);
      return true;
    } catch {
      return false;
    }
  }

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function openEditor(product: Product) {
    const existing = recipesByProductId.get(String(product.id));
    if (existing && existing.ingredients.length > 0) {
      setDraftLines(existing.ingredients.map((line, i) => ({ id: `${i}-${line.ingredientId}`, ingredientId: line.ingredientId, quantity: String(line.quantity), unit: line.unit as IngredientUnit })));
    } else {
      setDraftLines([{ id: Date.now().toString(), ingredientId: "", quantity: "", unit: "" }]);
    }
    setEditingProductId(String(product.id));
  }

  function closeEditor() {
    setEditingProductId(null);
    setDraftLines([]);
  }

  function addDraftLine() {
    setDraftLines((prev) => [...prev, { id: Date.now().toString(), ingredientId: "", quantity: "", unit: "" }]);
  }

  function updateDraftLine(id: string, patch: Partial<DraftLine>) {
    setDraftLines((prev) => prev.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  function removeDraftLine(id: string) {
    setDraftLines((prev) => prev.filter((line) => line.id !== id));
  }

  async function handleSaveRecipe(product: Product) {
    const lines = draftLines.filter((line) => line.ingredientId);
    if (lines.length === 0) {
      popup({ tone: "error", title: "Missing information", message: "Add at least one ingredient to this recipe." });
      return;
    }
    for (const line of lines) {
      if (!line.quantity || Number(line.quantity) <= 0) {
        const ingredient = ingredients.find((i) => i.id === line.ingredientId);
        popup({ tone: "error", title: "Missing information", message: `Enter a quantity greater than 0 for "${ingredient?.name || "this ingredient"}".` });
        return;
      }
    }
    try {
      setIsSaving(true);
      const saved = await saveRecipeForProduct(
        String(product.id),
        lines.map((line) => ({
          ingredientId: line.ingredientId,
          quantity: Number(line.quantity),
          unit: (line.unit || ingredients.find((i) => i.id === line.ingredientId)?.unit) as IngredientUnit | undefined,
        }))
      );
      if (saved) {
        setRecipesByProductId((prev) => {
          const next = new Map(prev);
          next.set(String(product.id), saved);
          return next;
        });
        closeEditor();
      }
    } catch (error) {
      popup({ tone: "error", title: "Couldn't save recipe", message: error instanceof Error ? error.message : "Failed to save recipe." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteRecipe(product: Product) {
    const confirmed = await confirm(`Remove the recipe for "${product.name}${product.variation && product.variation !== "Standard" ? ` (${product.variation})` : ""}"? Selling it will no longer deduct any ingredients.`, {
      title: "Remove recipe",
      confirmText: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteRecipeForProduct(String(product.id));
      setRecipesByProductId((prev) => {
        const next = new Map(prev);
        next.delete(String(product.id));
        return next;
      });
      if (editingProductId === String(product.id)) closeEditor();
    } catch (error) {
      popup({ tone: "error", title: "Couldn't remove recipe", message: error instanceof Error ? error.message : "Failed to remove recipe." });
    }
  }

  const groups = useMemo<ProductGroup[]>(() => {
    const map = new Map<string, ProductGroup>();
    const order: string[] = [];
    for (const p of products.filter((p) => !p.isDeal)) {
      const key = `${p.category}::${p.name}`;
      let group = map.get(key);
      if (!group) {
        group = { key, name: p.name, category: p.category, variations: [] };
        map.set(key, group);
        order.push(key);
      }
      group.variations.push(p);
    }
    const q = searchQuery.trim().toLowerCase();
    const all = order.map((key) => map.get(key)!);
    return q ? all.filter((g) => g.name.toLowerCase().includes(q) || g.category.toLowerCase().includes(q)) : all;
  }, [products, searchQuery]);

  return (
    <div className={cardClassName}>
      <div className="flex items-center gap-2 mb-4">
        <ChefHat size={18} className="text-amber-600" />
        <h3 className="text-lg font-black text-slate-900">{title}</h3>
      </div>
      <p className="max-w-2xl text-sm text-slate-500 mb-6">{description}</p>

      {offlineSnapshotAt ? (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
          Offline - showing recipes as of {new Date(offlineSnapshotAt).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}. Read-only until back online.
        </div>
      ) : null}

      {ingredients.length === 0 && !isLoading ? (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
          Add ingredients under Ingredient Stock first - recipes are built from your ingredient inventory.
        </div>
      ) : null}

      <div className="relative w-full sm:w-64 mb-4">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"><Search size={16} /></span>
        <input
          type="text"
          placeholder="Search products..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-[14px] border border-slate-200 bg-white pl-9 pr-4 py-2 text-sm font-bold outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 transition-all shadow-sm"
        />
      </div>

      {isLoading ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 animate-pulse border border-slate-100">Loading products...</div> : null}
      {!isLoading && groups.length === 0 ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 border border-slate-100">No products found.</div> : null}

      <div className="flex flex-col gap-3">
        {groups.map((group) => {
          const isExpanded = expandedGroups.has(group.key);
          const definedCount = group.variations.filter((v) => recipesByProductId.has(String(v.id))).length;
          return (
            <div key={group.key} className="rounded-[24px] border border-slate-100 bg-white shadow-sm overflow-hidden">
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                className="w-full flex items-center justify-between p-4 gap-4 text-left hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-slate-400 shrink-0">{isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                  <div className="min-w-0">
                    <div className="text-[15px] font-black text-slate-900">{group.name}</div>
                    <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest mt-0.5">{group.category} - {group.variations.length} size{group.variations.length > 1 ? "s" : ""}</p>
                  </div>
                </div>
                <span className={`shrink-0 px-2.5 py-1 rounded-lg text-[10px] uppercase font-black tracking-wider ${definedCount === group.variations.length ? "bg-emerald-100 text-emerald-600" : definedCount > 0 ? "bg-amber-100 text-amber-600" : "bg-slate-100 text-slate-400"}`}>
                  {definedCount}/{group.variations.length} recipes set
                </span>
              </button>

              {isExpanded ? (
                <div className="border-t border-slate-100 divide-y divide-slate-50 bg-slate-50/40">
                  {group.variations.map((variation) => {
                    const productId = String(variation.id);
                    const recipe = recipesByProductId.get(productId);
                    const isEditing = editingProductId === productId;
                    const sizeLabel = variation.variation && variation.variation !== "Standard" ? variation.variation : "Standard";
                    return (
                      <div key={productId} className="p-4">
                        {/* flex-col below sm: the recipe description can run
                            long (a comma-joined ingredient list), and with
                            no width limit on the left side plus a shrink-0
                            action-button group on the right, a phone-width
                            row had nowhere for either to fit cleanly.
                            Unchanged from sm up. */}
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                          <div className="min-w-0">
                            <div className="text-sm font-black text-slate-800">{sizeLabel}</div>
                            {recipe && recipe.ingredients.length > 0 ? (
                              <p className="text-xs font-bold text-slate-500 mt-1">
                                {recipe.ingredients.map((line) => `${line.ingredientName} ${line.quantity}${line.unit}`).join(", ")}
                              </p>
                            ) : (
                              <p className="text-xs font-bold text-slate-400 mt-1">No recipe set - this size won't deduct any stock when sold.</p>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
                            {recipe && !offlineSnapshotAt ? (
                              <button onClick={() => void handleDeleteRecipe(variation)} className="p-2.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-colors" title="Remove recipe">
                                <Trash2 size={15} />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              disabled={!!offlineSnapshotAt}
                              onClick={() => (isEditing ? closeEditor() : openEditor(variation))}
                              title={offlineSnapshotAt ? "Recipe editing needs internet - this is a read-only offline view." : undefined}
                              className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-amber-700 bg-amber-100 hover:bg-amber-200 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2.5 rounded-xl transition-colors shadow-sm"
                            >
                              <FlaskConical size={13} /> {recipe ? "Edit Recipe" : "Set Recipe"}
                            </button>
                          </div>
                        </div>

                        {isEditing ? (
                          <div className="mt-4 rounded-2xl border border-amber-100 bg-white p-4 space-y-3">
                            {draftLines.map((line) => (
                              <div key={line.id} className="flex flex-wrap items-center gap-2">
                                <select
                                  value={line.ingredientId}
                                  onChange={(e) => {
                                    const nextIngredient = ingredients.find((i) => i.id === e.target.value);
                                    updateDraftLine(line.id, { ingredientId: e.target.value, unit: nextIngredient?.unit || "" });
                                  }}
                                  className="flex-1 min-w-[160px] rounded-[14px] border border-slate-200 px-3 py-2.5 text-sm font-bold outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200 transition-all"
                                >
                                  <option value="">Select ingredient...</option>
                                  {ingredients.map((ing) => (
                                    <option key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</option>
                                  ))}
                                </select>
                                <input
                                  type="number"
                                  value={line.quantity}
                                  onChange={(e) => updateDraftLine(line.id, { quantity: e.target.value })}
                                  placeholder="Qty"
                                  className="w-28 rounded-[14px] border border-slate-200 px-3 py-2.5 text-sm font-bold outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200 transition-all"
                                />
                                {/* Sub-Unit Support: options come from
                                    getRecipeUnitOptions(ingredient.unit), so a
                                    kg-tracked ingredient offers kg or g, an
                                    l-tracked one offers l or ml, and a
                                    pcs/g/ml-tracked one only offers itself -
                                    never a unit outside that ingredient's own
                                    family. stockService.js's convertQuantity
                                    converts whichever of these is chosen back
                                    into the ingredient's live base unit before
                                    ever touching currentStock, so this is safe
                                    to leave user-selectable. */}
                                <select
                                  value={line.unit}
                                  onChange={(e) => updateDraftLine(line.id, { unit: e.target.value as IngredientUnit })}
                                  disabled={!line.ingredientId}
                                  title={line.ingredientId ? "Unit to record this ingredient's requirement in - automatically converted back to its stock unit when deducted." : "Select an ingredient first."}
                                  className="w-[86px] shrink-0 rounded-[14px] border border-slate-200 px-2 py-2.5 text-sm font-bold text-slate-700 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200 transition-all disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed"
                                >
                                  {!line.ingredientId ? <option value="">—</option> : null}
                                  {getRecipeUnitOptions(ingredients.find((i) => i.id === line.ingredientId)?.unit || "pcs").map((unit) => (
                                    <option key={unit} value={unit}>{unit}</option>
                                  ))}
                                </select>
                                {draftLines.length > 1 ? (
                                  <button type="button" onClick={() => removeDraftLine(line.id)} className="p-2.5 text-rose-400 hover:text-white hover:bg-rose-500 rounded-xl transition-colors">
                                    <Trash2 size={14} />
                                  </button>
                                ) : null}
                              </div>
                            ))}
                            <button type="button" onClick={addDraftLine} className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wider font-black text-amber-700 bg-amber-100 hover:bg-amber-200 px-4 py-2.5 rounded-xl transition-colors shadow-sm">
                              <Plus size={13} /> Add Ingredient
                            </button>
                            <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                              <button
                                type="button"
                                onClick={() => void handleSaveRecipe(variation)}
                                disabled={isSaving}
                                className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-black text-white hover:bg-amber-700 disabled:opacity-60 transition-colors shadow-sm"
                              >
                                <Save size={14} /> {isSaving ? "Saving..." : "Save Recipe"}
                              </button>
                              <button type="button" onClick={closeEditor} className="inline-flex items-center gap-2 rounded-xl bg-slate-200 px-4 py-2.5 text-sm font-black text-slate-700 hover:bg-slate-300 transition-colors">
                                <X size={14} /> Cancel
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
