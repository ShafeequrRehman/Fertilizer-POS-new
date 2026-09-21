import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Plus, Edit, Trash2, Search, PackagePlus, ShoppingCart, AlertTriangle, X, Building2, Download, FileSpreadsheet, MessageCircle, History, Clock, CheckCircle2 } from "lucide-react";
import {
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
  fetchProducts,
  sendWhatsappDocument,
  fetchCustomerSearch,
} from "@/lib/pos-api";
import { Customer, Ingredient, IngredientPurchase, IngredientUnit, INGREDIENT_UNIT_OPTIONS, Product, Recipe, Supplier } from "@/lib/pos-types";
import { getAuthShop } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { ReportPdfDocument, downloadPdfDocument, pdfDocumentToBase64 } from "@/lib/pdf-export";
import { downloadExcelWorkbook, type ExcelCell, type ExcelSheet } from "@/lib/excel-export";
import { isDesktopApp } from "@/lib/api";
import { getIngredientsCache } from "@/lib/local-hub-api";
import { estimateOfflineIngredients } from "@/lib/offline-ingredient-helpers";
import { useLanguage } from "@/i18n";

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
// the inventory (Urea, DAP, Antracool) in grams, kilograms, or other units."
// The Add/Edit form's "Product Name" field is a searchable picker over this
// shop's own Manage Products catalog (see the Product Picker state/memo
// below) rather than free text with a separate category system, so raw
// stock stays tied to the same product names used at the POS. Mirrors
// ProductManagementSection.tsx's own layout (a form up top, a searchable
// directory below) so this feels like the same app, just for raw stock
// instead of finished menu items.
export function IngredientStockSection({
  title,
  description,
  cardClassName = "rounded-[28px] border border-slate-200 bg-white p-6",
}: {
  title?: string;
  description?: string;
  cardClassName?: string;
}) {
  const { t } = useLanguage();
  // No caller currently passes `title`/`description` overrides - both fall
  // back to this section's own translated defaults, resolved here (instead
  // of as plain string parameter defaults) so they stay in the active
  // language instead of being frozen to whatever they were at first render.
  const resolvedTitle = title ?? t('ingredientStock.title');
  const resolvedDescription = description ?? t('ingredientStock.description');
  const { confirm, popup } = useToast();
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  // Product Picker (Add/Edit Ingredient form): the "Product Name" field is
  // now a searchable select over the shop's own Manage Products catalog
  // (fetched once here, same `fetchProducts` ProductManagementSection.tsx
  // uses) instead of free text - see the product-search dropdown below the
  // name input and `productSuggestions` further down.
  const [products, setProducts] = useState<Product[]>([]);
  const [isProductDropdownOpen, setIsProductDropdownOpen] = useState(false);
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

  // Unified Khata / Customer-Supplier Netting - "Link to Khata contact"
  // search box, alongside (not replacing) the plain Supplier <select>
  // above. Mirrors PurchasePage.tsx's New Purchase Order modal (see that
  // file's own comment on orderContactQuery/pickOrderContact): fully
  // optional, same debounced-search-as-you-type UX. Picking a contact
  // auto-fills purchaseCompany from the contact's name (so the existing
  // display/status-message logic that already reads purchaseCompany keeps
  // working untouched) and clears purchaseSupplierId, since a purchase is
  // either from a registered Supplier or from a linked Khata contact,
  // never both.
  const [purchaseCustomerId, setPurchaseCustomerId] = useState<string | null>(null);
  const [purchaseLinkedCustomer, setPurchaseLinkedCustomer] = useState<Customer | null>(null);
  const [purchaseContactQuery, setPurchaseContactQuery] = useState("");
  const [purchaseContactResults, setPurchaseContactResults] = useState<Customer[]>([]);
  const [purchaseContactSearching, setPurchaseContactSearching] = useState(false);
  const purchaseContactSearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function resetPurchaseForm() {
    setPurchasingId(null);
    setPurchaseSupplierId("");
    setPurchaseCompany("");
    setPurchaseProductDetails("");
    setPurchaseQty("");
    setPurchaseRate("");
    setPurchasePaid("");
    setPurchaseCustomerId(null);
    setPurchaseLinkedCustomer(null);
    setPurchaseContactQuery("");
    setPurchaseContactResults([]);
  }

  // Debounced name search against the same GET /api/customers/search
  // endpoint PurchasePage.tsx's own Khata-contact picker uses - min-length-2
  // guard mirrors customerController.searchCustomers' own.
  function searchPurchaseContacts(query: string) {
    setPurchaseContactQuery(query);
    if (purchaseContactSearchTimeoutRef.current) clearTimeout(purchaseContactSearchTimeoutRef.current);
    if (query.trim().length < 2) {
      setPurchaseContactResults([]);
      setPurchaseContactSearching(false);
      return;
    }
    setPurchaseContactSearching(true);
    purchaseContactSearchTimeoutRef.current = setTimeout(async () => {
      try {
        const result = await fetchCustomerSearch(query, 'name');
        setPurchaseContactResults(result || []);
      } catch {
        setPurchaseContactResults([]);
      } finally {
        setPurchaseContactSearching(false);
      }
    }, 250);
  }

  function pickPurchaseContact(customer: Customer) {
    setPurchaseLinkedCustomer(customer);
    setPurchaseCustomerId(customer.id);
    setPurchaseCompany(customer.name);
    setPurchaseContactQuery("");
    setPurchaseContactResults([]);
    // A linked contact is who this purchase is really with - clear any
    // separately-picked plain Supplier so the two can't silently disagree
    // about which company name gets sent (same mutual-exclusivity as
    // PurchasePage.tsx's pickOrderContact).
    setPurchaseSupplierId("");
  }

  function clearPurchaseContact() {
    setPurchaseLinkedCustomer(null);
    setPurchaseCustomerId(null);
    setPurchaseCompany("");
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function loadAll() {
    try {
      setIsLoading(true);
      const [ings, sups, purs, productsResult] = await Promise.all([
        fetchIngredients(),
        fetchSuppliers(),
        fetchIngredientPurchases(),
        fetchProducts(),
      ]);
      setIngredients(ings || []);
      setSuppliers(sups || []);
      setPurchases(purs || []);
      setProducts(productsResult?.products || []);
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
        popup({ tone: "error", title: t('ingredientStock.toasts.loadFailedTitle'), message: error instanceof Error ? error.message : t('ingredientStock.toasts.loadFailedMessage') });
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
    setCurrentStock("");
    setLowStockThreshold("");
    setIsProductDropdownOpen(false);
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
      popup({ tone: "error", title: t('ingredientStock.toasts.missingInfoTitle'), message: t('ingredientStock.toasts.companyNameRequired') });
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
          setStatusMessage({ text: t('ingredientStock.statusMessages.companyUpdated', { name: updated.name }) });
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
      popup({ tone: "error", title: editingCompanyId ? t('ingredientStock.toasts.updateCompanyFailedTitle') : t('ingredientStock.toasts.addCompanyFailedTitle'), message: error instanceof Error ? error.message : t('ingredientStock.toasts.saveCompanyFailedMessage') });
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
    const confirmed = await confirm(t('ingredientStock.confirmDialogs.removeCompanyMessage', { name: supplier.name }), {
      title: t('ingredientStock.confirmDialogs.removeCompanyTitle'),
      confirmText: t('ingredientStock.confirmDialogs.removeAction'),
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteSupplier(supplier.id);
      setSuppliers((prev) => prev.filter((s) => s.id !== supplier.id));
      if (activeCompanyId === supplier.id) setActiveCompanyId(null);
      if (editingCompanyId === supplier.id) resetCompanyForm();
    } catch (error) {
      popup({ tone: "error", title: t('ingredientStock.toasts.removeCompanyFailedTitle'), message: error instanceof Error ? error.message : t('ingredientStock.toasts.removeCompanyFailedMessage') });
    }
  }

  async function handleSaveIngredient() {
    if (!name.trim()) {
      popup({ tone: "error", title: t('ingredientStock.toasts.missingInfoTitle'), message: t('ingredientStock.toasts.ingredientNameRequired') });
      return;
    }
    try {
      setIsSaving(true);
      const payload = {
        name: name.trim(),
        unit,
        currentStock: currentStock ? Number(currentStock) : 0,
        lowStockThreshold: lowStockThreshold ? Number(lowStockThreshold) : 0,
      };
      if (editingId) {
        const updated = await updateIngredient(editingId, payload);
        if (updated) {
          setIngredients((prev) => prev.map((i) => (i.id === editingId ? updated : i)));
          setStatusMessage({ text: t('ingredientStock.statusMessages.ingredientUpdated', { name: updated.name }) });
          resetForm();
        }
      } else {
        const created = await createIngredient(payload);
        if (created) {
          setIngredients((prev) => [...prev, created]);
          setStatusMessage({ text: t('ingredientStock.statusMessages.ingredientAdded', { name: created.name }) });
          resetForm();
        }
      }
    } catch (error) {
      popup({ tone: "error", title: t('ingredientStock.toasts.saveIngredientFailedTitle'), message: error instanceof Error ? error.message : t('ingredientStock.toasts.saveIngredientFailedMessage') });
    } finally {
      setIsSaving(false);
    }
  }

  function handleEditClick(ingredient: Ingredient) {
    setEditingId(ingredient.id);
    setName(ingredient.name);
    setUnit(ingredient.unit);
    setCurrentStock(ingredient.currentStock ? String(ingredient.currentStock) : "");
    setLowStockThreshold(ingredient.lowStockThreshold ? String(ingredient.lowStockThreshold) : "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleDeleteIngredient(ingredient: Ingredient) {
    const confirmed = await confirm(t('ingredientStock.confirmDialogs.deleteIngredientMessage', { name: ingredient.name }), {
      title: t('ingredientStock.confirmDialogs.deleteIngredientTitle'),
      confirmText: t('common.delete'),
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteIngredient(ingredient.id);
      setIngredients((prev) => prev.filter((i) => i.id !== ingredient.id));
      if (editingId === ingredient.id) resetForm();
    } catch (error) {
      popup({ tone: "error", title: t('ingredientStock.toasts.deleteIngredientFailedTitle'), message: error instanceof Error ? error.message : t('ingredientStock.toasts.deleteIngredientFailedMessage') });
    }
  }

  async function handleConfirmRestock(ingredient: Ingredient) {
    const quantity = Number(restockQty);
    if (!quantity) {
      popup({ tone: "error", title: t('ingredientStock.toasts.missingQuantityTitle'), message: t('ingredientStock.toasts.nonZeroQuantity') });
      return;
    }
    try {
      const updated = await restockIngredient(ingredient.id, quantity);
      if (updated) {
        setIngredients((prev) => prev.map((i) => (i.id === ingredient.id ? updated : i)));
        setStatusMessage({
          text: quantity > 0
            ? t('ingredientStock.statusMessages.restockAdded', { qty: Math.abs(quantity), unit: ingredient.unit, name: ingredient.name })
            : t('ingredientStock.statusMessages.restockRemoved', { qty: Math.abs(quantity), unit: ingredient.unit, name: ingredient.name }),
        });
      }
      setRestockingId(null);
      setRestockQty("");
    } catch (error) {
      popup({ tone: "error", title: t('ingredientStock.toasts.updateStockFailedTitle'), message: error instanceof Error ? error.message : t('ingredientStock.toasts.updateStockFailedMessage') });
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
      popup({ tone: "error", title: t('ingredientStock.toasts.missingQuantityTitle'), message: t('ingredientStock.toasts.quantityGreaterThanZero') });
      return;
    }
    if (!rate || rate <= 0) {
      popup({ tone: "error", title: t('ingredientStock.toasts.missingPurchaseRateTitle'), message: t('ingredientStock.toasts.enterCostPerUnit', { unit: ingredient.unit }) });
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
        customerId: purchaseCustomerId || null,
      });
      if (result) {
        setIngredients((prev) => prev.map((i) => (i.id === ingredient.id ? result.ingredient : i)));
        // Keeps the Filter Tabs' "which ingredients does this company
        // supply" view current without a full reload - the same purchase
        // list loadAll() fetched once up front.
        setPurchases((prev) => [result.purchase, ...prev]);
        const due = result.purchase.remainingAmount;
        const fromCompany = purchaseCompany.trim() ? t('ingredientStock.statusMessages.fromCompanySuffix', { company: purchaseCompany.trim() }) : "";
        const dueOrPaid = due > 0 ? t('ingredientStock.statusMessages.dueSuffix', { due: formatMoney(due) }) : t('ingredientStock.statusMessages.fullyPaidSuffix');
        setStatusMessage({
          text: t('ingredientStock.statusMessages.purchaseLogged', {
            po: result.purchase.purchaseOrderNumber,
            qty: quantity,
            unit: ingredient.unit,
            name: ingredient.name,
            fromCompany,
            rate: formatMoney(rate),
            total: formatMoney(result.purchase.totalAmount),
            dueOrPaid,
          }),
        });
      }
      resetPurchaseForm();
    } catch (error) {
      popup({ tone: "error", title: t('ingredientStock.toasts.logPurchaseFailedTitle'), message: error instanceof Error ? error.message : t('ingredientStock.toasts.logPurchaseFailedMessage') });
    }
  }

  // Product Picker: which products from the catalog match whatever's
  // currently typed in the "Product Name" field, shown as a dropdown of
  // selectable suggestions below it (see the Add/Edit Ingredient form JSX).
  // Matches on product name or company/brand so e.g. typing "Engro" finds
  // that company's products too. Capped so the dropdown never grows huge.
  const productSuggestions = useMemo(() => {
    const q = name.trim().toLowerCase();
    const list = q
      ? products.filter((p) => p.name.toLowerCase().includes(q) || (p.company || "").toLowerCase().includes(q))
      : products;
    return [...list].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30);
  }, [products, name]);

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
    let list = q ? ingredients.filter((i) => i.name.toLowerCase().includes(q)) : ingredients;
    if (activeSupplier) {
      const ingredientIds = ingredientIdsByCompanyName.get(activeSupplier.name.trim().toLowerCase()) || new Set<string>();
      list = list.filter((i) => ingredientIds.has(i.id));
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [ingredients, searchQuery, activeSupplier, ingredientIdsByCompanyName]);

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

  const purchaseSheetTitle = purchaseSheetRange === 'today' ? t('ingredientStock.export.todaysPurchaseOrders') : t('ingredientStock.export.allPurchaseOrders');

  function downloadCompanyPdf() {
    if (!activeSupplier) return;
    const productCount = filteredIngredients.length === 1
      ? t('ingredientStock.export.productSingular', { count: filteredIngredients.length })
      : t('ingredientStock.export.productPlural', { count: filteredIngredients.length });
    const doc = (
      <ReportPdfDocument
        title={t('ingredientStock.export.purchaseOrderSheetTitle', { name: activeSupplier.name })}
        subtitle={t('ingredientStock.export.purchaseOrderSheetSubtitle', { productCount, due: formatMoney(activeCompanyTotalDue) })}
        stats={[
          { label: t('ingredientStock.export.products'), value: String(filteredIngredients.length) },
          { label: t('ingredientStock.export.totalPurchasedAmount'), value: formatMoney(activeCompanySheetTotals.purchased) },
          { label: t('ingredientStock.export.totalDue'), value: formatMoney(activeCompanyTotalDue) },
        ]}
        tables={[
          {
            title: purchaseSheetTitle,
            columns: [
              { label: t('ingredientStock.export.poNumber'), width: 1 },
              { label: t('ingredientStock.export.dateTime'), width: 1.3 },
              { label: t('ingredientStock.export.product'), width: 2 },
              { label: t('ingredientStock.export.qty'), width: 0.8, align: 'right' },
              { label: t('ingredientStock.export.rate'), width: 0.9, align: 'right' },
              { label: t('common.total'), width: 0.9, align: 'right' },
              { label: t('ingredientStock.export.paid'), width: 0.9, align: 'right' },
              { label: t('ingredientStock.export.due'), width: 0.9, align: 'right' },
            ],
            rows: buildPurchaseSheetRows(),
            // Financial Aggregations: a prominent bolded totals row right
            // under the Purchase Order sheet - Total Purchased Amount
            // (this company's grand sum of everything bought from them in
            // this range) alongside the matching Paid/Due sums, so the
            // outstanding Due Amount column is never read in isolation
            // from what it's actually a due AGAINST.
            footer: ['', '', '', '', t('ingredientStock.export.totals'), formatMoney(activeCompanySheetTotals.purchased), formatMoney(activeCompanySheetTotals.paid), formatMoney(activeCompanySheetTotals.due)],
            emptyMessage: t('ingredientStock.export.noPurchaseOrdersRange'),
          },
          {
            title: t('ingredientStock.export.currentStockLevels'),
            columns: [
              { label: t('ingredientStock.export.ingredient'), width: 2 },
              { label: t('ingredientStock.export.unit'), width: 1 },
              { label: t('ingredientStock.export.currentStock'), width: 1.2, align: 'right' },
              { label: t('ingredientStock.export.avgCostPerUnit'), width: 1.3, align: 'right' },
            ],
            rows: buildStockExportSheetRows(),
            emptyMessage: t('ingredientStock.noProductsForCompany'),
          },
        ]}
      />
    );
    void downloadPdfDocument(doc, `${activeSupplier.name.replace(/\s+/g, '_')}_purchase_order_sheet.pdf`);
  }

  // Shop Name letterhead - the very first row of every exported
  // sheet, bold and larger than everything below it, so a supplier opening
  // this in Excel immediately sees which shop it's from with no
  // other context needed (same reasoning as the PDF header's own
  // restaurantName line). Same live localStorage-backed source
  // DashboardShell.tsx's sidebar reads.
  function buildRestaurantNameRow(columnCount: number): ExcelCell[] {
    const restaurantName = getAuthShop()?.name || t('ingredientStock.export.shopFallback');
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
    row.push({ value: t('ingredientStock.export.generatedAt', { date: generatedAt }), style: { align: 'Right', color: '6B7280', fontSize: 9 } });
    return row;
  }

  function buildCompanyExcelSheet(): ExcelSheet {
    return {
      name: t('ingredientStock.export.companyStockSheetName'),
      columnWidths: [160, 60, 90, 100],
      rows: [
        buildRestaurantNameRow(4),
        buildGeneratedAtRow(4),
        [
          { value: t('ingredientStock.export.ingredient'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('ingredientStock.export.unit'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('ingredientStock.export.currentStock'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: t('ingredientStock.export.avgCostPerUnit'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
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
      name: t('ingredientStock.export.purchaseOrdersSheetName'),
      columnWidths: [90, 130, 160, 70, 80, 90, 80, 80],
      rows: [
        buildRestaurantNameRow(8),
        buildGeneratedAtRow(8),
        [
          { value: t('ingredientStock.export.poNumber'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('ingredientStock.export.dateTime'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('ingredientStock.export.product'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('ingredientStock.export.qty'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: t('ingredientStock.export.rate'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: t('common.total'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: t('ingredientStock.export.paid'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: t('ingredientStock.export.due'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
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
          { value: t('ingredientStock.export.totals'), style: { bold: true } },
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
  // Shop Name + Live Generation Timestamp come for free from
  // ReportPdfDocument's own letterhead/generatedBlock (PDF) and
  // buildRestaurantNameRow/buildGeneratedAtRow (Excel) - same pattern every
  // other export in this file already follows.
  function buildDirectoryStockChecklistRows(): Array<Array<string | number>> {
    return filteredIngredients.map((ingredient) => {
      const isLow = ingredient.lowStockThreshold > 0 && ingredient.currentStock < ingredient.lowStockThreshold;
      return [
        t('ingredientStock.export.remainingStockRow', { name: ingredient.name, qty: formatStockQty(ingredient.currentStock), unit: ingredient.unit }),
        isLow ? t('ingredientStock.export.lowStock') : t('ingredientStock.export.ok'),
      ];
    });
  }

  function buildDirectoryStockPdfDoc() {
    const lowCount = filteredIngredients.filter((i) => i.lowStockThreshold > 0 && i.currentStock < i.lowStockThreshold).length;
    const ingredientCount = filteredIngredients.length === 1
      ? t('ingredientStock.export.ingredientSingular', { count: filteredIngredients.length })
      : t('ingredientStock.export.ingredientPlural', { count: filteredIngredients.length });
    return (
      <ReportPdfDocument
        title={t('ingredientStock.export.stockAvailabilityChecklist')}
        subtitle={`${ingredientCount}${activeSupplier ? t('ingredientStock.export.companySuffix', { name: activeSupplier.name }) : ''}`}
        stats={[
          { label: t('ingredientStock.export.totalIngredients'), value: String(filteredIngredients.length) },
          { label: t('ingredientStock.export.lowStockItems'), value: String(lowCount) },
        ]}
        tables={[{
          title: t('ingredientStock.export.inventoryAuditChecklist'),
          columns: [
            { label: t('ingredientStock.export.ingredientRemainingStock'), width: 2.6 },
            { label: t('common.status'), width: 0.9 },
          ],
          rows: buildDirectoryStockChecklistRows(),
          emptyMessage: t('ingredientStock.directory.noIngredientsConfigured'),
        }]}
      />
    );
  }

  function downloadDirectoryStockPdf() {
    void downloadPdfDocument(buildDirectoryStockPdfDoc(), 'ingredient_stock_availability_checklist.pdf');
  }

  function buildDirectoryStockExcelSheet(): ExcelSheet {
    return {
      name: t('ingredientStock.export.stockAvailabilitySheetName'),
      columnWidths: [260, 100],
      rows: [
        buildRestaurantNameRow(2),
        buildGeneratedAtRow(2),
        [
          { value: t('ingredientStock.export.ingredientRemainingStock'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('common.status'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
        ],
        ...filteredIngredients.map((ingredient) => {
          const isLow = ingredient.lowStockThreshold > 0 && ingredient.currentStock < ingredient.lowStockThreshold;
          return [
            { value: t('ingredientStock.export.remainingStockRow', { name: ingredient.name, qty: formatStockQty(ingredient.currentStock), unit: ingredient.unit }) },
            { value: isLow ? t('ingredientStock.export.lowStock') : t('ingredientStock.export.ok'), style: isLow ? { bold: true, color: 'B91C1C' } : undefined },
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
      popup({ tone: "error", title: t('ingredientStock.toasts.noWhatsappNumberTitle'), message: t('ingredientStock.toasts.addWhatsappNumberFirst', { name: activeSupplier.name }) });
      return;
    }
    try {
      setIsSendingWhatsapp(true);
      const productCount = filteredIngredients.length === 1
        ? t('ingredientStock.export.productSingular', { count: filteredIngredients.length })
        : t('ingredientStock.export.productPlural', { count: filteredIngredients.length });
      const doc = (
        <ReportPdfDocument
          title={t('ingredientStock.export.purchaseOrderSheetTitle', { name: activeSupplier.name })}
          subtitle={t('ingredientStock.export.purchaseOrderSheetSubtitle', { productCount, due: formatMoney(activeCompanyTotalDue) })}
          stats={[
            { label: t('ingredientStock.export.products'), value: String(filteredIngredients.length) },
            { label: t('ingredientStock.export.totalPurchasedAmount'), value: formatMoney(activeCompanySheetTotals.purchased) },
            { label: t('ingredientStock.export.totalDue'), value: formatMoney(activeCompanyTotalDue) },
          ]}
          tables={[
            {
              title: purchaseSheetTitle,
              columns: [
                { label: t('ingredientStock.export.poNumber'), width: 1 },
                { label: t('ingredientStock.export.dateTime'), width: 1.3 },
                { label: t('ingredientStock.export.product'), width: 2 },
                { label: t('ingredientStock.export.qty'), width: 0.8, align: 'right' },
                { label: t('ingredientStock.export.rate'), width: 0.9, align: 'right' },
                { label: t('common.total'), width: 0.9, align: 'right' },
                { label: t('ingredientStock.export.paid'), width: 0.9, align: 'right' },
                { label: t('ingredientStock.export.due'), width: 0.9, align: 'right' },
              ],
              rows: buildPurchaseSheetRows(),
              footer: ['', '', '', '', t('ingredientStock.export.totals'), formatMoney(activeCompanySheetTotals.purchased), formatMoney(activeCompanySheetTotals.paid), formatMoney(activeCompanySheetTotals.due)],
              emptyMessage: t('ingredientStock.export.noPurchaseOrdersRange'),
            },
            {
              title: t('ingredientStock.export.currentStockLevels'),
              columns: [
                { label: t('ingredientStock.export.ingredient'), width: 2 },
                { label: t('ingredientStock.export.unit'), width: 1 },
                { label: t('ingredientStock.export.currentStock'), width: 1.2, align: 'right' },
                { label: t('ingredientStock.export.avgCostPerUnit'), width: 1.3, align: 'right' },
              ],
              rows: buildStockExportSheetRows(),
              emptyMessage: t('ingredientStock.noProductsForCompany'),
            },
          ]}
        />
      );
      const base64 = await pdfDocumentToBase64(doc);
      await sendWhatsappDocument(activeSupplier.phone, base64, `${activeSupplier.name.replace(/\s+/g, '_')}_purchase_order_sheet.pdf`);
      popup({ tone: "success", title: t('ingredientStock.toasts.whatsappSentTitle'), message: t('ingredientStock.toasts.whatsappSentMessage', { name: activeSupplier.name }) });
    } catch (error) {
      popup({ tone: "error", title: t('ingredientStock.toasts.sendWhatsappFailedTitle'), message: error instanceof Error ? error.message : t('ingredientStock.toasts.sendWhatsappFailedMessage') });
    } finally {
      setIsSendingWhatsapp(false);
    }
  }

  return (
    <div className={cardClassName}>
      <div className="flex items-center gap-2 mb-4">
        <Boxes size={18} className="text-emerald-600" />
        <h3 className="text-lg font-black text-slate-900">{resolvedTitle}</h3>
      </div>
      <p className="max-w-2xl text-sm text-slate-500 mb-6">{resolvedDescription}</p>

      {statusMessage ? (
        <div className="mb-5 flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {statusMessage.text}
          <button onClick={() => setStatusMessage(null)} className="font-bold opacity-70 hover:opacity-100">×</button>
        </div>
      ) : null}

      {offlineSnapshotAt ? (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
          {t('ingredientStock.offline.banner', { time: new Date(offlineSnapshotAt).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) })}
        </div>
      ) : null}

      {/* Companies (Task 4/5): the registered supplier directory - one
          Filter Tab per company below, and a WhatsApp number to send stock
          exports to. */}
      <div className="rounded-[28px] border border-slate-100 bg-slate-50 p-6 space-y-3 shadow-sm mb-6">
        <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1 flex items-center gap-2">
          <Building2 size={14} /> {t('ingredientStock.companies.label')}
        </label>
        <p className="text-[11px] font-bold text-slate-400 ml-1">
          {t('ingredientStock.companies.hint')}
        </p>
        <div className="flex flex-wrap gap-2">
          {suppliers.map((s) => (
            <span key={s.id} className={`inline-flex items-center gap-2 rounded-full bg-white ring-1 px-3.5 py-1.5 text-[12px] font-black text-slate-600 ${editingCompanyId === s.id ? "ring-emerald-400" : "ring-slate-200"}`}>
              {s.name}
              {s.phone ? <span className="font-bold text-slate-400">· {s.phone}</span> : null}
              <button type="button" onClick={() => handleEditCompanyClick(s)} title={t('ingredientStock.companies.editPhoneTitle')} className="text-slate-300 hover:text-emerald-600">
                <Edit size={12} />
              </button>
              <button type="button" onClick={() => void handleDeleteCompany(s)} title={t('ingredientStock.companies.removeTitle')} className="text-slate-300 hover:text-rose-500">
                <X size={12} />
              </button>
            </span>
          ))}
          {suppliers.length === 0 ? <span className="text-xs font-bold text-slate-400">{t('ingredientStock.companies.empty')}</span> : null}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2 pt-1">
          <input
            type="text"
            value={newCompanyName}
            onChange={(e) => setNewCompanyName(e.target.value)}
            placeholder={t('ingredientStock.companies.namePlaceholder')}
            className="rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
          />
          <input
            type="text"
            value={newCompanyPhone}
            onChange={(e) => setNewCompanyPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSaveCompany(); }}
            placeholder={t('ingredientStock.companies.phonePlaceholder')}
            className="rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
          />
          <button
            type="button"
            onClick={() => void handleSaveCompany()}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-black text-white hover:bg-emerald-700 transition-colors shadow-sm shrink-0"
          >
            {editingCompanyId ? <Edit size={16} /> : <Plus size={16} />} {editingCompanyId ? t('common.update') : t('common.add')}
          </button>
          {editingCompanyId ? (
            <button
              type="button"
              onClick={resetCompanyForm}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-200 px-5 py-3 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm shrink-0"
            >
              <X size={16} /> {t('common.cancel')}
            </button>
          ) : null}
        </div>
      </div>

      {/* Add/Edit Ingredient */}
      <div className="rounded-[32px] border border-slate-100 bg-slate-50 p-6 space-y-5 shadow-sm">
        {editingId ? (
          <h4 className="text-sm font-black uppercase text-emerald-600 tracking-wider flex items-center gap-2 border-b border-emerald-100 pb-3">
            <Edit size={16} /> {t('ingredientStock.form.editHeading')}
          </h4>
        ) : null}

        <div className="grid grid-cols-1 gap-5">
          {/* Product Picker: typing filters this shop's own Manage Products
              catalog (fetched once into `products` on load - same
              fetchProducts ProductManagementSection.tsx uses), shown as a
              selectable dropdown right below. Picking a suggestion fills
              `name` with that product's own name; the field still accepts
              free text too, for a raw ingredient that isn't itself a sold
              product. */}
          <div className="space-y-2 relative">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.form.nameLabel')}</label>
            <div className="relative">
              <span className="absolute left-4 rtl:left-auto rtl:right-4 top-1/2 -translate-y-1/2 text-slate-400"><Search size={15} /></span>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setIsProductDropdownOpen(true); }}
                onFocus={() => setIsProductDropdownOpen(true)}
                onBlur={() => window.setTimeout(() => setIsProductDropdownOpen(false), 150)}
                placeholder={t('ingredientStock.form.namePlaceholder')}
                className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white pl-10 pr-4 rtl:pl-4 rtl:pr-10 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
              />
              {isProductDropdownOpen && productSuggestions.length > 0 ? (
                <div className="absolute z-10 mt-1.5 max-h-60 w-full overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-lg">
                  {productSuggestions.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setName(p.name); setIsProductDropdownOpen(false); }}
                      className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left rtl:text-right text-sm font-bold text-slate-700 hover:bg-emerald-50 transition-colors"
                    >
                      <span className="truncate">{p.name}</span>
                      {p.company ? <span className="shrink-0 text-xs font-bold text-slate-400">{p.company}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.form.unitLabel')}</label>
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
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{editingId ? t('ingredientStock.form.currentStockLabel') : t('ingredientStock.form.startingStockLabel')}</label>
            <input
              type="number"
              value={currentStock}
              onChange={(e) => setCurrentStock(e.target.value)}
              placeholder="0"
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
            />
          </div>
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.form.lowStockLabel')}</label>
            <input
              type="number"
              value={lowStockThreshold}
              onChange={(e) => setLowStockThreshold(e.target.value)}
              placeholder={t('ingredientStock.form.optionalPlaceholder')}
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
            {isSaving ? t('common.saving') : editingId ? t('ingredientStock.form.updateIngredient') : t('ingredientStock.form.addIngredient')}
          </button>
          {editingId ? (
            <button type="button" onClick={resetForm} className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-200 px-6 py-4 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm">
              <X size={16} /> {t('common.cancelEdit')}
            </button>
          ) : null}
        </div>
      </div>

      {/* Directory */}
      <div className="mt-10 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-1 gap-3">
          <h4 className="text-xs font-black uppercase text-slate-400 tracking-wider flex items-center gap-2">
            <Boxes size={14} /> {t('ingredientStock.directory.heading', { count: filteredIngredients.length })}
          </h4>
          <div className="relative w-full sm:w-64">
            <span className="absolute left-3 rtl:left-auto rtl:right-3 top-1/2 -translate-y-1/2 text-slate-400"><Search size={16} /></span>
            <input
              type="text"
              placeholder={t('ingredientStock.directory.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-[14px] border border-slate-200 bg-white pl-9 pr-4 rtl:pl-4 rtl:pr-9 py-2 text-sm font-bold outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 transition-all shadow-sm"
            />
          </div>
        </div>

        {/* Stock Availability Exports: a clean, printable inventory audit
            checklist of exactly what's on screen right now (respects the
            active company tab + search box above, same as filteredIngredients
            drives the list below) - so the manager can print it, physically
            cross-check shelves against it, and place the next purchase
            orders straight off whatever's showing as low/out. Shop
            Name + Live Generation Timestamp come for free from
            ReportPdfDocument's own letterhead/generatedBlock. */}
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={downloadDirectoryStockPdf}
            disabled={filteredIngredients.length === 0}
            className="flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-[10px] font-black uppercase tracking-wide text-white hover:bg-slate-800 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download size={13} /> {t('ingredientStock.directory.downloadPdf')}
          </button>
          <button
            type="button"
            onClick={downloadDirectoryStockExcel}
            disabled={filteredIngredients.length === 0}
            className="flex items-center gap-1.5 rounded-xl bg-slate-100 px-3.5 py-2 text-[10px] font-black uppercase tracking-wide text-slate-600 hover:bg-slate-200 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FileSpreadsheet size={13} /> {t('ingredientStock.directory.downloadExcel')}
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
              {t('common.all')}
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
                {activeSupplier.phone ? t('ingredientStock.directory.whatsappLabel', { phone: activeSupplier.phone }) : t('ingredientStock.directory.noWhatsappOnFile')}
                {activeCompanyTotalDue > 0 ? t('ingredientStock.directory.totalDueSuffix', { due: formatMoney(activeCompanyTotalDue) }) : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={downloadCompanyPdf} className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-slate-700 bg-white hover:bg-slate-100 ring-1 ring-slate-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm">
                <Download size={14} /> {t('ingredientStock.directory.pdf')}
              </button>
              <button type="button" onClick={downloadCompanyExcel} className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-slate-700 bg-white hover:bg-slate-100 ring-1 ring-slate-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm">
                <FileSpreadsheet size={14} /> {t('ingredientStock.directory.excel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSendWhatsapp()}
                disabled={isSendingWhatsapp}
                className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-emerald-700 bg-emerald-100 hover:bg-emerald-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm disabled:opacity-60"
              >
                <MessageCircle size={14} /> {isSendingWhatsapp ? t('ingredientStock.directory.sendingWhatsapp') : t('ingredientStock.directory.sendWhatsapp')}
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
                  {t('common.today')}
                </button>
                <button
                  type="button"
                  onClick={() => setPurchaseSheetRange('all')}
                  className={`rounded-full px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider transition-colors ${purchaseSheetRange === 'all' ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-200"}`}
                >
                  {t('common.all')}
                </button>
              </div>
            </div>
            {activeCompanySheetPurchases.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm font-bold text-slate-400">{t('ingredientStock.directory.noPurchaseOrdersForCompany', { todaySuffix: purchaseSheetRange === 'today' ? t('ingredientStock.directory.todaySuffix') : '' })}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50">
                      <th className="text-left rtl:text-right px-5 py-2.5">{t('ingredientStock.export.poNumber')}</th>
                      <th className="text-left rtl:text-right px-3 py-2.5">{t('ingredientStock.export.dateTime')}</th>
                      <th className="text-left rtl:text-right px-3 py-2.5">{t('ingredientStock.export.product')}</th>
                      <th className="text-right px-3 py-2.5">{t('ingredientStock.export.qty')}</th>
                      <th className="text-right px-3 py-2.5">{t('common.total')}</th>
                      <th className="text-right px-3 py-2.5">{t('ingredientStock.export.paid')}</th>
                      <th className="text-right px-5 py-2.5">{t('ingredientStock.export.due')}</th>
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
                      <td colSpan={4} className="px-5 py-2.5 text-[11px] font-black uppercase tracking-widest text-slate-500">{t('ingredientStock.directory.totalsLabel')}</td>
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
              {t('ingredientStock.directory.currentStockAvailable')}
            </h5>
            {filteredIngredients.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm font-bold text-slate-400">{t('ingredientStock.noProductsForCompany')}</p>
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

        {isLoading ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 animate-pulse border border-slate-100">{t('ingredientStock.directory.loading')}</div> : null}
        {!isLoading && filteredIngredients.length === 0 ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 border border-slate-100">{t('ingredientStock.directory.noIngredientsConfigured')}</div> : null}

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
                          <AlertTriangle size={10} /> {t('ingredientStock.directory.lowStockBadge')}
                        </span>
                      ) : null}
                    </div>
                    {ingredient.averageCost > 0 ? (
                      <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest mt-1">
                        {t('ingredientStock.directory.avgCostSuffix', { cost: formatMoney(ingredient.averageCost), unit: ingredient.unit })}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:shrink-0">
                    <div className={`text-[15px] font-black ${isLow ? "text-rose-600" : "text-slate-900"}`}>
                      {formatStockQty(ingredient.currentStock)}{ingredient.unit}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => { if (isPurchasing) resetPurchaseForm(); else setPurchasingId(ingredient.id); }}
                        title={t('ingredientStock.directory.logPurchaseTitle')}
                        className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-emerald-700 bg-emerald-100 hover:bg-emerald-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm"
                      >
                        <ShoppingCart size={14} /> {t('ingredientStock.directory.logPurchase')}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setRestockingId(isRestocking ? null : ingredient.id); setRestockQty(""); }}
                        title={t('ingredientStock.directory.adjustStockTitle')}
                        className="p-3 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 border border-transparent hover:border-emerald-100 rounded-xl transition-all shadow-sm"
                      >
                        <PackagePlus size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setExpandedHistoryId(isHistoryOpen ? null : ingredient.id)}
                        title={t('ingredientStock.directory.historyTitle')}
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
                      <h6 className="text-[10px] font-black uppercase tracking-widest text-slate-400">{t('ingredientStock.directory.purchaseOrderHistory')}</h6>
                      <span className="text-[10px] font-bold text-slate-300">
                        {ingredientHistory.length === 1
                          ? t('ingredientStock.directory.recordCount', { count: ingredientHistory.length })
                          : t('ingredientStock.directory.recordCountPlural', { count: ingredientHistory.length })}
                      </span>
                    </div>
                    {ingredientHistory.length === 0 ? (
                      <p className="rounded-xl bg-slate-50 px-4 py-4 text-center text-xs font-bold text-slate-400">
                        {t('ingredientStock.directory.noPurchaseOrdersForIngredient')}
                      </p>
                    ) : (
                      <div className="max-h-64 space-y-1.5 overflow-y-auto">
                        {ingredientHistory.map((p) => (
                          <div key={p.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-2.5">
                            <div className="min-w-0">
                              <p className="truncate text-xs font-black text-slate-700">
                                {p.purchaseOrderNumber} <span className="font-bold text-slate-400">· {p.companyName || t('ingredientStock.directory.unspecifiedSupplier')}</span>
                              </p>
                              <p className="text-[10px] font-bold text-slate-400">{formatPurchaseDateTime(purchaseDisplayDate(p))}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                              <span className="text-xs font-black text-slate-900 whitespace-nowrap">{p.quantity}{p.unit}</span>
                              <span className={`flex items-center gap-1 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg whitespace-nowrap ${
                                p.status === "received" ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"
                              }`}>
                                {p.status === "received" ? <CheckCircle2 size={11} /> : <Clock size={11} />}
                                {p.status === "received" ? t('ingredientStock.directory.received') : t('ingredientStock.directory.pending')}
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
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.purchaseForm.companyNameLabel')}</label>
                        <select
                          autoFocus
                          value={purchaseSupplierId}
                          onChange={(e) => {
                            const supplier = suppliers.find((s) => s.id === e.target.value);
                            setPurchaseSupplierId(e.target.value);
                            setPurchaseCompany(supplier?.name || "");
                          }}
                          title={suppliers.length === 0 ? t('ingredientStock.purchaseForm.addCompanyFirstTitle') : undefined}
                          className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all appearance-none"
                        >
                          <option value="">{suppliers.length === 0 ? t('ingredientStock.purchaseForm.noCompaniesSelect') : t('ingredientStock.purchaseForm.selectCompany')}</option>
                          {suppliers.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.purchaseForm.productDetailsLabel')}</label>
                        <input
                          type="text"
                          value={purchaseProductDetails}
                          onChange={(e) => setPurchaseProductDetails(e.target.value)}
                          className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Or link to an existing Khata contact (optional)</label>
                      {purchaseLinkedCustomer ? (
                        <div className="flex items-center justify-between rounded-2xl bg-indigo-50 border border-indigo-200 px-4 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-black text-indigo-900">{purchaseLinkedCustomer.name}</p>
                            <p className="truncate text-[11px] font-bold text-indigo-500">{purchaseLinkedCustomer.phone}</p>
                          </div>
                          <button type="button" onClick={clearPurchaseContact} className="shrink-0 rounded-full p-1.5 text-indigo-400 hover:bg-indigo-100 hover:text-indigo-700">
                            <X size={16} />
                          </button>
                        </div>
                      ) : (
                        <div className="relative">
                          <input
                            value={purchaseContactQuery}
                            onChange={(e) => searchPurchaseContacts(e.target.value)}
                            placeholder="Search a customer by name..."
                            className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                          />
                          {purchaseContactQuery.trim().length >= 2 ? (
                            <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                              {purchaseContactSearching ? (
                                <p className="px-3 py-2 text-xs font-bold text-slate-400">Searching...</p>
                              ) : purchaseContactResults.length === 0 ? (
                                <p className="px-3 py-2 text-xs font-bold text-slate-400">No matching customers.</p>
                              ) : (
                                purchaseContactResults.map((customer) => (
                                  <button
                                    key={customer.id}
                                    type="button"
                                    onClick={() => pickPurchaseContact(customer)}
                                    className="block w-full px-3 py-2 text-left text-xs font-bold text-slate-700 hover:bg-indigo-50"
                                  >
                                    {customer.name} <span className="text-slate-400">· {customer.phone}</span>
                                  </button>
                                ))
                              )}
                            </div>
                          ) : null}
                        </div>
                      )}
                      <p className="text-[10px] font-bold text-slate-400">
                        Links this purchase to a Khata contact's account so their sales and purchase dues net into one balance on the Unified Khata page. Leave this empty for a plain supplier who isn't a shop customer.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.purchaseForm.rateLabel', { unit: ingredient.unit })}</label>
                        <input
                          type="number"
                          value={purchaseRate}
                          onChange={(e) => setPurchaseRate(e.target.value)}
                          title={t('ingredientStock.purchaseForm.rateTitle')}
                          className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.purchaseForm.quantityLabel', { unit: ingredient.unit })}</label>
                        <input
                          type="number"
                          value={purchaseQty}
                          onChange={(e) => setPurchaseQty(e.target.value)}
                          className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.purchaseForm.totalAmountLabel')}</label>
                        <div className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-black text-slate-700">
                          {formatMoney(purchaseTotal)}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.purchaseForm.amountPaidLabel')}</label>
                        <input
                          type="number"
                          value={purchasePaid}
                          onChange={(e) => setPurchasePaid(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") void handleConfirmPurchase(ingredient); }}
                          placeholder="0"
                          title={t('ingredientStock.purchaseForm.amountPaidTitle')}
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
                        {t('ingredientStock.purchaseForm.fullPayment')}
                      </button>
                      <div className="text-right">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{t('ingredientStock.purchaseForm.dueAmountLabel')}</p>
                        <p className={`text-sm font-black ${purchaseDueAmount > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                          {formatMoney(purchaseDueAmount)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" onClick={() => void handleConfirmPurchase(ingredient)} className="rounded-2xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white hover:bg-emerald-700 transition-colors shadow-sm">
                        {t('ingredientStock.purchaseForm.confirmPurchase')}
                      </button>
                      <button type="button" onClick={resetPurchaseForm} className="rounded-2xl bg-slate-200 px-4 py-2.5 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm">
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
                {isRestocking ? (
                  <div className="mt-3 flex items-end gap-2 border-t border-slate-100 pt-3">
                    <div className="flex-1 space-y-1.5">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('ingredientStock.restockForm.adjustmentLabel', { unit: ingredient.unit })}</label>
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
                      {t('common.confirm')}
                    </button>
                    <button type="button" onClick={() => setRestockingId(null)} className="rounded-2xl bg-slate-200 px-4 py-2.5 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm">
                      {t('common.cancel')}
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
