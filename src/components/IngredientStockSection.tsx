import { useEffect, useMemo, useState } from "react";
import { Boxes, Plus, Edit, Trash2, Search, PackagePlus, ShoppingCart, AlertTriangle, X, Tags, Building2, Download, FileSpreadsheet, MessageCircle, History, Clock, CheckCircle2 } from "lucide-react";
import {
  fetchIngredientCategories,
  createIngredientCategory,
  deleteIngredientCategory,
  fetchIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  restockIngredient,
  createIngredientPurchase,
  fetchSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  fetchIngredientPurchases,
  sendWhatsappDocument,
} from "@/lib/pos-api";
import { Ingredient, IngredientCategory, IngredientPurchase, IngredientUnit, INGREDIENT_UNIT_OPTIONS, Recipe, Supplier } from "@/lib/pos-types";
import { getAuthShop } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { ReportPdfDocument, downloadPdfDocument, pdfDocumentToBase64 } from "@/lib/pdf-export";
import { downloadExcelWorkbook, type ExcelCell, type ExcelSheet } from "@/lib/excel-export";
import { isDesktopApp } from "@/lib/api";
import { getIngredientsCache } from "@/lib/local-hub-api";
import { estimateOfflineIngredients } from "@/lib/offline-ingredient-helpers";

function formatMoney(amount: number) {
  return `Rs ${Math.round(amount).toLocaleString()}`;
}

// Display-layer defensive rounding for currentStock. The backend now
// guarantees every NEW currentStock value is clean (see
// backend/config/ingredientUnits.js's toMilliUnits/fromMilliUnits) and
// backfills already-stored values on startup (seed.js's
// backfillIngredientStockPrecision) - but a value fetched into the browser
// before that migration ran, or any other not-yet-covered edge case, should
// still never render raw float noise like "48.699999999999996kg" on
// screen. Rounds to 3 decimals and strips trailing zeros (48.700 -> 48.7),
// same "clean number" shape the backend itself produces.
function formatStockQty(value: number) {
  return Number((Number(value) || 0).toFixed(3));
}

// "Date and Timestamp" (Task 2) - a Daily Purchase Details Sheet needs both
// which day AND what time a batch was actually logged, not just a bare
// date, since a company can be delivered to more than once in the same
// day.
function formatPurchaseDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Timestamp Bug Fix: which instant a purchase's "Date & Time" should
// actually display - `receivedAt` (the real moment Maal was received/paid,
// set only once status flips to "received") when it's set, falling back to
// `purchaseDate` only while still "pending" (nothing else exists yet).
// Mirrors PurchasePage.tsx's own SupplierDashboard/Master Export logic
// exactly (`item.status === 'received' && item.receivedAt ? item.receivedAt
// : g.purchaseDate`) - before this fix, every log in this file always read
// `purchaseDate` even for received batches, so a batch's real receive time
// (accurate local hours/minutes) was silently swapped for its order-placed
// date, which is what looked like a timezone bug.
function purchaseDisplayDate(purchase: IngredientPurchase): string {
  return purchase.status === 'received' && purchase.receivedAt ? purchase.receivedAt : purchase.purchaseDate;
}

function isSameCalendarDay(value: string, reference: Date) {
  const d = new Date(value);
  return d.getFullYear() === reference.getFullYear() && d.getMonth() === reference.getMonth() && d.getDate() === reference.getDate();
}

// Task 1: "The Stock Manager should be able to add raw items/ingredients to
// the inventory (Cheese, Chicken, Jalapeno, Beef) in grams or milliliters,
// and categorize these ingredients (Pizza Items, Burger Items) so daily/
// monthly incoming stock can be managed by category." Mirrors
// ProductManagementSection.tsx's own layout (category chips, a form up top,
// a searchable directory below) so this feels like the same app, just for
// raw stock instead of finished menu items.
export function IngredientStockSection({
  title = "Ingredient Stock",
  description = "Add raw ingredients, group them into categories, and log incoming stock.",
  cardClassName = "rounded-[28px] border border-slate-200 bg-white p-6",
}: {
  title?: string;
  description?: string;
  cardClassName?: string;
}) {
  const { confirm, popup } = useToast();
  const [categories, setCategories] = useState<IngredientCategory[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string } | null>(null);
  // Offline fallback (see loadAll's catch below): when a live load fails,
  // this becomes the last-cached-while-online snapshot (Local Hub's
  // ingredientsCache.js) with this till's own still-queued offline orders'
  // estimated consumption layered on top (see offline-ingredient-helpers.ts)
  // - never authoritative, purely so this screen shows something
  // reasonable instead of a blank error state during an outage. Cleared
  // the moment a live load succeeds again.
  const [offlineSnapshotAt, setOfflineSnapshotAt] = useState<string | null>(null);

  const [newCategoryName, setNewCategoryName] = useState("");

  // Task 4/5 (Dynamic Company Tabs & Supplier Communication): the
  // registered Company/Supplier directory - every one of these gets its
  // own Filter Tab in the Ingredient Directory below, and its own
  // Download PDF / Download Excel / Send WhatsApp trio once selected.
  // `purchases` is every IngredientPurchase ever logged (not just this
  // ingredient's), fetched once here so the directory can work out, purely
  // client-side, which ingredients each company has actually supplied -
  // there's no ingredientId<->supplierId link on Ingredient itself, only on
  // each purchase batch.
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchases, setPurchases] = useState<IngredientPurchase[]>([]);
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(null);
  // Task 2's "Daily Purchase Details Sheet showing what items were ordered
  // from them on that specific date" - the active company panel's own
  // Purchase Order history defaults to just Today, with an "All" toggle to
  // see this company's full order history instead.
  const [purchaseSheetRange, setPurchaseSheetRange] = useState<'today' | 'all'>('today');
  // Purchase Logs Integration: which ingredient's own incoming-purchase
  // history is currently expanded in the directory list below (at most one
  // at a time - same single-expansion pattern as isPurchasing/isRestocking
  // just below). Reads off the same `purchases` list already fetched once
  // in loadAll() - no separate per-ingredient fetch needed.
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newCompanyPhone, setNewCompanyPhone] = useState("");
  // Doubles the Add Company form above as an Edit form too (same pattern
  // as the Ingredient form's editingId below) - lets a company's
  // registered WhatsApp number be changed at any time (e.g. the
  // representative/manager for that company changes), not just set once
  // at creation. See handleEditCompanyClick/handleSaveCompany.
  const [editingCompanyId, setEditingCompanyId] = useState<string | null>(null);
  const [isSendingWhatsapp, setIsSendingWhatsapp] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<IngredientUnit>("g");
  const [categoryId, setCategoryId] = useState("");
  const [currentStock, setCurrentStock] = useState("");
  const [lowStockThreshold, setLowStockThreshold] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [restockingId, setRestockingId] = useState<string | null>(null);
  const [restockQty, setRestockQty] = useState("");

  // Purchasing/Financial Logic Task 1: logging a real batch (company,
  // product details, rate, quantity, auto total, due) - the primary way
  // stock comes in from here on. Distinct from the plain quantity-only
  // "Adjust Stock" above, which has no cost and is meant for corrections/
  // wastage, not real incoming deliveries.
  const [purchasingId, setPurchasingId] = useState<string | null>(null);
  // The purchase form's "Company Name" field is now a picker over the
  // registered Supplier directory (see suppliers state above), not free
  // text - purchaseSupplierId is what actually gets sent/stored;
  // purchaseCompany is just its denormalized display name, kept for the
  // exact same reason IngredientPurchase.companyName itself is a plain
  // string (see that model's own comment) - existing reports/ledger code
  // groups by this string, so it has to stay in sync rather than be
  // replaced outright.
  const [purchaseSupplierId, setPurchaseSupplierId] = useState("");
  const [purchaseCompany, setPurchaseCompany] = useState("");
  const [purchaseProductDetails, setPurchaseProductDetails] = useState("");
  const [purchaseQty, setPurchaseQty] = useState("");
  const [purchaseRate, setPurchaseRate] = useState("");
  // Correct Payment & Dues Logic: `purchasePaid` is the ONE figure the
  // Stock Manager actually types (or the Full Payment button fills in) -
  // what's actually being handed to the supplier right now. Due Amount is
  // never separately typed any more (that used to invert this: type the
  // due, we derive paid - easy to leave stale after changing quantity/rate
  // and end up with a due that doesn't match the real total). It's always
  // just `purchaseTotal - purchasePaid`, clamped to 0..total, computed
  // fresh on every render below - so a Full Payment (paid === total)
  // always shows Due as strictly 0, and typing anything less always shows
  // the true remaining balance, which createPurchase then routes onto this
  // company's credit ledger via IngredientPurchase.remainingAmount.
  const [purchasePaid, setPurchasePaid] = useState("");

  function resetPurchaseForm() {
    setPurchasingId(null);
    setPurchaseSupplierId("");
    setPurchaseCompany("");
    setPurchaseProductDetails("");
    setPurchaseQty("");
    setPurchaseRate("");
    setPurchasePaid("");
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function loadAll() {
    try {
      setIsLoading(true);
      const [cats, ings, sups, purs] = await Promise.all([
        fetchIngredientCategories(),
        fetchIngredients(),
        fetchSuppliers(),
        fetchIngredientPurchases(),
      ]);
      setCategories(cats || []);
      setIngredients(ings || []);
      setSuppliers(sups || []);
      setPurchases(purs || []);
      setOfflineSnapshotAt(null);
    } catch (error) {
      // Falls back to the Local Hub's cached snapshot (pushed down while
      // this till last had internet - see offline-sync.ts's
      // pushCurrentIngredientsCache) with this till's own still-queued
      // offline orders' estimated consumption layered on top, instead of
      // just leaving the screen blank with an error toast. Suppliers/
      // purchase history have no offline cache of their own (back-office
      // data, not part of what must keep working during an outage) and
      // simply stay at whatever they last were (usually empty on a cold
      // start) until back online.
      const fellBackOffline = isDesktopApp() && (await loadFromIngredientsCache());
      if (!fellBackOffline) {
        popup({ tone: "error", title: "Couldn't load ingredient stock", message: error instanceof Error ? error.message : "Failed to load." });
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function loadFromIngredientsCache(): Promise<boolean> {
    try {
      const cache = await getIngredientsCache();
      if (!cache.updatedAt) return false;
      const cachedIngredients = (cache.ingredients || []) as Ingredient[];
      const cachedRecipes = (cache.recipes || []) as Recipe[];
      setCategories((cache.categories || []) as IngredientCategory[]);
      setIngredients(await estimateOfflineIngredients(cachedIngredients, cachedRecipes));
      setOfflineSnapshotAt(cache.updatedAt);
      return true;
    } catch {
      return false;
    }
  }

  function resetForm() {
    setEditingId(null);
    setName("");
    setUnit("g");
    setCategoryId("");
    setCurrentStock("");
    setLowStockThreshold("");
  }

  async function handleAddCategory() {
    const trimmed = newCategoryName.trim();
    if (!trimmed) return;
    try {
      const created = await createIngredientCategory(trimmed);
      if (created) {
        setCategories((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        setNewCategoryName("");
      }
    } catch (error) {
      popup({ tone: "error", title: "Couldn't add category", message: error instanceof Error ? error.message : "Failed to add category." });
    }
  }

  async function handleDeleteCategory(category: IngredientCategory) {
    const confirmed = await confirm(`Delete category "${category.name}"? Ingredients in it become uncategorized.`, {
      title: "Delete category",
      confirmText: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteIngredientCategory(category.id);
      setCategories((prev) => prev.filter((c) => c.id !== category.id));
      setIngredients((prev) => prev.map((i) => (i.categoryId === category.id ? { ...i, categoryId: null } : i)));
    } catch (error) {
      popup({ tone: "error", title: "Couldn't delete category", message: error instanceof Error ? error.message : "Failed to delete category." });
    }
  }

  function resetCompanyForm() {
    setEditingCompanyId(null);
    setNewCompanyName("");
    setNewCompanyPhone("");
  }

  // The registered company/WhatsApp directory now supports both create
  // AND update through this one form, mirroring the Ingredient form's
  // editingId pattern below - editingCompanyId set means Save updates that
  // company (via updateSupplier) instead of creating a new one. See
  // handleEditCompanyClick for how a chip's pencil button populates this.
  async function handleSaveCompany() {
    const trimmedName = newCompanyName.trim();
    if (!trimmedName) {
      popup({ tone: "error", title: "Missing information", message: "Company name is required." });
      return;
    }
    try {
      if (editingCompanyId) {
        const updated = await updateSupplier(editingCompanyId, { name: trimmedName, phone: newCompanyPhone.trim() });
        if (updated) {
          // Re-sorting here (not just replacing in place) keeps the
          // Companies list/Filter Tabs alphabetical even if the name
          // itself changed - activeSupplier (used by
          // handleSendWhatsapp/the export trio) is derived from this same
          // suppliers state by id, so it picks up the new phone number
          // immediately, with no extra wiring needed.
          setSuppliers((prev) => prev.map((s) => (s.id === editingCompanyId ? updated : s)).sort((a, b) => a.name.localeCompare(b.name)));
          setStatusMessage({ text: `"${updated.name}" updated.` });
          resetCompanyForm();
        }
      } else {
        // Task 5: "Add input fields to save a WhatsApp Phone Number
        // whenever a new Company Name is registered." A registered
        // company immediately gets its own Filter Tab below (Task 4's
        // "creating a new company... should automatically add a
        // corresponding tab") - no separate step, since the tabs are just
        // this suppliers list rendered directly.
        const created = await createSupplier({ name: trimmedName, phone: newCompanyPhone.trim() });
        if (created) {
          setSuppliers((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
          resetCompanyForm();
        }
      }
    } catch (error) {
      popup({ tone: "error", title: editingCompanyId ? "Couldn't update company" : "Couldn't add company", message: error instanceof Error ? error.message : "Failed to save company." });
    }
  }

  // Populates the (now shared) Add/Edit form with this company's current
  // details so its WhatsApp number - or name - can be changed at any time,
  // e.g. when the company's representative/manager changes. See the
  // pencil button on each chip below.
  function handleEditCompanyClick(supplier: Supplier) {
    setEditingCompanyId(supplier.id);
    setNewCompanyName(supplier.name);
    setNewCompanyPhone(supplier.phone || "");
  }

  async function handleDeleteCompany(supplier: Supplier) {
    const confirmed = await confirm(`Remove company "${supplier.name}"? Its purchase history is kept, but it loses its Filter Tab.`, {
      title: "Remove company",
      confirmText: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteSupplier(supplier.id);
      setSuppliers((prev) => prev.filter((s) => s.id !== supplier.id));
      if (activeCompanyId === supplier.id) setActiveCompanyId(null);
      if (editingCompanyId === supplier.id) resetCompanyForm();
    } catch (error) {
      popup({ tone: "error", title: "Couldn't remove company", message: error instanceof Error ? error.message : "Failed to remove company." });
    }
  }

  async function handleSaveIngredient() {
    if (!name.trim()) {
      popup({ tone: "error", title: "Missing information", message: "Ingredient name is required." });
      return;
    }
    try {
      setIsSaving(true);
      const payload = {
        name: name.trim(),
        unit,
        categoryId: categoryId || null,
        currentStock: currentStock ? Number(currentStock) : 0,
        lowStockThreshold: lowStockThreshold ? Number(lowStockThreshold) : 0,
      };
      if (editingId) {
        const updated = await updateIngredient(editingId, payload);
        if (updated) {
          setIngredients((prev) => prev.map((i) => (i.id === editingId ? updated : i)));
          setStatusMessage({ text: `"${updated.name}" updated.` });
          resetForm();
        }
      } else {
        const created = await createIngredient(payload);
        if (created) {
          setIngredients((prev) => [...prev, created]);
          setStatusMessage({ text: `"${created.name}" added to inventory.` });
          resetForm();
        }
      }
    } catch (error) {
      popup({ tone: "error", title: "Couldn't save", message: error instanceof Error ? error.message : "Failed to save ingredient." });
    } finally {
      setIsSaving(false);
    }
  }

  function handleEditClick(ingredient: Ingredient) {
    setEditingId(ingredient.id);
    setName(ingredient.name);
    setUnit(ingredient.unit);
    setCategoryId(ingredient.categoryId || "");
    setCurrentStock(ingredient.currentStock ? String(ingredient.currentStock) : "");
    setLowStockThreshold(ingredient.lowStockThreshold ? String(ingredient.lowStockThreshold) : "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleDeleteIngredient(ingredient: Ingredient) {
    const confirmed = await confirm(`Delete "${ingredient.name}"? This cannot be undone.`, {
      title: "Delete ingredient",
      confirmText: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteIngredient(ingredient.id);
      setIngredients((prev) => prev.filter((i) => i.id !== ingredient.id));
      if (editingId === ingredient.id) resetForm();
    } catch (error) {
      popup({ tone: "error", title: "Couldn't delete", message: error instanceof Error ? error.message : "Failed to delete ingredient." });
    }
  }

  async function handleConfirmRestock(ingredient: Ingredient) {
    const quantity = Number(restockQty);
    if (!quantity) {
      popup({ tone: "error", title: "Missing quantity", message: "Enter a non-zero quantity." });
      return;
    }
    try {
      const updated = await restockIngredient(ingredient.id, quantity);
      if (updated) {
        setIngredients((prev) => prev.map((i) => (i.id === ingredient.id ? updated : i)));
        setStatusMessage({ text: `${quantity > 0 ? "Added" : "Removed"} ${Math.abs(quantity)}${ingredient.unit} ${quantity > 0 ? "to" : "from"} "${ingredient.name}".` });
      }
      setRestockingId(null);
      setRestockQty("");
    } catch (error) {
      popup({ tone: "error", title: "Couldn't update stock", message: error instanceof Error ? error.message : "Failed to update stock." });
    }
  }

  const purchaseTotal = purchaseQty && purchaseRate ? Number(purchaseQty) * Number(purchaseRate) : 0;
  // Amount Paid, clamped to what's actually payable on this batch - a
  // blank field reads as "nothing paid yet" (the whole total becomes Due),
  // same default this had before. Due Amount is ALWAYS this derived value,
  // never its own input - see purchasePaid's own comment above.
  const purchasePaidAmount = purchasePaid === "" ? 0 : Math.min(Math.max(Number(purchasePaid) || 0, 0), purchaseTotal);
  const purchaseDueAmount = Math.max(purchaseTotal - purchasePaidAmount, 0);

  async function handleConfirmPurchase(ingredient: Ingredient) {
    const quantity = Number(purchaseQty);
    const rate = Number(purchaseRate);
    if (!quantity || quantity <= 0) {
      popup({ tone: "error", title: "Missing quantity", message: "Enter a quantity greater than 0." });
      return;
    }
    if (!rate || rate <= 0) {
      popup({ tone: "error", title: "Missing purchase rate", message: `Enter the cost per ${ingredient.unit} for this batch.` });
      return;
    }
    try {
      const result = await createIngredientPurchase({
        ingredientId: ingredient.id,
        quantity,
        rate,
        paidAmount: purchasePaidAmount,
        companyName: purchaseCompany.trim(),
        productDetails: purchaseProductDetails.trim(),
        supplierId: purchaseSupplierId || null,
      });
      if (result) {
        setIngredients((prev) => prev.map((i) => (i.id === ingredient.id ? result.ingredient : i)));
        // Keeps the Filter Tabs' "which ingredients does this company
        // supply" view current without a full reload - the same purchase
        // list loadAll() fetched once up front.
        setPurchases((prev) => [result.purchase, ...prev]);
        const due = result.purchase.remainingAmount;
        setStatusMessage({
          text: `${result.purchase.purchaseOrderNumber}: logged ${quantity}${ingredient.unit} of "${ingredient.name}"${purchaseCompany.trim() ? ` from ${purchaseCompany.trim()}` : ""} at ${formatMoney(rate)}/${ingredient.unit} (${formatMoney(result.purchase.totalAmount)} total${due > 0 ? `, ${formatMoney(due)} due` : ", fully paid"}).`,
        });
      }
      resetPurchaseForm();
    } catch (error) {
      popup({ tone: "error", title: "Couldn't log purchase", message: error instanceof Error ? error.message : "Failed to log purchase." });
    }
  }

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach((c) => map.set(c.id, c.name));
    return map;
  }, [categories]);

  // Task 4: "clicking a specific Company Tab displays only their products" -
  // there's no ingredientId<->supplierId link on Ingredient itself, so this
  // is derived purely from purchase history: which ingredientIds has each
  // company's name actually appeared against on a logged batch. Keyed by
  // the trimmed, lowercased company name (not supplierId) so it lines up
  // with IngredientPurchase.companyName - the denormalized string every
  // purchase actually stores (see that model's own comment on why).
  const ingredientIdsByCompanyName = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const purchase of purchases) {
      const key = purchase.companyName.trim().toLowerCase();
      if (!key) continue;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(purchase.ingredientId);
    }
    return map;
  }, [purchases]);

  // Purchase Logs Integration: every purchase batch ever logged against
  // EACH ingredient, most-recent first - what the directory's per-ingredient
  // History panel reads from (see expandedHistoryId above). Grouped once
  // here rather than filtering `purchases` fresh on every render/toggle.
  const purchasesByIngredientId = useMemo(() => {
    const map = new Map<string, IngredientPurchase[]>();
    for (const purchase of purchases) {
      const list = map.get(purchase.ingredientId);
      if (list) list.push(purchase);
      else map.set(purchase.ingredientId, [purchase]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime());
    }
    return map;
  }, [purchases]);

  const activeSupplier = useMemo(() => suppliers.find((s) => s.id === activeCompanyId) || null, [suppliers, activeCompanyId]);

  // Every purchase batch logged against the active company - drives both
  // its "Total Due" figure and the exported stock table's numbers.
  const activeCompanyPurchases = useMemo(() => {
    if (!activeSupplier) return [];
    const key = activeSupplier.name.trim().toLowerCase();
    return purchases.filter((p) => p.companyName.trim().toLowerCase() === key);
  }, [purchases, activeSupplier]);

  const activeCompanyTotalDue = useMemo(
    () => activeCompanyPurchases.reduce((sum, p) => sum + (p.remainingAmount || 0), 0),
    [activeCompanyPurchases]
  );

  // Task 2's Daily Purchase Details Sheet - activeCompanyPurchases scoped
  // down to just today's batches when that's the picked range. Already
  // newest-first (see loadAll's initial fetch / handleConfirmPurchase's
  // prepend), so this stays newest-first too.
  const activeCompanySheetPurchases = useMemo(() => {
    if (purchaseSheetRange === 'all') return activeCompanyPurchases;
    const today = new Date();
    return activeCompanyPurchases.filter((p) => isSameCalendarDay(p.purchaseDate, today));
  }, [activeCompanyPurchases, purchaseSheetRange]);

  // Financial Aggregations: "Total Purchased Amount" - the grand sum of
  // every inventory item bought from this company - plus the matching
  // Paid/Due sums, all scoped to whatever range the sheet above is
  // currently showing (Today/All), so the totals row at the bottom of the
  // table always foots exactly the rows printed above it. Total Due as a
  // standalone stat (activeCompanyTotalDue above) deliberately stays
  // all-time regardless of this - same "current balance vs period
  // activity" split ingredientPurchaseController.getCompanyLedger's own
  // comment already documents.
  const activeCompanySheetTotals = useMemo(
    () =>
      activeCompanySheetPurchases.reduce(
        (acc, p) => ({
          purchased: acc.purchased + (p.totalAmount || 0),
          paid: acc.paid + (p.paidAmount || 0),
          due: acc.due + (p.remainingAmount || 0),
        }),
        { purchased: 0, paid: 0, due: 0 }
      ),
    [activeCompanySheetPurchases]
  );

  const filteredIngredients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = q
      ? ingredients.filter((i) => i.name.toLowerCase().includes(q) || (i.categoryId && categoryNameById.get(i.categoryId)?.toLowerCase().includes(q)))
      : ingredients;
    if (activeSupplier) {
      const ingredientIds = ingredientIdsByCompanyName.get(activeSupplier.name.trim().toLowerCase()) || new Set<string>();
      list = list.filter((i) => ingredientIds.has(i.id));
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [ingredients, searchQuery, categoryNameById, activeSupplier, ingredientIdsByCompanyName]);

  // Task 5: the exported table's rows (Download PDF / Download Excel /
  // Send WhatsApp) - one row per ingredient this company supplies, current
  // stock level so they know exactly what to dispatch.
  function buildStockExportSheetRows(): Array<Array<string | number>> {
    return filteredIngredients.map((i) => [
      i.name,
      i.unit,
      formatStockQty(i.currentStock),
      i.averageCost > 0 ? formatMoney(i.averageCost) : '—',
    ]);
  }

  // Task 2's Daily Purchase Details Sheet - one row per Purchase Order
  // logged against this company in the currently-picked range (Today/All -
  // see purchaseSheetRange), each identified by its own permanent PO
  // Number and exact log timestamp.
  function buildPurchaseSheetRows(): Array<Array<string | number>> {
    return activeCompanySheetPurchases.map((p) => [
      p.purchaseOrderNumber,
      formatPurchaseDateTime(purchaseDisplayDate(p)),
      `${p.ingredientName}${p.productDetails ? ` · ${p.productDetails}` : ''}`,
      `${p.quantity}${p.unit}`,
      formatMoney(p.rate),
      formatMoney(p.totalAmount),
      formatMoney(p.paidAmount),
      formatMoney(p.remainingAmount),
    ]);
  }

  const purchaseSheetTitle = purchaseSheetRange === 'today' ? "Today's Purchase Orders" : 'All Purchase Orders';

  function downloadCompanyPdf() {
    if (!activeSupplier) return;
    const doc = (
      <ReportPdfDocument
        title={`${activeSupplier.name} — Purchase Order Sheet`}
        subtitle={`${filteredIngredients.length} product${filteredIngredients.length === 1 ? '' : 's'} · Total due ${formatMoney(activeCompanyTotalDue)}`}
        stats={[
          { label: 'Products Supplied', value: String(filteredIngredients.length) },
          { label: 'Total Purchased Amount', value: formatMoney(activeCompanySheetTotals.purchased) },
          { label: 'Total Due', value: formatMoney(activeCompanyTotalDue) },
        ]}
        tables={[
          {
            title: purchaseSheetTitle,
            columns: [
              { label: 'PO #', width: 1 },
              { label: 'Date & Time', width: 1.3 },
              { label: 'Product', width: 2 },
              { label: 'Qty', width: 0.8, align: 'right' },
              { label: 'Rate', width: 0.9, align: 'right' },
              { label: 'Total', width: 0.9, align: 'right' },
              { label: 'Paid', width: 0.9, align: 'right' },
              { label: 'Due', width: 0.9, align: 'right' },
            ],
            rows: buildPurchaseSheetRows(),
            // Financial Aggregations: a prominent bolded totals row right
            // under the Purchase Order sheet - Total Purchased Amount
            // (this company's grand sum of everything bought from them in
            // this range) alongside the matching Paid/Due sums, so the
            // outstanding Due Amount column is never read in isolation
            // from what it's actually a due AGAINST.
            footer: ['', '', '', '', 'TOTALS', formatMoney(activeCompanySheetTotals.purchased), formatMoney(activeCompanySheetTotals.paid), formatMoney(activeCompanySheetTotals.due)],
            emptyMessage: 'No purchase orders logged for this company in this range yet.',
          },
          {
            title: 'Current Stock Levels',
            columns: [
              { label: 'Ingredient', width: 2 },
              { label: 'Unit', width: 1 },
              { label: 'Current Stock', width: 1.2, align: 'right' },
              { label: 'Avg Cost / Unit', width: 1.3, align: 'right' },
            ],
            rows: buildStockExportSheetRows(),
            emptyMessage: 'No products on file for this company yet.',
          },
        ]}
      />
    );
    void downloadPdfDocument(doc, `${activeSupplier.name.replace(/\s+/g, '_')}_purchase_order_sheet.pdf`);
  }

  // Restaurant Name letterhead - the very first row of every exported
  // sheet, bold and larger than everything below it, so a supplier opening
  // this in Excel immediately sees which restaurant it's from with no
  // other context needed (same reasoning as the PDF header's own
  // restaurantName line). Same live localStorage-backed source
  // DashboardShell.tsx's sidebar reads.
  function buildRestaurantNameRow(columnCount: number): ExcelCell[] {
    const restaurantName = getAuthShop()?.name || 'Restaurant';
    const row: ExcelCell[] = [{ value: restaurantName, style: { bold: true, fontSize: 14 } }];
    for (let i = 1; i < columnCount; i += 1) row.push({ value: '' });
    return row;
  }

  // Live Generation Timestamp - a top-right row on every Excel sheet
  // (blank cells across, the actual "Generated: ..." text right-aligned in
  // the sheet's own last column), same "print exactly when this was
  // pulled" reasoning as the PDF header's own generatedBlock. Computed
  // fresh per sheet build, not cached.
  function buildGeneratedAtRow(columnCount: number): ExcelCell[] {
    const row: ExcelCell[] = Array.from({ length: Math.max(columnCount - 1, 0) }, () => ({ value: '' }));
    const generatedAt = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
    row.push({ value: `Generated: ${generatedAt}`, style: { align: 'Right', color: '6B7280', fontSize: 9 } });
    return row;
  }

  function buildCompanyExcelSheet(): ExcelSheet {
    return {
      name: 'Stock Status',
      columnWidths: [160, 60, 90, 100],
      rows: [
        buildRestaurantNameRow(4),
        buildGeneratedAtRow(4),
        [
          { value: 'Ingredient', style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: 'Unit', style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: 'Current Stock', style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: 'Avg Cost / Unit', style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
        ],
        ...filteredIngredients.map((i) => [
          { value: i.name },
          { value: i.unit },
          { value: formatStockQty(i.currentStock), style: { align: 'Right' as const } },
          { value: i.averageCost, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
        ]),
      ],
    };
  }

  function buildPurchaseOrderExcelSheet(): ExcelSheet {
    return {
      name: 'Purchase Orders',
      columnWidths: [90, 130, 160, 70, 80, 90, 80, 80],
      rows: [
        buildRestaurantNameRow(8),
        buildGeneratedAtRow(8),
        [
          { value: 'PO #', style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: 'Date & Time', style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: 'Product', style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: 'Qty', style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: 'Rate', style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: 'Total', style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: 'Paid', style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: 'Due', style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
        ],
        ...activeCompanySheetPurchases.map((p) => [
          { value: p.purchaseOrderNumber },
          { value: formatPurchaseDateTime(purchaseDisplayDate(p)) },
          { value: `${p.ingredientName}${p.productDetails ? ` · ${p.productDetails}` : ''}` },
          { value: `${p.quantity}${p.unit}`, style: { align: 'Right' as const } },
          { value: p.rate, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
          { value: p.totalAmount, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
          { value: p.paidAmount, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
          { value: p.remainingAmount, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
        ]),
        // Financial Aggregations: the same prominent bolded totals row as
        // the PDF export's table footer - Total Purchased Amount (this
        // sheet's grand sum) plus the matching Paid/Due sums, directly
        // under the last data row so it's read as a summary of everything
        // above it, not a stray extra line.
        [
          { value: '' },
          { value: '' },
          { value: '' },
          { value: '' },
          { value: 'TOTALS', style: { bold: true } },
          { value: activeCompanySheetTotals.purchased, style: { bold: true, align: 'Right', format: '"Rs "#,##0.00' } },
          { value: activeCompanySheetTotals.paid, style: { bold: true, align: 'Right', format: '"Rs "#,##0.00' } },
          { value: activeCompanySheetTotals.due, style: { bold: true, align: 'Right', format: '"Rs "#,##0.00' } },
        ],
      ],
    };
  }

  function downloadCompanyExcel() {
    if (!activeSupplier) return;
    downloadExcelWorkbook([buildPurchaseOrderExcelSheet(), buildCompanyExcelSheet()], `${activeSupplier.name.replace(/\s+/g, '_')}_purchase_order_sheet.xls`);
  }

  // Stock Availability Exports (Ingredient Directory): a clean, printable
  // inventory audit checklist of exactly what's currently on screen
  // (filteredIngredients - respects the active company tab + search box, so
  // the exported sheet always matches the list the manager is looking at),
  // so it can be printed, physically checked against the shelves, and used
  // to place the next purchase order straight off whatever's flagged Low.
  // Restaurant Name + Live Generation Timestamp come for free from
  // ReportPdfDocument's own letterhead/generatedBlock (PDF) and
  // buildRestaurantNameRow/buildGeneratedAtRow (Excel) - same pattern every
  // other export in this file already follows.
  function buildDirectoryStockChecklistRows(): Array<Array<string | number>> {
    return filteredIngredients.map((ingredient) => {
      const isLow = ingredient.lowStockThreshold > 0 && ingredient.currentStock < ingredient.lowStockThreshold;
      return [
        `${ingredient.name}: ${formatStockQty(ingredient.currentStock)}${ingredient.unit} remaining`,
        ingredient.categoryId ? categoryNameById.get(ingredient.categoryId) || 'Uncategorized' : 'Uncategorized',
        isLow ? 'LOW STOCK' : 'OK',
      ];
    });
  }

  function buildDirectoryStockPdfDoc() {
    const lowCount = filteredIngredients.filter((i) => i.lowStockThreshold > 0 && i.currentStock < i.lowStockThreshold).length;
    return (
      <ReportPdfDocument
        title="Current Stock Availability Checklist"
        subtitle={`${filteredIngredients.length} ingredient${filteredIngredients.length === 1 ? '' : 's'}${activeSupplier ? ` · ${activeSupplier.name}` : ''}`}
        stats={[
          { label: 'Total Ingredients', value: String(filteredIngredients.length) },
          { label: 'Low Stock Items', value: String(lowCount) },
        ]}
        tables={[{
          title: 'Inventory Audit Checklist',
          columns: [
            { label: 'Ingredient - Remaining Stock', width: 2.6 },
            { label: 'Category', width: 1.3 },
            { label: 'Status', width: 0.9 },
          ],
          rows: buildDirectoryStockChecklistRows(),
          emptyMessage: 'No ingredients configured yet.',
        }]}
      />
    );
  }

  function downloadDirectoryStockPdf() {
    void downloadPdfDocument(buildDirectoryStockPdfDoc(), 'ingredient_stock_availability_checklist.pdf');
  }

  function buildDirectoryStockExcelSheet(): ExcelSheet {
    return {
      name: 'Stock Availability',
      columnWidths: [260, 140, 100],
      rows: [
        buildRestaurantNameRow(3),
        buildGeneratedAtRow(3),
        [
          { value: 'Ingredient - Remaining Stock', style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: 'Category', style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: 'Status', style: { bold: true, bg: '111827', color: 'FFFFFF' } },
        ],
        ...filteredIngredients.map((ingredient) => {
          const isLow = ingredient.lowStockThreshold > 0 && ingredient.currentStock < ingredient.lowStockThreshold;
          return [
            { value: `${ingredient.name}: ${formatStockQty(ingredient.currentStock)}${ingredient.unit} remaining` },
            { value: ingredient.categoryId ? categoryNameById.get(ingredient.categoryId) || 'Uncategorized' : 'Uncategorized' },
            { value: isLow ? 'LOW STOCK' : 'OK', style: isLow ? { bold: true, color: 'B91C1C' } : undefined },
          ];
        }),
      ],
    };
  }

  function downloadDirectoryStockExcel() {
    downloadExcelWorkbook([buildDirectoryStockExcelSheet()], 'ingredient_stock_availability_checklist.xls');
  }

  // Task 5: "Send WhatsApp button... forward the generated stock status
  // directly to that company's WhatsApp number" - reuses the exact same
  // Baileys-backed send that already delivers customer receipts (see
  // pos-api.ts's sendWhatsappDocument), just with this PDF's bytes and this
  // company's own registered phone number instead.
  async function handleSendWhatsapp() {
    if (!activeSupplier) return;
    if (!activeSupplier.phone.trim()) {
      popup({ tone: "error", title: "No WhatsApp number on file", message: `Add a WhatsApp number for "${activeSupplier.name}" first (edit it in the Companies list above).` });
      return;
    }
    try {
      setIsSendingWhatsapp(true);
      const doc = (
        <ReportPdfDocument
          title={`${activeSupplier.name} — Purchase Order Sheet`}
          subtitle={`${filteredIngredients.length} product${filteredIngredients.length === 1 ? '' : 's'} · Total due ${formatMoney(activeCompanyTotalDue)}`}
          stats={[
            { label: 'Products Supplied', value: String(filteredIngredients.length) },
            { label: 'Total Purchased Amount', value: formatMoney(activeCompanySheetTotals.purchased) },
            { label: 'Total Due', value: formatMoney(activeCompanyTotalDue) },
          ]}
          tables={[
            {
              title: purchaseSheetTitle,
              columns: [
                { label: 'PO #', width: 1 },
                { label: 'Date & Time', width: 1.3 },
                { label: 'Product', width: 2 },
                { label: 'Qty', width: 0.8, align: 'right' },
                { label: 'Rate', width: 0.9, align: 'right' },
                { label: 'Total', width: 0.9, align: 'right' },
                { label: 'Paid', width: 0.9, align: 'right' },
                { label: 'Due', width: 0.9, align: 'right' },
              ],
              rows: buildPurchaseSheetRows(),
              footer: ['', '', '', '', 'TOTALS', formatMoney(activeCompanySheetTotals.purchased), formatMoney(activeCompanySheetTotals.paid), formatMoney(activeCompanySheetTotals.due)],
              emptyMessage: 'No purchase orders logged for this company in this range yet.',
            },
            {
              title: 'Current Stock Levels',
              columns: [
                { label: 'Ingredient', width: 2 },
                { label: 'Unit', width: 1 },
                { label: 'Current Stock', width: 1.2, align: 'right' },
                { label: 'Avg Cost / Unit', width: 1.3, align: 'right' },
              ],
              rows: buildStockExportSheetRows(),
              emptyMessage: 'No products on file for this company yet.',
            },
          ]}
        />
      );
      const base64 = await pdfDocumentToBase64(doc);
      await sendWhatsappDocument(activeSupplier.phone, base64, `${activeSupplier.name.replace(/\s+/g, '_')}_purchase_order_sheet.pdf`);
      popup({ tone: "success", title: "Sent", message: `Purchase order sheet sent to ${activeSupplier.name} on WhatsApp.` });
    } catch (error) {
      popup({ tone: "error", title: "Couldn't send WhatsApp message", message: error instanceof Error ? error.message : "Failed to send. Make sure WhatsApp is connected in Settings." });
    } finally {
      setIsSendingWhatsapp(false);
    }
  }

  return (
    <div className={cardClassName}>
      <div className="flex items-center gap-2 mb-4">
        <Boxes size={18} className="text-emerald-600" />
        <h3 className="text-lg font-black text-slate-900">{title}</h3>
      </div>
      <p className="max-w-2xl text-sm text-slate-500 mb-6">{description}</p>

      {statusMessage ? (
        <div className="mb-5 flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {statusMessage.text}
          <button onClick={() => setStatusMessage(null)} className="font-bold opacity-70 hover:opacity-100">×</button>
        </div>
      ) : null}

      {offlineSnapshotAt ? (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
          Offline - showing stock levels as of {new Date(offlineSnapshotAt).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}, adjusted for orders taken this session. Purchases/new ingredients need internet.
        </div>
      ) : null}

      {/* Categories */}
      <div className="rounded-[28px] border border-slate-100 bg-slate-50 p-6 space-y-3 shadow-sm mb-6">
        <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1 flex items-center gap-2">
          <Tags size={14} /> Categories
        </label>
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-2 rounded-full bg-white ring-1 ring-slate-200 px-3.5 py-1.5 text-[12px] font-black text-slate-600">
              {c.name}
              <button type="button" onClick={() => void handleDeleteCategory(c)} className="text-slate-300 hover:text-rose-500">
                <X size={12} />
              </button>
            </span>
          ))}
          {categories.length === 0 ? <span className="text-xs font-bold text-slate-400">No categories yet - add one below.</span> : null}
        </div>
        <div className="flex gap-2 pt-1">
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleAddCategory(); }}
            placeholder="e.g. Pizza Items"
            className="flex-1 rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
          />
          <button
            type="button"
            onClick={() => void handleAddCategory()}
            className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-black text-white hover:bg-emerald-700 transition-colors shadow-sm shrink-0"
          >
            <Plus size={16} /> Add
          </button>
        </div>
      </div>

      {/* Companies (Task 4/5): the registered supplier directory - one
          Filter Tab per company below, and a WhatsApp number to send stock
          exports to. */}
      <div className="rounded-[28px] border border-slate-100 bg-slate-50 p-6 space-y-3 shadow-sm mb-6">
        <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1 flex items-center gap-2">
          <Building2 size={14} /> Companies
        </label>
        <p className="text-[11px] font-bold text-slate-400 ml-1">
          Tap the pencil on a company to update its registered WhatsApp number at any time - e.g. when the representative or manager changes. The new number is used immediately, including for Send WhatsApp.
        </p>
        <div className="flex flex-wrap gap-2">
          {suppliers.map((s) => (
            <span key={s.id} className={`inline-flex items-center gap-2 rounded-full bg-white ring-1 px-3.5 py-1.5 text-[12px] font-black text-slate-600 ${editingCompanyId === s.id ? "ring-emerald-400" : "ring-slate-200"}`}>
              {s.name}
              {s.phone ? <span className="font-bold text-slate-400">· {s.phone}</span> : null}
              <button type="button" onClick={() => handleEditCompanyClick(s)} title="Edit WhatsApp number" className="text-slate-300 hover:text-emerald-600">
                <Edit size={12} />
              </button>
              <button type="button" onClick={() => void handleDeleteCompany(s)} title="Remove company" className="text-slate-300 hover:text-rose-500">
                <X size={12} />
              </button>
            </span>
          ))}
          {suppliers.length === 0 ? <span className="text-xs font-bold text-slate-400">No companies yet - add one below.</span> : null}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2 pt-1">
          <input
            type="text"
            value={newCompanyName}
            onChange={(e) => setNewCompanyName(e.target.value)}
            placeholder="Company name"
            className="rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
          />
          <input
            type="text"
            value={newCompanyPhone}
            onChange={(e) => setNewCompanyPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSaveCompany(); }}
            placeholder="WhatsApp number"
            className="rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
          />
          <button
            type="button"
            onClick={() => void handleSaveCompany()}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-black text-white hover:bg-emerald-700 transition-colors shadow-sm shrink-0"
          >
            {editingCompanyId ? <Edit size={16} /> : <Plus size={16} />} {editingCompanyId ? "Update" : "Add"}
          </button>
          {editingCompanyId ? (
            <button
              type="button"
              onClick={resetCompanyForm}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-200 px-5 py-3 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm shrink-0"
            >
              <X size={16} /> Cancel
            </button>
          ) : null}
        </div>
      </div>

      {/* Add/Edit Ingredient */}
      <div className="rounded-[32px] border border-slate-100 bg-slate-50 p-6 space-y-5 shadow-sm">
        {editingId ? (
          <h4 className="text-sm font-black uppercase text-emerald-600 tracking-wider flex items-center gap-2 border-b border-emerald-100 pb-3">
            <Edit size={16} /> Edit Ingredient
          </h4>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Ingredient Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cheese"
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
            />
          </div>
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Category</label>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all appearance-none"
            >
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Unit</label>
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as IngredientUnit)}
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all appearance-none"
            >
              {INGREDIENT_UNIT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{editingId ? "Current Stock" : "Starting Stock"}</label>
            <input
              type="number"
              value={currentStock}
              onChange={(e) => setCurrentStock(e.target.value)}
              placeholder="0"
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
            />
          </div>
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Low Stock Alert Below</label>
            <input
              type="number"
              value={lowStockThreshold}
              onChange={(e) => setLowStockThreshold(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
            />
          </div>
        </div>

        <div className="pt-4 border-t border-slate-200 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSaveIngredient()}
            disabled={isSaving}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-2xl border-[0.5px] border-white/30 bg-emerald-600 px-8 py-4 text-sm font-black text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-3px_7px_rgba(6,78,59,0.5)] transition-all hover:-translate-y-0.5"
          >
            {editingId ? <Edit size={16} /> : <Plus size={16} />}
            {isSaving ? "Saving..." : editingId ? "Update Ingredient" : "Add Ingredient"}
          </button>
          {editingId ? (
            <button type="button" onClick={resetForm} className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-200 px-6 py-4 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm">
              <X size={16} /> Cancel Edit
            </button>
          ) : null}
        </div>
      </div>

      {/* Directory */}
      <div className="mt-10 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-1 gap-3">
          <h4 className="text-xs font-black uppercase text-slate-400 tracking-wider flex items-center gap-2">
            <Boxes size={14} /> Ingredient Directory ({filteredIngredients.length})
          </h4>
          <div className="relative w-full sm:w-64">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"><Search size={16} /></span>
            <input
              type="text"
              placeholder="Search ingredients..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-[14px] border border-slate-200 bg-white pl-9 pr-4 py-2 text-sm font-bold outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 transition-all shadow-sm"
            />
          </div>
        </div>

        {/* Stock Availability Exports: a clean, printable inventory audit
            checklist of exactly what's on screen right now (respects the
            active company tab + search box above, same as filteredIngredients
            drives the list below) - so the manager can print it, physically
            cross-check shelves against it, and place the next purchase
            orders straight off whatever's showing as low/out. Restaurant
            Name + Live Generation Timestamp come for free from
            ReportPdfDocument's own letterhead/generatedBlock. */}
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={downloadDirectoryStockPdf}
            disabled={filteredIngredients.length === 0}
            className="flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-[10px] font-black uppercase tracking-wide text-white hover:bg-slate-800 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download size={13} /> Download PDF
          </button>
          <button
            type="button"
            onClick={downloadDirectoryStockExcel}
            disabled={filteredIngredients.length === 0}
            className="flex items-center gap-1.5 rounded-xl bg-slate-100 px-3.5 py-2 text-[10px] font-black uppercase tracking-wide text-slate-600 hover:bg-slate-200 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FileSpreadsheet size={13} /> Download Excel
          </button>
        </div>

        {/* Task 4: Dynamic Company Filter Tabs - one per registered
            company, generated straight from the Companies list above (a
            newly-added company shows up here immediately, no separate
            step). Selecting one narrows the directory below to just what
            that company has supplied. */}
        {suppliers.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setActiveCompanyId(null)}
              className={`rounded-full px-4 py-2 text-xs font-black uppercase tracking-wider transition-colors ${activeCompanyId === null ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
            >
              All
            </button>
            {suppliers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveCompanyId(s.id)}
                className={`rounded-full px-4 py-2 text-xs font-black uppercase tracking-wider transition-colors ${activeCompanyId === s.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
              >
                {s.name}
              </button>
            ))}
          </div>
        ) : null}

        {/* Task 5: per-company export/communication trio - only shown once
            a specific company's tab is active (an "All" view has no single
            supplier to send/export against). */}
        {activeSupplier ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-slate-50 px-5 py-4">
            <div>
              <p className="text-sm font-black text-slate-900">{activeSupplier.name}</p>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                {activeSupplier.phone ? `WhatsApp: ${activeSupplier.phone}` : "No WhatsApp number on file"}
                {activeCompanyTotalDue > 0 ? ` · ${formatMoney(activeCompanyTotalDue)} due` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={downloadCompanyPdf} className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-slate-700 bg-white hover:bg-slate-100 ring-1 ring-slate-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm">
                <Download size={14} /> PDF
              </button>
              <button type="button" onClick={downloadCompanyExcel} className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-slate-700 bg-white hover:bg-slate-100 ring-1 ring-slate-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm">
                <FileSpreadsheet size={14} /> Excel
              </button>
              <button
                type="button"
                onClick={() => void handleSendWhatsapp()}
                disabled={isSendingWhatsapp}
                className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-emerald-700 bg-emerald-100 hover:bg-emerald-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm disabled:opacity-60"
              >
                <MessageCircle size={14} /> {isSendingWhatsapp ? "Sending..." : "Send WhatsApp"}
              </button>
            </div>
          </div>
        ) : null}

        {/* Task 2: Automated Purchase Order Tracking - every batch logged
            against this company, each carrying its own permanent PO Number
            and exact log timestamp. Defaults to Today (the "Daily Purchase
            Details Sheet" the request asks for); "All" shows this
            company's full order history instead. */}
        {activeSupplier ? (
          <div className="rounded-[24px] border border-slate-100 bg-white shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-slate-100">
              <h5 className="text-xs font-black uppercase text-slate-400 tracking-wider">{purchaseSheetTitle}</h5>
              <div className="flex rounded-full bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => setPurchaseSheetRange('today')}
                  className={`rounded-full px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider transition-colors ${purchaseSheetRange === 'today' ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-200"}`}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => setPurchaseSheetRange('all')}
                  className={`rounded-full px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider transition-colors ${purchaseSheetRange === 'all' ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-200"}`}
                >
                  All
                </button>
              </div>
            </div>
            {activeCompanySheetPurchases.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm font-bold text-slate-400">No purchase orders logged for this company{purchaseSheetRange === 'today' ? ' today' : ''} yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50">
                      <th className="text-left px-5 py-2.5">PO #</th>
                      <th className="text-left px-3 py-2.5">Date &amp; Time</th>
                      <th className="text-left px-3 py-2.5">Product</th>
                      <th className="text-right px-3 py-2.5">Qty</th>
                      <th className="text-right px-3 py-2.5">Total</th>
                      <th className="text-right px-3 py-2.5">Paid</th>
                      <th className="text-right px-5 py-2.5">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeCompanySheetPurchases.map((p) => (
                      <tr key={p.id} className="border-t border-slate-50">
                        <td className="px-5 py-2.5 font-black text-slate-700 whitespace-nowrap">{p.purchaseOrderNumber}</td>
                        <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{formatPurchaseDateTime(purchaseDisplayDate(p))}</td>
                        <td className="px-3 py-2.5 text-slate-700 font-bold">
                          {p.ingredientName}
                          {p.productDetails ? <span className="text-slate-400 font-medium"> · {p.productDetails}</span> : null}
                        </td>
                        <td className="px-3 py-2.5 text-right font-bold text-slate-700 whitespace-nowrap">{p.quantity}{p.unit}</td>
                        <td className="px-3 py-2.5 text-right font-black text-slate-900 whitespace-nowrap">{formatMoney(p.totalAmount)}</td>
                        <td className="px-3 py-2.5 text-right font-bold text-emerald-600 whitespace-nowrap">{formatMoney(p.paidAmount)}</td>
                        <td className={`px-5 py-2.5 text-right font-bold whitespace-nowrap ${p.remainingAmount > 0 ? "text-rose-600" : "text-emerald-600"}`}>{formatMoney(p.remainingAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {/* Financial Aggregations: the same prominent totals row
                      the PDF/Excel exports carry - Total Purchased Amount
                      alongside the matching Paid/Due sums for exactly the
                      rows shown above, so Due is never read without what
                      it's a due against. */}
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50">
                      <td colSpan={4} className="px-5 py-2.5 text-[11px] font-black uppercase tracking-widest text-slate-500">Totals</td>
                      <td className="px-3 py-2.5 text-right font-black text-slate-900 whitespace-nowrap">{formatMoney(activeCompanySheetTotals.purchased)}</td>
                      <td className="px-3 py-2.5 text-right font-black text-emerald-700 whitespace-nowrap">{formatMoney(activeCompanySheetTotals.paid)}</td>
                      <td className={`px-5 py-2.5 text-right font-black whitespace-nowrap ${activeCompanySheetTotals.due > 0 ? "text-rose-700" : "text-emerald-700"}`}>{formatMoney(activeCompanySheetTotals.due)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        ) : null}

        {/* Task 3: Real-Time Remaining Stock Visibility - "Current Stock
            Available" summary for exactly what this company supplies,
            reading live off the same `ingredients` state every purchase/
            restock/edit already updates, so it's never a stale snapshot. */}
        {activeSupplier ? (
          <div className="rounded-[24px] border border-slate-100 bg-emerald-50/40 shadow-sm overflow-hidden">
            <h5 className="px-5 py-4 text-xs font-black uppercase text-emerald-700 tracking-wider border-b border-emerald-100">
              Current Stock Available
            </h5>
            {filteredIngredients.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm font-bold text-slate-400">No products on file for this company yet.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-5">
                {filteredIngredients.map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-3 rounded-2xl bg-white ring-1 ring-emerald-100 px-4 py-3">
                    <span className="text-sm font-bold text-slate-700 truncate">{i.name}</span>
                    <span className="text-sm font-black text-emerald-700 shrink-0">{formatStockQty(i.currentStock)}{i.unit}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {isLoading ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 animate-pulse border border-slate-100">Loading ingredients...</div> : null}
        {!isLoading && filteredIngredients.length === 0 ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 border border-slate-100">No ingredients configured yet.</div> : null}

        <div className="flex flex-col gap-3">
          {filteredIngredients.map((ingredient) => {
            const isLow = ingredient.lowStockThreshold > 0 && ingredient.currentStock < ingredient.lowStockThreshold;
            const isRestocking = restockingId === ingredient.id;
            const isPurchasing = purchasingId === ingredient.id;
            const isHistoryOpen = expandedHistoryId === ingredient.id;
            const ingredientHistory = purchasesByIngredientId.get(ingredient.id) || [];
            return (
              <div key={ingredient.id} className="rounded-[24px] border border-slate-100 bg-white shadow-sm hover:border-emerald-100 hover:shadow-md transition-all p-4">
                {/* Was a single `flex items-center justify-between` row with
                    the right side `shrink-0` (stock qty + 5 action
                    buttons) - on a phone that fixed-width block plus the
                    name/category text simply didn't fit side by side, and
                    since it couldn't wrap (no flex-wrap) or shrink (shrink-0),
                    the row overflowed the card and the action icons got
                    clipped/cut off at the edge, with the squeezed name/
                    category text wrapping into a jumbled mess right next to
                    it. Stacks into two clean full-width rows below sm
                    instead: name/category on top, stock qty + actions
                    (wrapping onto a second line if needed) underneath.
                    Unchanged from sm (640px) up - still one row. */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-[15px] font-black text-slate-900 flex items-center gap-2 flex-wrap">
                      {ingredient.name}
                      {isLow ? (
                        <span className="inline-flex items-center gap-1 bg-rose-100 text-rose-600 px-2 py-0.5 rounded-lg text-[10px] uppercase font-black tracking-wider">
                          <AlertTriangle size={10} /> Low Stock
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest mt-1">
                      {ingredient.categoryId ? categoryNameById.get(ingredient.categoryId) || "Uncategorized" : "Uncategorized"}
                      {ingredient.averageCost > 0 ? ` · Avg cost ${formatMoney(ingredient.averageCost)}/${ingredient.unit}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:shrink-0">
                    <div className={`text-[15px] font-black ${isLow ? "text-rose-600" : "text-slate-900"}`}>
                      {formatStockQty(ingredient.currentStock)}{ingredient.unit}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => { if (isPurchasing) resetPurchaseForm(); else setPurchasingId(ingredient.id); }}
                        title="Log a purchased batch (company, product, rate, quantity, total, due)"
                        className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-emerald-700 bg-emerald-100 hover:bg-emerald-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm"
                      >
                        <ShoppingCart size={14} /> Log Purchase
                      </button>
                      <button
                        type="button"
                        onClick={() => { setRestockingId(isRestocking ? null : ingredient.id); setRestockQty(""); }}
                        title="Manual stock adjustment (correction/wastage - no cost)"
                        className="p-3 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 border border-transparent hover:border-emerald-100 rounded-xl transition-all shadow-sm"
                      >
                        <PackagePlus size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setExpandedHistoryId(isHistoryOpen ? null : ingredient.id)}
                        title="Purchase order history for this ingredient (dates, suppliers, quantities, status)"
                        className={`p-3 border rounded-xl transition-all shadow-sm ${isHistoryOpen ? "text-indigo-600 bg-indigo-50 border-indigo-100" : "text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 border-transparent hover:border-indigo-100"}`}
                      >
                        <History size={16} />
                      </button>
                      <button onClick={() => handleEditClick(ingredient)} className="p-3 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 border border-transparent hover:border-emerald-100 rounded-xl transition-all shadow-sm">
                        <Edit size={16} />
                      </button>
                      <button onClick={() => void handleDeleteIngredient(ingredient)} className="p-3 text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-100 rounded-xl transition-all shadow-sm">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
                {isHistoryOpen ? (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <div className="mb-2 flex items-center justify-between">
                      <h6 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Purchase Order History</h6>
                      <span className="text-[10px] font-bold text-slate-300">{ingredientHistory.length} record{ingredientHistory.length === 1 ? "" : "s"}</span>
                    </div>
                    {ingredientHistory.length === 0 ? (
                      <p className="rounded-xl bg-slate-50 px-4 py-4 text-center text-xs font-bold text-slate-400">
                        No purchase orders logged for this ingredient yet.
                      </p>
                    ) : (
                      <div className="max-h-64 space-y-1.5 overflow-y-auto">
                        {ingredientHistory.map((p) => (
                          <div key={p.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-2.5">
                            <div className="min-w-0">
                              <p className="truncate text-xs font-black text-slate-700">
                                {p.purchaseOrderNumber} <span className="font-bold text-slate-400">· {p.companyName || "Unspecified supplier"}</span>
                              </p>
                              <p className="text-[10px] font-bold text-slate-400">{formatPurchaseDateTime(purchaseDisplayDate(p))}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                              <span className="text-xs font-black text-slate-900 whitespace-nowrap">{p.quantity}{p.unit}</span>
                              <span className={`flex items-center gap-1 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg whitespace-nowrap ${
                                p.status === "received" ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"
                              }`}>
                                {p.status === "received" ? <CheckCircle2 size={11} /> : <Clock size={11} />}
                                {p.status === "received" ? "Received" : "Pending"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
                {isPurchasing ? (
                  <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Company Name</label>
                        <select
                          autoFocus
                          value={purchaseSupplierId}
                          onChange={(e) => {
                            const supplier = suppliers.find((s) => s.id === e.target.value);
                            setPurchaseSupplierId(e.target.value);
                            setPurchaseCompany(supplier?.name || "");
                          }}
                          title={suppliers.length === 0 ? "Add a company in the Companies list above first" : undefined}
                          className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all appearance-none"
                        >
                          <option value="">{suppliers.length === 0 ? "No companies yet - add one above" : "Select a company"}</option>
                          {suppliers.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Product Details</label>
                        <input
                          type="text"
                          value={purchaseProductDetails}
                          onChange={(e) => setPurchaseProductDetails(e.target.value)}
                          className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Rate per {ingredient.unit}</label>
                        <input
                          type="number"
                          value={purchaseRate}
                          onChange={(e) => setPurchaseRate(e.target.value)}
                          title="The exact cost this batch was bought at - saved on the batch and folded into this ingredient's average cost."
                          className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Quantity ({ingredient.unit})</label>
                        <input
                          type="number"
                          value={purchaseQty}
                          onChange={(e) => setPurchaseQty(e.target.value)}
                          className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Total Amount</label>
                        <div className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-black text-slate-700">
                          {formatMoney(purchaseTotal)}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Amount Paid</label>
                        <input
                          type="number"
                          value={purchasePaid}
                          onChange={(e) => setPurchasePaid(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") void handleConfirmPurchase(ingredient); }}
                          placeholder="0"
                          title="How much is actually being paid to this company right now. Leave blank if nothing is being paid - the full total becomes Due."
                          className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold text-emerald-700 outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                        />
                      </div>
                    </div>
                    {/* Correct Payment & Dues Logic: Due Amount is always
                        read-only, computed as Total - Paid - never a
                        separately-typed field (see purchasePaid's own
                        comment). "Full Payment" just snaps Amount Paid up
                        to the total, which instantly zeroes this out. */}
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-100 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setPurchasePaid(String(purchaseTotal))}
                        disabled={purchaseTotal <= 0}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-white ring-1 ring-emerald-200 px-3.5 py-2 text-xs font-black uppercase tracking-wider text-emerald-700 hover:bg-emerald-50 transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Full Payment
                      </button>
                      <div className="text-right">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Due Amount (Udhaar)</p>
                        <p className={`text-sm font-black ${purchaseDueAmount > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                          {formatMoney(purchaseDueAmount)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" onClick={() => void handleConfirmPurchase(ingredient)} className="rounded-2xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white hover:bg-emerald-700 transition-colors shadow-sm">
                        Confirm Purchase
                      </button>
                      <button type="button" onClick={resetPurchaseForm} className="rounded-2xl bg-slate-200 px-4 py-2.5 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                {isRestocking ? (
                  <div className="mt-3 flex items-end gap-2 border-t border-slate-100 pt-3">
                    <div className="flex-1 space-y-1.5">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Adjustment ({ingredient.unit}) - negative to remove</label>
                      <input
                        type="number"
                        autoFocus
                        value={restockQty}
                        onChange={(e) => setRestockQty(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void handleConfirmRestock(ingredient); }}
                        className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                      />
                    </div>
                    <button type="button" onClick={() => void handleConfirmRestock(ingredient)} className="rounded-2xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white hover:bg-emerald-700 transition-colors shadow-sm">
                      Confirm
                    </button>
                    <button type="button" onClick={() => setRestockingId(null)} className="rounded-2xl bg-slate-200 px-4 py-2.5 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm">
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
