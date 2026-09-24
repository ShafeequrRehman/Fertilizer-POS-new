import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AlertCircle, Banknote, Barcode, CreditCard, Grid, List, Loader2, Minus, Plus, Search, ShoppingBag, Trash2, UserPlus, Wallet } from 'lucide-react';
import { ApiError, checkPendingOrder, claimKitchenPrint, createOrder, fetchCustomerSearch, fetchIngredients, fetchOrders, fetchProducts, fetchWaiters, isAuthenticated, updateCustomer, sendWhatsappMessage, openShopSession } from '@/lib/pos-api';
import { CartItem, Customer, OrderFormData, OrderPayload, Product, Waiter } from '@/lib/pos-types';
import { resolveProductImage } from '@/lib/food-images';
import { getStoreSettings } from '@/lib/pos-settings';
import { SavedOrder } from '@/lib/pos-types';
import { useShopSession } from '@/lib/shop-session';
import { hasPermission, getAuthUser, getAuthShop } from '@/lib/auth';
import { useToast } from '@/lib/toast';
import { useNotifications } from '@/lib/notifications';
import { useNetworkStatus } from '@/lib/network-status';
import { isDesktopApp } from '@/lib/api';
import { createLocalOrder, getReferenceData, pushReferenceData, isLocalHubReachable, getLocalHubStartDiagnostics, getSyncStatus, syncOrderCounter, reserveLocalOrderNumber, reserveLifetimeOrderNumber, syncLifetimeCounter, getOrdersCache, pushOrdersCache, getPendingLocalOrders } from '@/lib/local-hub-api';
import { reportPrintOutcome, listenForPrintSentMessages } from '@/lib/print-notify';
import { buildCategoryLookup, dispatchKitchenPrints, isCategoryPrintRoutingEnabled } from '@/lib/kitchen-print-routing';
import { Store } from 'lucide-react';
import { isTypingTarget, useBackspaceToClose } from '@/lib/keyboard-shortcuts';
import { useLanguage } from '@/i18n';
import CompleteOrderModal from '@/components/CompleteOrderModal';

type ElectronWindow = Window & typeof globalThis & {
  require?: (moduleName: 'electron') => {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  };
};

// A "product group" is every Product record that shares the same name +
// category - which is exactly how ProductManagementSection.tsx's "Add
// multiple variations" flow creates them (one product document per
// variation, same name/category/image, different price/stock/variation
// label). The POS grid shows one tile per group instead of one tile per
// variation: tapping "Pizza" once opens a size picker (Small/Medium/
// Large, each with its own price) instead of showing three separate
// "Pizza" tiles. Deals and any product with only one variation skip the
// picker entirely and add straight to the cart, exactly like before.
type ProductGroup = {
  key: string;
  name: string;
  category: string;
  image: string;
  color: string;
  description: string;
  isDeal: boolean;
  dealItems?: string[];
  variations: Product[];
};

export default function POSPage() {
  const { t } = useLanguage();
  const { isOpen: shopIsOpen, session: shopSession, loading: shopSessionLoading, refresh: refreshShopSession, openLocally: openShopLocally } = useShopSession();
  const { toast: shopToast, popup } = useToast();
  const { notify } = useNotifications();
  const { isOnline } = useNetworkStatus();
  const [isOpeningShop, setIsOpeningShop] = useState(false);
  const [categories, setCategories] = useState<string[]>(['All']);
  const [products, setProducts] = useState<Product[]>([]);
  // Stock-Card Number Fix: the Stock page tracks raw ingredient inventory
  // (Ingredient.currentStock, moved by Log Purchase) completely separately
  // from a POS Product's own `stock` field (moved by restocking/selling the
  // product itself) - two different collections that happen to often share
  // the same name (a shop buys "Urea" as an ingredient and also sells a
  // "Urea" product). The shop owner expects the number on the POS card to
  // match whatever the Stock page shows for that same name, so this maps
  // ingredient name (trimmed/lowercased) -> currentStock, and the POS card
  // badge below prefers this figure over the product's own `stock` whenever
  // a same-named ingredient exists - display only, doesn't touch either
  // record's real stock-tracking/decrement logic.
  const [ingredientStockByName, setIngredientStockByName] = useState<Record<string, number>>({});
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  const [activeCategory, setActiveCategory] = useState('All');
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<'Cash' | 'Card' | 'E-Wallet'>('Cash');
  const [statusMessage, setStatusMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [taxRate, setTaxRate] = useState(0);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  // React state updates aren't synchronous - a very fast double-click (or a
  // stray double dispatch of the click event) can fire handleSaveOrder
  // twice before the button has actually re-rendered as disabled, which was
  // producing two real orders (and, since order numbers are assigned near-
  // simultaneously, sometimes duplicate order numbers too). A ref is
  // checked/set synchronously, closing that gap.
  const isSavingOrderRef = useRef(false);
  const [orderFormData, setOrderFormData] = useState<OrderFormData>({ orderType: 'TakeAway', phone: '', customer: '', address: '', previousDues: 0, note: '', waiter: '', billTid: '', billName: '', cashRecipientName: '' });
  const [printReadyUrl, setPrintReadyUrl] = useState<string | null>(null);
  // Shows the same Complete Payment popup RecordPage's own Complete Order
  // action uses, right after Save - see the user request this was built
  // for: skip the extra trip through Sales just to collect payment on an
  // order placed here a moment ago. The order itself is still created as
  // "pending" first, exactly as before (see handleSaveOrder below) - this
  // popup only ever flips it to "completed" through an explicit Confirm
  // Payment/Pay Full click, same safeguard as everywhere else this modal
  // is used. Dismissing it without paying just leaves the order pending,
  // same as before this popup existed - nothing is lost, it can still be
  // completed later from Record/Sales like before.
  const [completePaymentTarget, setCompletePaymentTarget] = useState<SavedOrder | null>(null);
  const [suggestions, setSuggestions] = useState<Customer[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showNewCustomerPrompt, setShowNewCustomerPrompt] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [isManualEntry, setIsManualEntry] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [variationPickerGroup, setVariationPickerGroup] = useState<ProductGroup | null>(null);
  // Product grid pagination - starts at 10, grows by 10 each "Load More"
  // tap instead of rendering the entire catalog at once (a busy shop's full
  // product list was a long scroll before this).
  const [visibleProductCount, setVisibleProductCount] = useState(10);
  // Product Code / SKU entry box - see the input's own JSX comment below for
  // the full flow (typed or barcode-scanned -> instant add to cart -> Down
  // Arrow -> service type dropdown).
  const [productCodeInput, setProductCodeInput] = useState('');
  // Keyboard Shortcuts - grid navigation: which visible product card the
  // Arrow keys currently highlight (index into visibleGroups). Space adds
  // the highlighted card to the cart - see the product-grid keydown effect
  // below for the full Arrow/Space/+-/Ctrl+S/Enter handling.
  const [focusedProductIndex, setFocusedProductIndex] = useState(0);
  // Keyboard Shortcuts - Dynamic Numerical Quantities: +/- bumps this cart
  // row's quantity. Sits on the most recently added/incremented item by
  // default (see addToCart), since that's the item staff almost always
  // mean right after adding it - clicking any cart row's own qty buttons
  // (handleIncreaseQty/handleDecreaseQty) also re-targets it here.
  const [activeCartItemIndex, setActiveCartItemIndex] = useState<number | null>(null);
  // Quick Delivery Charges preset (Free/30/50/Custom row) - only ever
  // read/shown for orderType 'Delivery' (see the orderType-change effect
  // below, which resets this back to 0 the moment the cashier switches
  // away from Delivery, so a stale fee can never silently ride along on a
  // DineIn/TakeAway order). isCustomDeliveryFee toggles the manual numeric
  // input open instead of one of the fixed presets.
  const [deliveryFee, setDeliveryFee] = useState(0);
  const [isCustomDeliveryFee, setIsCustomDeliveryFee] = useState(false);

  const suggestionRef = useRef<HTMLDivElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Strict Delivery Field Validation: the address input is the one field
  // among Name/Phone/Address that never had a ref before this feature -
  // validateOrderForm focuses this directly the moment a Delivery order is
  // saved with no address, same as it already does for phone/name.
  const addressInputRef = useRef<HTMLInputElement>(null);
  // Instant Cursor Redirection (no popup): which of the three mandatory
  // Delivery fields just got force-focused because Save was attempted (via
  // click, or the Ctrl+S/Enter shortcut - see the keydown effect below)
  // while it was still empty/invalid. Drives a temporary red-border flash
  // on that exact input (see deliveryFlashClass) - cleared automatically a
  // moment later so the flash reads as a pulse of attention, not a
  // permanent error state once the cashier starts typing.
  const [flashField, setFlashField] = useState<'phone' | 'customer' | 'address' | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
  }, []);

  function flashAndFocus(field: 'phone' | 'customer' | 'address') {
    const ref = field === 'phone' ? phoneInputRef : field === 'customer' ? nameInputRef : addressInputRef;
    ref.current?.focus();
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    setFlashField(field);
    flashTimeoutRef.current = setTimeout(() => setFlashField(null), 1200);
  }

  function deliveryFlashClass(field: 'phone' | 'customer' | 'address') {
    return flashField === field ? ' !border-rose-500 ring-2 ring-rose-300' : '';
  }

  // Strict Disabled Button State: the single source of truth for whether
  // Save Order should look/behave disabled for a Delivery order - reused by
  // both the button's own disabled attribute/style below AND
  // validateOrderForm (so the Ctrl+S/Enter shortcut, which calls
  // handleSaveOrder directly and never touches the button element, is
  // caught by the exact same rule instead of a second, possibly-drifting
  // copy of it).
  function getMissingDeliveryField(): 'phone' | 'customer' | 'address' | null {
    if (orderFormData.orderType !== 'Delivery') return null;
    if (!orderFormData.phone.trim() || !/^03\d{9}$/.test(orderFormData.phone)) return 'phone';
    if (!orderFormData.customer.trim()) return 'customer';
    if (!orderFormData.address.trim()) return 'address';
    return null;
  }
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const productCodeInputRef = useRef<HTMLInputElement>(null);
  // Debounce/Timeout Mechanism for the Product Code box - see
  // handleProductCodeChange's own comment on the multi-digit-code bug this
  // fixes. Same ref+setTimeout/clearTimeout pattern as searchTimeoutRef
  // above, just its own independent timer.
  const productCodeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const productSearchInputRef = useRef<HTMLInputElement>(null);
  // The "service options dropdown" (Dine-In/Takeaway/Delivery) - Down Arrow
  // from the Product Code box jumps straight here, per the Hotkey
  // Navigation Order Flow requirement.
  const orderTypeSelectRef = useRef<HTMLSelectElement>(null);

  // Loads the product grid + waiter dropdown from the local hub's cached
  // reference data instead of the cloud - what makes the POS screen itself
  // usable while this till has no internet. That cache is only ever as
  // fresh as the last successful online load (see the push at the bottom
  // of loadProducts below, plus the 5-minute background push in
  // lib/offline-sync.ts) - if this till has genuinely never been online
  // since install, there's nothing to fall back to yet.
  // `silent` is used for the cache-first warm-paint below (isOnline case) -
  // no point telling the cashier "Offline" for the split second before the
  // real cloud refresh lands right after.
  async function loadProductsFromLocalHub(silent = false) {
    const reachable = await isLocalHubReachable();
    if (!reachable) {
      setCategories(['All']);
      setProducts([]);
      if (silent) return;
      const diagnostics = await getLocalHubStartDiagnostics();
      const reason = diagnostics && !diagnostics.started
        ? ` (${diagnostics.error || t('pos.status.failedToStart')})`
        : '';
      setStatusMessage({ tone: 'error', text: t('pos.status.localHubUnreachable', { reason }) });
      return;
    }
    const snapshot = await getReferenceData();
    const offlineProducts = (snapshot.products || []) as Product[];
    const offlineWaiters = (snapshot.staff || []) as Waiter[];
    const derivedCategories = Array.from(new Set(offlineProducts.map((p) => p.category).filter(Boolean)));
    setCategories(derivedCategories.length ? ['All', ...derivedCategories] : ['All']);
    setProducts(offlineProducts);
    setWaiters(offlineWaiters.filter((waiter) => waiter.isActive));
    if (silent) return;
    if (offlineProducts.length === 0) {
      setStatusMessage({ tone: 'error', text: t('pos.status.noCachedProducts') });
    } else {
      const time = snapshot.updatedAt ? ` (${new Date(snapshot.updatedAt).toLocaleTimeString()})` : '';
      setStatusMessage({ tone: 'info', text: t('pos.status.offlineShowingCache', { time }) });
    }
  }

  useEffect(() => {
    // The real source of truth whenever this till can reach it - fetched
    // in the background on desktop (see loadProducts below) so a cloud
    // round trip never blocks the cashier from seeing products at all, and
    // is the only path at all for a plain browser tab (no Local Hub cache
    // to have shown a moment ago there).
    async function refreshFromCloud() {
      const [productResponse, waiterResponse] = await Promise.all([
        fetchProducts(),
        fetchWaiters(),
      ]);
      setCategories(productResponse?.categories?.length ? productResponse.categories : ['All']);
      setProducts(productResponse?.products ?? []);
      setWaiters(waiterResponse.filter((waiter) => waiter.isActive));
      setStatusMessage((current) => (current?.text.startsWith('Offline') ? null : current));

      // Best-effort - keeps the Local Hub's offline copy fresh the moment
      // this till has real data, instead of only ever updating it on the
      // 5-minute background tick (see lib/offline-sync.ts).
      if (isDesktopApp()) {
        void pushReferenceData({
          shopName: getAuthShop()?.name || '',
          products: productResponse?.products || [],
          customers: [],
          staff: waiterResponse,
          // `roles` deliberately omitted (not sent as []) - this call site
          // only ever refreshes products/waiters; referenceData.js's set()
          // preserves whatever roles offline-sync.ts's own less-frequent
          // full push last put there instead of wiping it out.
        }).catch(() => {});
      }
    }

    async function loadProducts() {
      if (isDesktopApp()) {
        // Cache-first, always - paint instantly from whatever this till
        // already has locally (see lib/local-hub-api.ts) instead of ever
        // making the cashier wait on a cloud round trip just to see the
        // product grid. If we're online, a real refresh then happens
        // quietly in the background and swaps in the moment it lands; if
        // that refresh fails (e.g. isOnline read stale-true for a moment),
        // the cache already on screen simply stays put - no spinner, no
        // visible failure, nothing slowing the cashier down.
        setIsLoadingProducts(true);
        try {
          await loadProductsFromLocalHub(isOnline);
        } finally {
          setIsLoadingProducts(false);
        }
        if (isOnline) {
          refreshFromCloud().catch(() => {
            // Best-effort - the cache already on screen is still valid,
            // and the next isOnline flip or 5-minute sync tick will retry.
          });
        }
        return;
      }

      // Plain browser tab - no Local Hub, no offline story at all.
      setIsLoadingProducts(true);
      try {
        await refreshFromCloud();
      } catch (error) {
        setCategories(['All']);
        setProducts([]);
        setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : t('pos.status.loadProductsFailed') });
      } finally {
        setIsLoadingProducts(false);
      }
    }
    void loadProducts();
  }, [isOnline]);

  useEffect(() => {
    async function loadIngredientStock() {
      try {
        const ingredients = await fetchIngredients();
        const next: Record<string, number> = {};
        (ingredients ?? []).forEach((ingredient) => {
          next[ingredient.name.trim().toLowerCase()] = ingredient.currentStock;
        });
        setIngredientStockByName(next);
      } catch (error) {
        console.error('Failed to load ingredient stock for POS cards:', error);
        // Leave the last-known map in place - the cards just fall back to
        // each product's own stock figure until the next successful load.
      }
    }
    void loadIngredientStock();
  }, [isOnline]);

  // The hidden auto-print iframe (see printReadyUrl below) loads
  // PrintOrderPage.tsx in its own separate React tree - a toast shown from
  // inside it would render invisibly in that hidden iframe. It posts a
  // message up here instead once it's actually called window.print(); this
  // is what shows the popup for real, on screen. See print-notify.ts.
  useEffect(() => listenForPrintSentMessages(shopToast), [shopToast]);

  // Quick Delivery Charges preset only ever means anything on a Delivery
  // order - switching the order type away from Delivery (even after
  // picking a preset) drops it straight back to 0 and closes the Custom
  // input, so a fee picked earlier can never silently ride along onto a
  // DineIn/TakeAway order that gets saved afterward.
  useEffect(() => {
    if (orderFormData.orderType !== 'Delivery') {
      setDeliveryFee(0);
      setIsCustomDeliveryFee(false);
    }
  }, [orderFormData.orderType]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        suggestionRef.current &&
        !suggestionRef.current.contains(event.target as Node) &&
        !phoneInputRef.current?.contains(event.target as Node) &&
        !nameInputRef.current?.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
        setShowNewCustomerPrompt(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setTaxRate(getStoreSettings().taxRate || 0);
    if (!isAuthenticated()) {
      setStatusMessage({ tone: 'info', text: t('pos.status.loginTokenMissing') });
    }
  }, []);

  const productGroups = useMemo<ProductGroup[]>(() => {
    const map = new Map<string, ProductGroup>();
    for (const product of products) {
      // Deals never merge with each other, even if two deals happen to
      // share a name - each deal is its own single-variation group.
      const key = product.isDeal ? `deal:${product.id}` : `${product.category}::${product.name}`;
      const existing = map.get(key);
      if (existing) {
        existing.variations.push(product);
      } else {
        map.set(key, {
          key,
          name: product.name,
          category: product.category,
          image: product.image,
          color: product.color,
          description: product.description,
          isDeal: Boolean(product.isDeal),
          dealItems: product.dealItems,
          variations: [product],
        });
      }
    }
    return Array.from(map.values());
  }, [products]);

  // Memoized so this filter only actually re-runs when the product list,
  // category, or search text change - not on every one of this page's
  // other re-renders (cart edits, form typing, etc.), which is how often
  // an unmemoized version would otherwise be recomputed.
  const filteredGroups = useMemo(
    () => productGroups.filter((group) => {
      const matchesCategory = activeCategory === 'All' || group.category === activeCategory;
      const matchesSearch = group.name.toLowerCase().includes(productSearchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    }),
    [productGroups, activeCategory, productSearchQuery],
  );

  // Changing category or search re-filters the whole list, so a stale
  // "load more" position from the previous filter would otherwise leave
  // the grid showing an arbitrary/inconsistent slice - always restart at
  // 10 whenever the filters themselves change.
  useEffect(() => {
    setVisibleProductCount(10);
  }, [activeCategory, productSearchQuery]);

  const visibleGroups = filteredGroups.slice(0, visibleProductCount);
  const hasMoreProducts = filteredGroups.length > visibleGroups.length;

  // Same reasoning as the visibleProductCount reset above - a stale
  // Arrow-key highlight index from before the filter/search changed could
  // now point at a completely different card, or past the end of a much
  // shorter list.
  useEffect(() => {
    setFocusedProductIndex(0);
  }, [activeCategory, productSearchQuery, viewMode]);

  function handleGroupClick(group: ProductGroup) {
    // Deals and single-variation products (the vast majority - drinks,
    // sides, anything never given a size/flavor breakdown) add straight
    // to the cart exactly like before. Only a group with 2+ variations
    // (e.g. Pizza: Small/Medium/Large) opens the picker.
    if (group.isDeal || group.variations.length <= 1) {
      addToCart(group.variations[0]);
      return;
    }
    setVariationPickerGroup(group);
  }

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tax = (subtotal * taxRate) / 100;
  // Quick Delivery Charges preset - only ever non-zero while orderType is
  // 'Delivery' (see the reset effect above), added straight onto the
  // total exactly like backend/controllers/orderController.js's
  // recalculateTotals does server-side.
  const effectiveDeliveryFee = orderFormData.orderType === 'Delivery' ? deliveryFee : 0;
  // No more per-line Discount field (see the cart row's own comment on
  // handleItemPriceChange below) - every product's amount is directly
  // editable instead, so `subtotal` above already reflects whatever the
  // cashier actually charged for each line, with nothing left to subtract
  // here.
  const total = subtotal + tax + effectiveDeliveryFee;

  // Electricity Bill / Cash special products (system-seeded into every
  // shop - see backend/controllers/superAdminController.js's createShop and
  // Product.specialType's own comment): their presence in the cart is what
  // triggers the extra TID/Bill Name/Recipient Name fields below and the
  // auto-settled payment in handleSaveOrder, keyed off the cart item's own
  // specialType (carried over from the Product in addToCart) rather than
  // matching on a name/translation that could change.
  const hasElectricityBillItem = cart.some((item) => item.specialType === 'electricity_bill');
  const hasCashItem = cart.some((item) => item.specialType === 'cash');

  function addToCart(product: Product) {
    // Same product and same variation merge into one cart row, matching your older POS logic.
    setCart((previousCart) => {
      const existingIndex = previousCart.findIndex((item) => item.id === product.id && item.variation === product.variation);
      if (existingIndex === -1) {
        setActiveCartItemIndex(previousCart.length);
        return [...previousCart, { id: product.id, name: product.name, price: product.price, quantity: 1, variation: product.variation, image: product.image, specialType: product.specialType }];
      }
      setActiveCartItemIndex(existingIndex);
      // Electricity Bill / Cash have no real "quantity" concept - each is
      // one open-amount transaction, not N units of something - so the qty
      // stepper is hidden for them below (cart row JSX) and re-tapping the
      // product card here is a no-op instead of silently bumping quantity
      // to 2 (which would double the typed amount with no visible sign of
      // why).
      if (previousCart[existingIndex].specialType) return previousCart;
      return previousCart.map((item, index) => (index === existingIndex ? { ...item, quantity: item.quantity + 1 } : item));
    });
  }

  function clearCart() {
    setCart([]);
    setActiveCartItemIndex(null);
  }

  // Product Code / SKU lookup: every Product document optionally carries a
  // productCode (set in Manage Products - see ProductManagementSection.tsx),
  // unique per shop (backend/models/Product.js's partial unique index).
  // Keyed by trimmed-lowercase code so a scanner's exact-cased barcode text
  // still matches a code typed in a different case by staff.
  const productCodeLookup = useMemo(() => {
    const map = new Map<string, Product>();
    for (const product of products) {
      const code = product.productCode?.trim().toLowerCase();
      if (code) map.set(code, product);
    }
    return map;
  }, [products]);

  // Product/Deal Barcode Keys: typing (or a barcode scanner "typing", since
  // a scanner is just a fast keyboard) the exact code assigned to a product
  // or deal adds that exact variation to the cart - no mouse, no opening the
  // size picker (the code already identifies the exact size/variation).
  //
  // Debounce/Timeout Mechanism (~350ms): matching on every single keystroke
  // used to be the bug here - typing a multi-digit code like "15" one key at
  // a time matched-and-added product code "1" the instant "1" was typed,
  // then matched-and-added code "5" separately once "5" followed, instead of
  // ever seeing "15" as one code. Waiting a short pause after the LAST
  // keystroke before actually looking the code up (clearing/rescheduling
  // this timer on every change, same pattern as searchTimeoutRef/
  // debouncedSearch above) lets a full multi-digit code finish accumulating
  // first. A literal Enter press (handleProductCodeKeyDown below) still
  // confirms INSTANTLY, bypassing this wait entirely - what a barcode
  // scanner's own trailing Enter keystroke already relies on, and what lets
  // a cashier confirm early without waiting out the debounce.
  function handleProductCodeChange(value: string) {
    setProductCodeInput(value);
    if (productCodeTimeoutRef.current) clearTimeout(productCodeTimeoutRef.current);

    const trimmed = value.trim();
    if (!trimmed) return;

    productCodeTimeoutRef.current = setTimeout(() => {
      productCodeTimeoutRef.current = null;
      const match = productCodeLookup.get(trimmed.toLowerCase());
      if (match) {
        addToCart(match);
        const displayName = `${match.name}${match.variation && match.variation !== 'Standard' ? ` (${match.variation})` : ''}`;
        shopToast.success(t('pos.addedProductViaCode', { name: displayName, code: match.productCode ?? '' }));
        setProductCodeInput('');
      }
    }, 350);
  }

  function handleProductCodeKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Cancel any still-pending debounced lookup from handleProductCodeChange
      // above - without this, that timer would still fire ~350ms later on
      // whatever's left in `productCodeInput` (already cleared to '' below
      // on a hit, so it'd silently no-op; but on a miss it would re-run the
      // same failed lookup a second time and show a duplicate error toast).
      if (productCodeTimeoutRef.current) {
        clearTimeout(productCodeTimeoutRef.current);
        productCodeTimeoutRef.current = null;
      }
      const trimmed = productCodeInput.trim();
      if (!trimmed) return;
      const match = productCodeLookup.get(trimmed.toLowerCase());
      if (match) {
        addToCart(match);
        const displayName = `${match.name}${match.variation && match.variation !== 'Standard' ? ` (${match.variation})` : ''}`;
        shopToast.success(t('pos.addedProductViaCode', { name: displayName, code: match.productCode ?? '' }));
        setProductCodeInput('');
      } else {
        // Visual Product Code Tracing: keep the typed/scanned text visible
        // on a miss instead of wiping it - the cashier needs to actually
        // see what was entered to spot a typo or a bad scan, rather than
        // the field silently going blank. It only clears once the item is
        // successfully added (above) or the cashier clears it themselves.
        shopToast.error(t('pos.noProductCodeMatch', { code: trimmed }));
      }
      return;
    }
    // Hotkey Navigation Order Flow: right after a code-based add, the next
    // natural step is picking Dine-In/Takeaway/Delivery - Down Arrow jumps
    // straight to that dropdown instead of needing a mouse click.
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      orderTypeSelectRef.current?.focus();
    }
  }

  // Keyboard Shortcuts - Operational & Checkout, grid navigation, and
  // Dynamic Numerical Quantities: all POS-screen-local (only active while
  // this page is mounted, unlike the F1-F10 sidebar page hotkeys - see
  // DashboardShell.tsx's global shortcut handler - which work from any
  // dashboard page). Guarded by isTypingTarget so normal typing/selection
  // in the phone/customer/address/note fields, the service type dropdown,
  // and the Product Code box (which handles its own Enter/Down Arrow
  // above) is never hijacked.
  useEffect(() => {
    // Matches the product grid's own CSS floor (grid-cols-4 - see that
    // grid's className) so Up/Down moves roughly one row; on a wider
    // screen where the grid actually renders 5 or 6 columns, Up/Down lands
    // one card off from directly above/below, which is an acceptable
    // approximation given there's no reliable way to read the grid's live
    // column count from CSS at run time.
    const GRID_COLUMNS = 4;

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      // A modal picker is already up front - let its own Esc handler (see
      // VariationPickerModal) be the only thing that reacts to a keypress
      // while it's open, instead of also saving/moving the grid highlight
      // underneath it.
      if (variationPickerGroup) return;

      const typing = isTypingTarget(event.target);

      // Ctrl+T / Ctrl+D: instantly switch the service option to Takeaway /
      // Delivery - no mouse needed, and (like Ctrl+S below) these fire
      // regardless of what's currently focused, since a Ctrl-held combo
      // never types a character into a field. Right after one of these, a
      // bare Enter falls straight through to the Ctrl+S/Enter check below
      // and triggers Save Order/Checkout, exactly as if that service type
      // had been picked from the dropdown by hand.
      if (event.key.toLowerCase() === 't' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setOrderFormData((previous) => ({ ...previous, orderType: 'TakeAway' }));
        return;
      }
      if (event.key.toLowerCase() === 'd' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setOrderFormData((previous) => ({ ...previous, orderType: 'Delivery' }));
        return;
      }

      // Ctrl+S / Enter: Save Order / Checkout. Enter only counts outside a
      // text field (arrow-key/+- grid-navigation focus, a clicked product
      // card, or nothing focused at all all count as "not typing").
      if ((event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) || (event.key === 'Enter' && !typing)) {
        event.preventDefault();
        void handleSaveOrder();
        return;
      }

      if (typing) return;

      // Arrow keys: move the product-grid highlight (see
      // focusedProductIndex's own comment).
      if (viewMode === 'grid' && visibleGroups.length > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        setFocusedProductIndex((previous) => {
          const lastIndex = visibleGroups.length - 1;
          let next = previous;
          if (event.key === 'ArrowRight') next = previous + 1;
          else if (event.key === 'ArrowLeft') next = previous - 1;
          else if (event.key === 'ArrowDown') next = previous + GRID_COLUMNS;
          else if (event.key === 'ArrowUp') next = previous - GRID_COLUMNS;
          return Math.min(Math.max(next, 0), lastIndex);
        });
        return;
      }

      // Space: add the Arrow-highlighted card to the cart - the practical
      // "select" companion to Arrow-key grid navigation (Enter is already
      // claimed by Save Order/Checkout per the Operational Shortcuts spec
      // above, so it isn't also reused as a grid "select" key).
      if (event.key === ' ' && viewMode === 'grid' && visibleGroups[focusedProductIndex]) {
        event.preventDefault();
        handleGroupClick(visibleGroups[focusedProductIndex]);
        return;
      }

      // +/-: bump the active cart item's quantity - see addToCart /
      // handleIncreaseQty / handleDecreaseQty's own comments for how
      // "active" is tracked and kept in sync with mouse clicks/removals.
      if ((event.key === '+' || event.key === '=') && activeCartItemIndex !== null && cart[activeCartItemIndex]) {
        event.preventDefault();
        handleIncreaseQty(activeCartItemIndex);
        return;
      }
      if ((event.key === '-' || event.key === '_') && activeCartItemIndex !== null && cart[activeCartItemIndex]) {
        event.preventDefault();
        handleDecreaseQty(activeCartItemIndex);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variationPickerGroup, viewMode, visibleGroups, focusedProductIndex, activeCartItemIndex, cart]);

  function resetOrderForm() {
    setOrderFormData({ orderType: 'TakeAway', phone: '', customer: '', address: '', previousDues: 0, note: '', waiter: '', billTid: '', billName: '', cashRecipientName: '' });
    setSuggestions([]);
    setShowNewCustomerPrompt(false);
    setSearchQuery('');
    setSelectedCustomerId(null);
    setIsManualEntry(false);
    setShowSuggestions(false);
    setSelectedPaymentMethod('Cash');
  }

  function handleIncreaseQty(index: number) {
    setCart((previousCart) => previousCart.map((item, itemIndex) => (itemIndex === index ? { ...item, quantity: item.quantity + 1 } : item)));
    setActiveCartItemIndex(index);
  }

  function handleDecreaseQty(index: number) {
    setCart((previousCart) =>
      previousCart.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const quantity = Math.max(1, item.quantity - 1);
        return { ...item, quantity };
      })
    );
    setActiveCartItemIndex(index);
  }

  // Every product's own amount is directly editable per cart line (the
  // owner's own request - no separate Discount field any more, since some
  // customers are charged MORE than the catalog rate too, not just less,
  // and a Discount field can't represent that). This was originally used
  // only for Electricity Bill/Cash's open-amount entry; now every ordinary
  // product's cart row uses the exact same handler (see the cart row JSX
  // below) - editing `price` directly instead of layering a discount on
  // top of an untouched catalog price.
  function handleItemPriceChange(index: number, value: string) {
    const nextPrice = Math.max(0, Number(value) || 0);
    setCart((previousCart) => previousCart.map((item, itemIndex) => (itemIndex === index ? { ...item, price: nextPrice } : item)));
  }

  // Lets a cashier click the quantity number itself and type an exact
  // amount (e.g. "34") instead of only tapping +/- one at a time. The
  // input below is deliberately uncontrolled (keyed on the committed
  // quantity - see its own comment) so the cashier's in-progress typing is
  // never fought by a re-render; this handler only runs once, on blur/
  // Enter, to commit whatever was typed back into the cart.
  function handleQuantityInputChange(index: number, value: string) {
    const parsedQuantity = Math.max(1, Math.floor(Number(value)) || 1);
    setCart((previousCart) =>
      previousCart.map((item, itemIndex) => (itemIndex === index ? { ...item, quantity: parsedQuantity } : item))
    );
    setActiveCartItemIndex(index);
  }

  function handleRemoveItem(index: number) {
    setCart((previousCart) => previousCart.filter((_, itemIndex) => itemIndex !== index));
    // The active-cart-item pointer (see its own comment above) needs to
    // shift down along with every row after the one just removed, or it'll
    // point at the wrong row (or past the end of the array) for the next
    // +/- keypress.
    setActiveCartItemIndex((previousIndex) => {
      if (previousIndex === null) return null;
      if (index === previousIndex) return null;
      return index < previousIndex ? previousIndex - 1 : previousIndex;
    });
  }

  async function searchCustomers(query: string, searchBy: 'name' | 'phone' | 'both' = 'both') {
    if (!query.trim() || query.trim().length < 2) {
      setSuggestions([]);
      setShowNewCustomerPrompt(false);
      setShowSuggestions(false);
      return;
    }

    setIsSearching(true);
    setSearchQuery(query);

    try {
      let result: Customer[];
      if (isDesktopApp() && !isOnline) {
        // Offline: filter the Local Hub's cached customer list (kept
        // fresh in the background by offline-sync.ts's periodic
        // pushCurrentReferenceData) client-side instead of a live cloud
        // search - same instant, no-network-required story as the
        // product grid above, instead of this autocomplete just failing
        // outright with nothing to fall back to.
        const snapshot = await getReferenceData();
        const cached = (snapshot.customers || []) as Customer[];
        const q = query.trim().toLowerCase();
        result = cached
          .filter((customer) => {
            const matchesName = searchBy !== 'phone' && (customer.name || '').toLowerCase().includes(q);
            const matchesPhone = searchBy !== 'name' && (customer.phone || '').toLowerCase().includes(q);
            return matchesName || matchesPhone;
          })
          .slice(0, 20);
      } else {
        result = await fetchCustomerSearch(query, searchBy);
      }
      if (result.length > 0) {
        setSuggestions(result);
        setShowNewCustomerPrompt(false);
        setShowSuggestions(true);
      } else {
        setSuggestions([]);
        setShowNewCustomerPrompt(query.trim().length >= 3);
        setShowSuggestions(query.trim().length >= 3);
      }
    } catch (error) {
      shopToast.error(error instanceof Error ? error.message : 'Failed to search customers.');
      setSuggestions([]);
      setShowNewCustomerPrompt(false);
      setShowSuggestions(false);
    } finally {
      setIsSearching(false);
    }
  }

  function debouncedSearch(query: string, searchBy: 'name' | 'phone' | 'both') {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => void searchCustomers(query, searchBy), 250);
  }

  function handleSelectCustomer(customer: Customer) {
    setOrderFormData((previous) => ({ ...previous, customer: customer.name, phone: customer.phone, address: customer.address, previousDues: customer.previousDues }));
    setSelectedCustomerId(customer.id);
    setIsManualEntry(false);
    setSuggestions([]);
    setShowNewCustomerPrompt(false);
    setSearchQuery('');
    setShowSuggestions(false);
    shopToast.success(t('pos.customerLoaded', { name: customer.name }));
  }

  function formatPhoneToDigits(value: string) {
    return value.replace(/\D/g, '').slice(0, 11);
  }

  function handlePhoneChange(event: React.ChangeEvent<HTMLInputElement>) {
    const digits = formatPhoneToDigits(event.target.value);
    setOrderFormData((previous) => ({ ...previous, phone: digits }));
    setIsManualEntry(true);
    if (digits.length >= 2) debouncedSearch(digits, 'phone');
    else {
      setSuggestions([]);
      setShowNewCustomerPrompt(false);
      setShowSuggestions(false);
    }
  }

  function handleNameChange(event: React.ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setOrderFormData((previous) => ({ ...previous, customer: value }));
    setIsManualEntry(true);
    if (value.trim().length >= 2) debouncedSearch(value.trim(), 'name');
    else {
      setSuggestions([]);
      setShowNewCustomerPrompt(false);
      setShowSuggestions(false);
    }
  }

  function handleAddressChange(event: React.ChangeEvent<HTMLInputElement>) {
    setOrderFormData((previous) => ({ ...previous, address: event.target.value }));
    setIsManualEntry(true);
  }

  function handleFormChange(event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = event.target;
    setOrderFormData((previous) => ({ ...previous, [name]: value }));
  }

  function handleCreateNewCustomer() {
    if (!searchQuery.trim()) return;
    const digitsOnly = searchQuery.replace(/\D/g, '');
    const isPhoneSearch = digitsOnly.length >= 3;
    setOrderFormData((previous) => ({ ...previous, phone: isPhoneSearch ? formatPhoneToDigits(searchQuery) : previous.phone, customer: isPhoneSearch ? previous.customer : searchQuery }));
    setIsManualEntry(true);
    setShowNewCustomerPrompt(false);
    setSuggestions([]);
    setShowSuggestions(false);
    if (isPhoneSearch) nameInputRef.current?.focus();
    else phoneInputRef.current?.focus();
    shopToast.info(t('pos.noCustomerMatched'));
  }

  async function updateExistingCustomerIfNeeded() {
    if (!selectedCustomerId || !isManualEntry) return;
    await updateCustomer(selectedCustomerId, { name: orderFormData.customer.trim(), phone: orderFormData.phone, address: orderFormData.address, previousDues: orderFormData.previousDues });
  }

  // Every validation failure surfaces as the same centered popup (title
  // "Can't Save Order") instead of the old top-bar banner - see Technical
  // Requirements for Dynamic Popups #1, whose own example is exactly this:
  // trying to save a dine-in order without picking a table.
  function showValidationError(message: string) {
    popup({ tone: 'error', title: t("pos.cantSaveOrderTitle"), message });
    return false;
  }

  function validateOrderForm() {
    if (cart.length === 0) return showValidationError(t('pos.addProductBeforeSaving'));

    // Strict Delivery Field Validation: unlike TakeAway (name/phone/
    // address optional below), a Delivery order can't be handed to a rider
    // with no idea who to deliver to or where - Customer Name, Phone, and
    // Address are all mandatory here. No popup for this one: the Save
    // button is already visually/strictly disabled the whole time a field
    // is missing (see getMissingDeliveryField, used both for the button's
    // own disabled attribute and here), so the only way this branch is
    // even reached with a field still missing is the Ctrl+S/Enter shortcut
    // bypassing the disabled button - silently redirect focus to the exact
    // field (with a temporary red-border flash - see deliveryFlashClass)
    // instead of interrupting with a modal.
    if (orderFormData.orderType === 'Delivery') {
      const missing = getMissingDeliveryField();
      if (missing) {
        flashAndFocus(missing);
        return false;
      }
      return true;
    }

    // TakeAway: name, phone, and address are all optional - a walk-in
    // counter customer or a quick phone order can check out with none of
    // them. If a phone IS entered though, it still has to be a real, valid
    // number, and a name is required alongside it - a phone with no name
    // (or an invalid one) is more
    // likely a typo than a deliberate walk-in, and a due left on a
    // phone-but-no-name order can't reliably be found again later.
    if (orderFormData.phone && !/^03\d{9}$/.test(orderFormData.phone)) return showValidationError(t('pos.invalidPhoneFormat'));
    if (orderFormData.phone && !orderFormData.customer.trim()) return showValidationError(t('pos.nameRequiredWithPhone'));

    // Electricity Bill / Cash: these are "open amount" products (see
    // handleItemPriceChange) - a cashier who forgets to type the real
    // figure would otherwise save a PKR 0 bill/cash order.
    if (cart.some((item) => item.specialType && item.price <= 0)) {
      return showValidationError(t('pos.specialItemAmountRequired'));
    }
    // Electricity Bill / Cash: the whole point of these two fields is to
    // leave a traceable record of the transaction, so (unlike note/waiter)
    // they're required rather than optional whenever the matching special
    // item is actually in the cart.
    if (hasElectricityBillItem && (!orderFormData.billTid?.trim() || !orderFormData.billName?.trim())) {
      return showValidationError(t('pos.billTidAndNameRequired'));
    }
    if (hasCashItem && !orderFormData.cashRecipientName?.trim()) {
      return showValidationError(t('pos.cashRecipientNameRequired'));
    }
    return true;
  }

  async function handleSaveOrder() {
    if (isSavingOrderRef.current) return;
    if (!validateOrderForm()) return;
    isSavingOrderRef.current = true;
    setIsSavingOrder(true);

    // Guards the background pending-bill toast below (see checkPendingOrder
    // call) from overwriting the real "Order saved" confirmation if that
    // cloud lookup happens to resolve after the order itself already went
    // through - the order finishing is always the more important message.
    let orderFinalized = false;

    try {
      // Both of these are cloud lookups/writes - skipped entirely while
      // offline (the till has no way to reach them, and neither is
      // essential to actually ringing up the order), and now fire-and-
      // forget even while online. Neither one feeds into orderPayload
      // below (the order embeds the customer's name/phone/address exactly
      // as typed, not a re-fetched record, and the pending-bill check is
      // purely an informational toast) - so there's nothing for the
      // cashier to gain by waiting on either cloud round trip before the
      // order itself gets built and saved. Previously these were awaited
      // in sequence, which meant a slow or flaky connection to the remote
      // backend added its full round-trip time (or, worse, a thrown error
      // from updateCustomer) to every single online checkout - up to and
      // including silently failing to place the order at all. Now both
      // just run in the background; if either fails, it's logged and
      // otherwise ignored.
      if (!(isDesktopApp() && !isOnline)) {
        void updateExistingCustomerIfNeeded().catch((err) => {
          console.error('Background customer profile update failed (order still proceeds):', err);
        });

        // A customer is allowed to place a new order even while an older
        // one of theirs is still pending - the old order stays exactly
        // as-is (its own line in the order history / kitchen queue) and
        // the outstanding amount on it is folded into "Previous Dues" the
        // next time any of their bills is paid (see Sales page's Complete
        // Payment panel), instead of blocking checkout outright like
        // before.
        if (orderFormData.phone) {
          void checkPendingOrder(orderFormData.phone)
            .then((pendingOrder) => {
              if (pendingOrder?.exists && !orderFinalized) {
                shopToast.info(t('pos.pendingBillNote'));
              }
            })
            .catch(() => {
              // Non-blocking - if this lookup fails for any reason, the
              // order has already gone through regardless.
            });
        }
      }

      // Name/phone/address are optional for every order type now (see
      // validateOrderForm above) - an empty name falls back to the same
      // placeholder every other page in this app already uses to display a
      // nameless order ('Walk-in Customer' - see RecordPage.tsx/
      // SalesPage.tsx's own label() functions), and an empty phone falls
      // back to the walk-in placeholder number (03000000000) that Customer
      // Dues/Ledger already knows to exclude from tracking.
      const customerName = orderFormData.customer.trim() || 'Walk-in Customer';
      const customerPhone = orderFormData.phone || '03000000000';
      const now = new Date().toISOString();
      const clientSyncId = crypto.randomUUID();

      // Electricity Bill / Cash still go through the exact same
      // pending -> Complete Payment flow as every other order (a shop
      // owner explicitly asked for this after an earlier version of this
      // feature auto-completed the order at Save time) - only the TID/
      // Bill Name/Recipient Name details are special-cased here. See
      // SalesPage.tsx's Complete Payment modal for where the payable
      // amount now gets pre-filled automatically for these two.
      const orderPayload: OrderPayload = {
        orderId: clientSyncId,
        clientSyncId,
        items: cart.map((item) => ({ name: item.name, price: item.price, quantity: item.quantity, variation: item.variation, image: item.image, specialType: item.specialType })),
        total,
        subtotal,
        tax: tax,
        deliveryFee: effectiveDeliveryFee,
        // No per-line Discount any more (see handleItemPriceChange's own
        // comment) - each item's own edited `price` above already IS what
        // the customer was actually charged, so there's no separate
        // discount value left to report here.
        discount: undefined,
        orderType: orderFormData.orderType,
        customer: { name: customerName, phone: customerPhone, address: orderFormData.address },
        address: orderFormData.address,
        note: orderFormData.note,
        waiter: orderFormData.waiter,
        billTid: hasElectricityBillItem ? orderFormData.billTid?.trim() : '',
        billName: hasElectricityBillItem ? orderFormData.billName?.trim() : '',
        cashRecipientName: hasCashItem ? orderFormData.cashRecipientName?.trim() : '',
        status: 'pending',
        paymentMethod: selectedPaymentMethod,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      // Offline mode: only ever attempted inside the desktop app (the
      // Local Hub - see lib/local-hub-api.ts - only exists there). A
      // paired phone's own offline fallback lives in CheckoutScreen.tsx on
      // pos-mobile; this branch is specifically the till's own POS screen
      // placing an order straight into its own Local Hub queue.
      let isOfflineOrder = isDesktopApp() && !isOnline;
      let savedOrder: SavedOrder;

      async function queueLocally() {
        // Any order that takes this path prints locally, immediately,
        // right below (no cloud record exists yet to claim first - see
        // that block's own comment) - whenever a printer is actually
        // configured for it. Telling the Local Hub about that NOW, at
        // queue time, is what lets importOfflineOrders mark the eventual
        // cloud record as already-printed, so DashboardShell.tsx's
        // background KitchenPrintWatcher/ReceiptPrintWatcher don't print
        // this same order a second time the moment it syncs.
        const printSettings = getStoreSettings();
        const isElectronNow = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
        // receipt is always false here now - every order type, TakeAway
        // included, only ever prints its kitchen ticket at placement (see
        // this function's own header comment below and the removed
        // TakeAway-specific block further down this file). The customer
        // receipt prints once, at Complete Order, same as DineIn/Delivery.
        // Either printer counts here ONLY for Urban Crunch (the one shop
        // with category-based counter routing enabled - see
        // kitchen-print-routing.ts) - its orders might route entirely to
        // the counter printer (Ice Cream/Drinks/Shwarma) with no kitchen-
        // printer item at all, but the till still handles all of this
        // order's kitchen-side printing itself at placement below, so the
        // background watcher must stay hands-off either way. Every other
        // shop still only ever prints to kitchenPrinter, so only that flag
        // should count for them.
        const printFlags = {
          kitchen: isElectronNow && !!(printSettings.kitchenPrinter || (isCategoryPrintRoutingEnabled() && printSettings.counterPrinter)),
          receipt: false,
        };
        const localRecord = await createLocalOrder(orderPayload, { name: getAuthUser()?.name || getAuthUser()?.username }, printFlags);
        return {
          ...orderPayload,
          id: `local-${localRecord.id}`,
          dailyOrderNumber: localRecord.localOrderNumber,
          // Tr# - assigned automatically by queueOrder alongside
          // localOrderNumber above, so it's ready to print on the receipt
          // immediately, same as dailyOrderNumber.
          shopSequenceNumber: localRecord.shopSequenceNumber,
        } as SavedOrder;
      }

      // If this till already has offline orders queued and not yet synced,
      // a brand new order MUST also queue locally - never go straight to
      // the cloud - even if we're clearly online right now. Otherwise the
      // cloud's own ticket counter (still sitting wherever it was before
      // this till went offline, since the backlog hasn't synced yet) would
      // hand out a number that collides with one already given to a
      // customer offline (e.g. 20 orders queued offline as #1-20, then a
      // new "online" order also getting #1 because the cloud counter never
      // advanced past 0). Queuing this one locally too keeps every order
      // in ONE unbroken sequence - it becomes #21, and gets its real cloud
      // number in the correct order once the whole backlog syncs together
      // (see orderController.importOfflineOrders' oldest-first ordering).
      let hasLocalBacklog = false;
      if (isDesktopApp() && !isOfflineOrder) {
        try {
          const status = await getSyncStatus();
          hasLocalBacklog = status.pendingCount > 0;
        } catch {
          // Local Hub unreachable is its own problem, handled below by the
          // normal cloud-vs-local race - not a reason to block here.
        }
      }

      if (isOfflineOrder) {
        savedOrder = await queueLocally();
      } else if (isDesktopApp() && hasLocalBacklog) {
        savedOrder = await queueLocally();
        isOfflineOrder = true;
      } else if (isDesktopApp()) {
        // Order numbering must never depend on whether this particular
        // order happens to go through the cloud or not - see
        // orderController.js's createOrder for the backend half of this.
        // Reserve the ticket number from THIS till's own Local Hub FIRST,
        // exactly like an offline order would get one, and send it along
        // so the cloud honors it instead of handing out its own. If the
        // Local Hub can't be reached for some reason, orderPayload simply
        // goes without one and the cloud falls back to its own counter,
        // same as before this existed. These are two completely
        // independent counters (see reserveLifetimeOrderNumber's own
        // comment), so there's no reason to reserve them one after the
        // other and pay for two sequential LAN round trips - running them
        // together via Promise.allSettled halves the time this step adds
        // before the cloud-create race below even starts.
        const [dailyNumberResult, lifetimeNumberResult] = await Promise.allSettled([
          reserveLocalOrderNumber(),
          reserveLifetimeOrderNumber(),
        ]);
        if (dailyNumberResult.status === 'fulfilled') {
          orderPayload.requestedDailyOrderNumber = dailyNumberResult.value;
        }
        if (lifetimeNumberResult.status === 'fulfilled') {
          orderPayload.requestedShopSequenceNumber = lifetimeNumberResult.value;
        }

        // isOnline only re-checks every 5s (see network-status.ts) and can
        // still read stale-true for a moment right after this till
        // actually loses its connection - racing a short timeout here
        // means a genuinely offline till still gets its order queued
        // (with a real ticket number) within a few seconds, instead of the
        // cashier standing at the till waiting out the full 8-second
        // default request timeout first. When actually online (the
        // overwhelming majority of the time) this resolves in well under a
        // second and nothing changes. Safe even if the abandoned cloud
        // request eventually completes in the background anyway -
        // createOrder is idempotent on clientSyncId (see
        // orderController.js), so whichever of the two paths lands first
        // wins and the other is a no-op, never a duplicate order.
        try {
          savedOrder = await Promise.race([
            createOrder(orderPayload) as Promise<SavedOrder>,
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('Cloud order create timed out')), 4000);
            }),
          ]);
        } catch {
          savedOrder = await queueLocally();
          isOfflineOrder = true;
        }
      } else {
        savedOrder = await createOrder(orderPayload) as SavedOrder;
      }

      // Best-effort reconciliation, not the primary numbering mechanism any
      // more (see the reservation above) - just keeps the Local Hub's
      // counter honest in case it was ever unreachable a moment ago (or on
      // pos-mobile's own direct-online path, once that's wired up). See
      // local-hub-api.ts's syncOrderCounter.
      if (isDesktopApp() && !isOfflineOrder && shopSession?.id && typeof savedOrder.dailyOrderNumber === 'number') {
        void syncOrderCounter(shopSession.id, savedOrder.dailyOrderNumber);
      }
      // Same best-effort reconciliation for Tr# - see local-hub-api.ts's
      // syncLifetimeCounter.
      if (isDesktopApp() && !isOfflineOrder && typeof savedOrder.shopSequenceNumber === 'number') {
        void syncLifetimeCounter(savedOrder.shopSequenceNumber);
      }

      // An order queued via createLocalOrder (the offline/backlog branches
      // above) is already instantly visible everywhere - Sales/Dashboard/
      // Kitchen's own loadOrdersFromLocalHub merges in whatever's still
      // sitting in the Local Hub's pending-new-orders queue (see
      // offline-order-helpers.ts's mergeOrdersForDisplay). An order that
      // went straight to the cloud (this branch) has NO such queue entry -
      // it exists in MongoDB the instant createOrder() above resolved, but
      // the Local Hub's own orders CACHE (a separate thing - a snapshot of
      // recent cloud orders, see orderCache.js) doesn't know about it yet.
      // That snapshot only otherwise refreshes on Sales/Dashboard's own
      // 45-second poll or a manual Refresh click - which is exactly the
      // "I have to wait or refresh again and again" gap: the order is
      // real and paid-for, just not in the one place every other page
      // actually reads from yet. Patching it in here, the moment this till
      // knows the order exists, closes that gap without waiting on
      // anything - best-effort and never blocks the UI (the cashier's
      // already been told the order saved by this point).
      if (isDesktopApp() && !isOfflineOrder) {
        void (async () => {
          try {
            const cache = await getOrdersCache();
            const withoutDuplicate = cache.orders.filter((cached) => (cached as SavedOrder).id !== savedOrder.id);
            await pushOrdersCache([savedOrder, ...withoutDuplicate]);
          } catch {
            // Best-effort - the next natural cache refresh (any page's
            // poll, or a manual Refresh) still picks this order up fine.
          }
        })();
      }

      setCart([]);
      resetOrderForm();
      orderFinalized = true;
      // Bring up the Complete Payment popup right away for this order -
      // see completePaymentTarget's own comment above for why.
      setCompletePaymentTarget(savedOrder);
      // A customer-sync failure gets its own warning-toned popup instead of
      // pretending everything went perfectly - the order itself is still
      // saved fine either way.
      const savedOrderLabel = t('pos.orderSavedLabel', { number: savedOrder.dailyOrderNumber || savedOrder.id });
      const contextLine = t('pos.kitchenReceiptPrinting');

      // No blocking pop-ups here by design - the notification bar/bell
      // (see lib/notifications.tsx) is now the sole confirmation surface
      // for a saved order. It also starts this order's 10-minute
      // edit-from-the-bell window (Technical Requirement #3), timestamped
      // from the moment it actually saved on this till, not the server's
      // createdAt (avoids any clock-skew edge case for the window check),
      // and (navigateToPos) brings the POS screen straight back so staff
      // can start the next order immediately - a no-op here since we're
      // already on it, kept for a consistent notify() call shape.
      const confirmationMessage = isOfflineOrder
        ? t('pos.offlineOrderQueued', { number: savedOrder.dailyOrderNumber ?? '' })
        : savedOrder.customerSyncWarning
        ? t('pos.orderSavedWithWarning', { label: savedOrderLabel, warning: savedOrder.customerSyncWarning })
        : t('pos.orderSaved', { label: savedOrderLabel, context: contextLine });
      notify('order_saved', confirmationMessage, { orderId: savedOrder.id, navigateToPos: true });

      const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
      if (isElectron) {
        try {
          const electronRequire = (window as ElectronWindow).require;
          const { ipcRenderer } = electronRequire('electron');
          const settings = getStoreSettings();
          const printLogo = localStorage.getItem('preferred-print-logo');

          // An offline order has no cloud record yet (nothing to claim,
          // and nothing else could possibly be racing to print it - no
          // other till/process can even see it until it syncs), so this
          // till just prints straight away instead of claiming first.
          const claimKitchen = isOfflineOrder ? Promise.resolve() : claimKitchenPrint(savedOrder.id);

          if (settings.kitchenPrinter || settings.counterPrinter) {
            // Claim before printing, same rule the background poll follows
            // (see DashboardShell.tsx) - guarantees this order can never
            // get printed twice even if this till's own immediate-print
            // path and the poll loop somehow race on the same order.
            claimKitchen
              .then(() => {
                // Ice Cream/Drinks and Shwarma items print on the counter
                // printer (Ice Cream+Drinks combined on one slip, Shwarma
                // on its own separate slip) - everything else still prints
                // on the kitchen printer, same as before this split
                // existed. See kitchen-print-routing.ts.
                const categoryLookup = buildCategoryLookup(products);
                void dispatchKitchenPrints(
                  savedOrder.items,
                  categoryLookup,
                  settings,
                  (groupItems, printerName, label) =>
                    reportPrintOutcome(
                      ipcRenderer.invoke('print-kitchen-receipt-data', { ...savedOrder, items: groupItems }, printerName, printLogo, settings),
                      label,
                      shopToast,
                    ),
                );
              })
              .catch((err) => {
                // 409 just means something else already claimed it (the
                // background poll almost certainly beat this to it by a
                // few hundred ms) - not an error, nothing to do.
                if (!(err instanceof ApiError) || err.status !== 409) {
                  console.error('Kitchen print claim failed:', err);
                }
              });
          } else {
            console.warn("No kitchen printer configured in settings.");
          }

          // Every order type - TakeAway included - only ever prints its
          // kitchen ticket right here at placement now. The customer/
          // cashier receipt (and, previously, a small order-number token
          // alongside it) used to print immediately for TakeAway on the
          // reasoning that "they pay and collect right away" - in
          // practice that meant an extra token slip AND a full receipt
          // came out before the order was even paid for. It now prints
          // exactly once, for every order type alike, at Complete Order on
          // the Sales page (or via DashboardShell.tsx's ReceiptPrintWatcher
          // for an order completed from a phone with no printer of its
          // own) - see orderController.js's getUnprintedReceiptOrders.

          // WhatsApp needs the cloud (the session lives on the server) and
          // a real order id to link to - skipped for offline orders; the
          // customer gets notified once this order syncs and creates its
          // real cloud record instead.
          if (!isOfflineOrder) {
            void sendOrderPlacedMessage(savedOrder, settings);
          }
        } catch (err) {
          console.error("Electron print error:", err);
          if (!isOfflineOrder) {
            setPrintReadyUrl(`/dashboard/sales/print/${savedOrder.id}?auto=true&type=kitchen`);
            void sendOrderPlacedMessage(savedOrder, getStoreSettings());
          }
        }
      } else if (!isOfflineOrder) {
        setPrintReadyUrl(`/dashboard/sales/print/${savedOrder.id}?auto=true&type=kitchen`);
        void sendOrderPlacedMessage(savedOrder, getStoreSettings());
      }
    } catch (error) {
      popup({ tone: 'error', title: t("pos.orderNotSavedTitle"), message: error instanceof Error ? error.message : t('pos.orderSaveFailedFallback') });
    } finally {
      isSavingOrderRef.current = false;
      setIsSavingOrder(false);
    }
  }

  async function handleOpenShopFromPOS() {
    setIsOpeningShop(true);
    try {
      if (isDesktopApp() && !isOnline) {
        // No cloud to reach - open locally and let the sync engine turn
        // this into a real ShopSession the moment the till is back online
        // (see offline-sync.ts's reconciliation step).
        openShopLocally();
        shopToast.success(t('pos.shopOpenedOffline'));
        return;
      }
      await openShopSession();
      await refreshShopSession();
      shopToast.success(t('pos.shopOpened'));
    } catch (error) {
      shopToast.error(error instanceof Error ? error.message : t('pos.openShopFailed'));
    } finally {
      setIsOpeningShop(false);
    }
  }

  // The shop must be explicitly opened (see DashboardShell's "Open
  // Shop" button / ShopSessionProvider) before any order can be rung
  // up here -
  // mirrors the same check the backend enforces in orderController.createOrder,
  // so staff see this up front instead of hitting an error after building
  // a whole cart. Loading state is skipped so the screen doesn't flash
  // "closed" for a moment on every page load while the status is fetched.
  if (!shopSessionLoading && !shopIsOpen) {
    const canManage = hasPermission('shop.session.manage');
    return (
      <div className="glass flex min-h-[70vh] flex-col items-center justify-center rounded-[32px] p-10 text-center">
        <div className="glass-pill mb-5 flex h-16 w-16 items-center justify-center rounded-full text-gray-400">
          <Store size={28} />
        </div>
        <h2 className="text-xl font-black text-gray-900">{t('pos.shopClosedTitle')}</h2>
        <p className="mt-2 max-w-sm text-sm font-bold text-gray-400">
          {t('pos.shopClosedMessage')}
        </p>
        {canManage ? (
          <button
            type="button"
            onClick={() => void handleOpenShopFromPOS()}
            disabled={isOpeningShop}
            className="mt-6 flex items-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-emerald-400 to-emerald-600 px-6 py-3 text-sm font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_8px_rgba(6,95,70,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Store size={16} />
            {isOpeningShop ? t('pos.openingShop') : t('pos.openShop')}
          </button>
        ) : (
          <p className="mt-6 text-xs font-bold uppercase tracking-widest text-gray-400">{t('pos.askManagerToOpen')}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 sm:space-y-6">
      {statusMessage ? <StatusBanner tone={statusMessage.tone} text={statusMessage.text} /> : null}
      {/* Checkout sits to the right of the products from tablet width (sm,
          640px) up - never stacking there, even if that means the product
          grid drops to fewer/narrower columns. Below that (a real phone
          screen) there simply isn't room for a 240px+ fixed sidebar next to
          a usable product grid at the same time - that combination doesn't
          fit and used to overflow/break - so it stacks to one column
          instead: full-width product grid, checkout panel underneath. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_280px] sm:gap-4 lg:grid-cols-[minmax(0,1.85fr)_340px] 2xl:grid-cols-[minmax(0,1.85fr)_360px] items-start">
        <section className="space-y-5">
          <div className="glass rounded-[32px] p-4">
            {/* Was `flex-col` on mobile with `self-end` on the view toggle -
                that put the toggle on its own separate line, right-aligned
                with a big empty gap above/left of it (self-end only pushes
                a flex-col child to the end of ITS OWN row, and the search
                bar above was already a full row by itself). A search input
                plus two small icon buttons comfortably fits on one line at
                any real phone width, so this is just one row always now -
                tighter, and no more orphaned toggle row. */}
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="relative min-w-0 flex-1 lg:max-w-md">
                <Search className="absolute left-4 rtl:left-auto rtl:right-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input ref={productSearchInputRef} type="text" value={productSearchQuery} onChange={(event) => setProductSearchQuery(event.target.value)} placeholder={t('pos.searchPlaceholder')} className="w-full rounded-full border border-white/60 bg-white/50 py-3 pl-12 pr-4 rtl:pl-4 rtl:pr-12 text-sm shadow-inner outline-none transition focus:border-[#D6E332]" />
              </div>
              <div className="glass-pill flex shrink-0 items-center gap-2 rounded-full p-1.5">
                <IconToggleButton active={viewMode === 'grid'} onClick={() => setViewMode('grid')}><Grid size={18} /></IconToggleButton>
                <IconToggleButton active={viewMode === 'list'} onClick={() => setViewMode('list')}><List size={18} /></IconToggleButton>
              </div>
            </div>
            {/* Product Code / SKU entry - type a code, or scan a barcode
                (a scanner just types the code fast and hits Enter), and the
                matching product/deal is added to the cart instantly with no
                mouse click (see handleProductCodeChange/handleProductCodeKeyDown
                above). Down Arrow from here jumps straight to the service
                type dropdown (Dine-In/Takeaway/Delivery) in the checkout
                panel, per the Hotkey Navigation Order Flow. */}
            <div className="relative mt-3 lg:max-w-xs">
              <Barcode className="absolute left-4 rtl:left-auto rtl:right-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input
                ref={productCodeInputRef}
                type="text"
                value={productCodeInput}
                onChange={(event) => handleProductCodeChange(event.target.value)}
                onKeyDown={handleProductCodeKeyDown}
                placeholder={t('pos.productCodePlaceholder')}
                className="w-full rounded-full border border-white/60 bg-white/50 py-3 pl-12 pr-4 rtl:pl-4 rtl:pr-12 text-sm shadow-inner outline-none transition focus:border-[#D6E332]"
              />
            </div>
            {/* Wraps onto as many lines as needed instead of scrolling
                sideways - every category is visible and one tap away
                instead of needing to drag a horizontal scrollbar to find
                it, which is what this replaces. */}
            <div className="mt-4 flex flex-wrap gap-1.5">
              {categories.map((category) => (
                <button key={category} type="button" onClick={() => setActiveCategory(category)} className={`whitespace-nowrap rounded-full px-5 py-2.5 text-sm font-bold transition ${activeCategory === category ? 'glass-dark' : 'bg-white/50 text-gray-600 shadow-inner hover:bg-white/70'}`}>
                  {category === 'All' ? t('common.all') : category}
                </button>
              ))}
            </div>
          </div>

          {/* Fixed Card Layout: every card in the grid gets the exact same
              footprint (h-[266px] below) regardless of whether it's a plain
              product or a Deal with a long sub-item list - a fixed-size
              image + flex-col/justify-between content area means the
              price/Select button always lands in the same spot, and a Deal's
              extra sub-item lines scroll inside their own capped-height box
              (see max-h-[64px] overflow-y-auto below) instead of stretching
              the card taller than its neighbours or spilling past its edges.
              Grid: fixed at exactly 4 cards per row on every DESKTOP width
              (sm/640px and up - grid-cols-4, no xl/2xl step-up, never 5/6 on
              a wider screen). Below that, on an actual phone, 4 columns of
              a 266px-tall card has no room to breathe - drops to 2 columns
              instead, the narrowest that still keeps each card legible and
              tappable, rather than reusing the desktop-only fixed count. */}
          <div className={viewMode === 'grid' ? 'grid grid-cols-2 gap-2 sm:grid-cols-4' : 'space-y-2'}>
            {isLoadingProducts ? <SurfaceMessage text={t('pos.loadingProducts')} /> : null}
            {!isLoadingProducts && filteredGroups.length === 0 ? <SurfaceMessage text={t('pos.noProductsMatched')} /> : null}
            {!isLoadingProducts && visibleGroups.length > 0 ? visibleGroups.map((group, groupIndex) => {
              const hasVariations = group.variations.length > 1;
              const cheapestPrice = Math.min(...group.variations.map((v) => v.price));
              const totalStock = group.variations.reduce((sum, v) => sum + (v.stock || 0), 0);
              const matchingIngredientStock = ingredientStockByName[group.name.trim().toLowerCase()];
              const displayStock = matchingIngredientStock !== undefined ? matchingIngredientStock : totalStock;
              // Keyboard Shortcuts - grid navigation: a visible ring around
              // whichever card the Arrow keys currently point to (see the
              // POS-local keydown effect above) - Space adds this exact
              // card to the cart.
              const isKeyboardFocused = viewMode === 'grid' && groupIndex === focusedProductIndex;
              return (
                <button key={group.key} type="button" onClick={() => { handleGroupClick(group); setFocusedProductIndex(groupIndex); }} className={`group overflow-hidden rounded-[20px] border-[0.5px] border-white/50 bg-gradient-to-br from-white/70 to-white/30 p-2.5 text-left rtl:text-right backdrop-blur-xl backdrop-saturate-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-3px_8px_rgba(15,23,42,0.12)] transition hover:-translate-y-0.5 hover:border-[#E2F33C]/70 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_10px_rgba(214,227,50,0.35)] ${isKeyboardFocused ? 'ring-2 ring-[#D6E332] ring-offset-2' : ''} ${viewMode === 'list' ? 'flex items-center gap-3' : 'flex h-[266px] flex-col'}`}>
                  <div className={`relative overflow-hidden rounded-[14px] bg-slate-100 shrink-0 shadow-inner ${viewMode === 'list' ? 'h-16 w-16' : 'mb-2 h-[110px] w-full'}`}>
                    <img src={resolveProductImage(group)} alt={group.name} loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-110" />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent" />
                    {/* Stock badge - top-right corner of the product
                        image, same small-pill treatment as the Family Table
                        "F" badge. Shows the live total stock count across
                        every variation (e.g. "200") so the cashier can see
                        at a glance how much of this product is left, right
                        on the card, without opening it. Replaces the old
                        Pending-order and Product Code/"null" badges that
                        used to occupy these corners. */}
                    <span className="absolute right-1 top-1 rounded-full bg-[#D6E332] px-1.5 py-0.5 text-[8px] font-black leading-none text-gray-900 shadow-sm" title={t('pos.stockBadgeTooltip', { count: displayStock })}>
                      {displayStock}
                    </span>
                  </div>
                  <div className={`flex flex-col justify-between overflow-hidden ${viewMode === 'list' ? 'flex-1 min-w-0' : 'w-full flex-1'}`}>
                    <div className="min-h-0 overflow-hidden">
                      <div className="mb-0.5 flex items-start justify-between gap-1.5">
                        <div className="min-w-0">
                          <h3 className="truncate text-[13px] leading-tight font-black text-gray-800">{group.name}</h3>
                          <p className="truncate text-[9px] font-bold text-gray-400">
                            {hasVariations ? t('pos.sizesOptions', { count: group.variations.length }) : group.variations[0].variation}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-[#EEF4C4] px-1.5 py-0.5 text-[8px] font-black uppercase text-gray-700">{totalStock}</span>
                      </div>
                      {viewMode === 'list' ? (
                        <p className="mb-2 line-clamp-1 text-[10px] text-gray-500">{group.description}</p>
                      ) : null}

                      {/* Deal Content Responsiveness: capped height + its own
                          scrollbar - a 2-item deal and a 12-item deal render
                          at the identical card size, the longer list just
                          scrolls internally instead of resizing the card. */}
                      {group.isDeal && group.dealItems && group.dealItems.length > 0 ? (
                        <div className="mt-1.5 flex flex-col gap-1 max-h-[64px] overflow-y-auto no-scrollbar">
                          {group.dealItems.map((dealItemId) => {
                            const subItem = products.find(p => String(p.id) === dealItemId);
                            if (!subItem) return null;
                            return (
                              <div key={dealItemId} className="text-[9px] font-bold text-gray-500 bg-gray-50 border border-gray-100 rounded-[6px] px-1.5 py-0.5 truncate flex items-center gap-1">
                                <div className="w-1 h-1 rounded-full bg-rose-400 shrink-0"></div>
                                <span className="truncate">{subItem.name} {subItem.variation && subItem.variation !== 'Standard' ? `(${subItem.variation})` : ''}</span>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                    {/* Price gets its own line instead of sharing a row with
                        the Select/Add button - squeezed side by side the two
                        were fighting for width and the price (the important
                        part) was the one getting truncated ("From PKR ..."). */}
                    <div className={`${viewMode === 'list' ? '' : 'mt-3 pt-2 border-t border-gray-50'}`}>
                      <p className="truncate text-[12px] font-black text-gray-900">{hasVariations ? t('pos.fromPrice', { price: cheapestPrice }) : `PKR ${group.variations[0].price}`}</p>
                      <span className="mt-1.5 inline-flex w-fit shrink-0 items-center justify-center rounded-[8px] bg-black h-[22px] px-2.5 text-[9px] font-bold text-white transition group-hover:bg-[#E2F33C] group-hover:text-black">{hasVariations ? t('pos.select') : t('common.add')}</span>
                    </div>
                  </div>
                </button>
              );
            }) : null}
          </div>

          {hasMoreProducts ? (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => setVisibleProductCount((previous) => previous + 10)}
                className="rounded-full bg-white px-6 py-2.5 text-xs font-black text-gray-700 shadow-sm transition hover:bg-gray-50"
              >
                {t('pos.loadMore', { count: filteredGroups.length - visibleGroups.length })}
              </button>
            </div>
          ) : null}
        </section>

        <aside className="glass sticky top-6 rounded-[24px]">
          <div className="border-b border-white/40 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">{t('pos.currentOrder')}</p>
                <h2 className="text-xl font-black text-gray-900">{t('pos.posCheckout')}</h2>
              </div>
              <button type="button" onClick={clearCart} disabled={cart.length === 0} className="glass-pill rounded-xl p-2.5 text-gray-400 transition hover:bg-rose-50/70 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-50">
                <Trash2 size={16} />
              </button>
            </div>
          </div>

          <div className="space-y-3 border-b border-white/40 bg-white/25 p-4">
            <select ref={orderTypeSelectRef} name="orderType" value={orderFormData.orderType} onChange={handleFormChange} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none">
              <option value="TakeAway">{t('pos.orderType.takeAway')}</option>
              <option value="Delivery">{t('pos.orderType.delivery')}</option>
            </select>

            <div className="relative space-y-3">
              <FormField label={t('pos.phoneNumberLabel')}>
                <input ref={phoneInputRef} name="phone" value={orderFormData.phone} onChange={handlePhoneChange} onFocus={() => (suggestions.length > 0 || showNewCustomerPrompt) && setShowSuggestions(true)} placeholder={t('pos.phonePlaceholder')} className={`w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none transition-colors duration-300${deliveryFlashClass('phone')}`} />
              </FormField>
              <FormField label={t('pos.customerNameLabel')}>
                <input ref={nameInputRef} name="customer" value={orderFormData.customer} onChange={handleNameChange} onFocus={() => (suggestions.length > 0 || showNewCustomerPrompt) && setShowSuggestions(true)} placeholder={t('pos.customerNamePlaceholder')} className={`w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none transition-colors duration-300${deliveryFlashClass('customer')}`} />
              </FormField>

              {showSuggestions && (suggestions.length > 0 || showNewCustomerPrompt) ? (
                <div ref={suggestionRef} className="glass-strong absolute left-0 right-0 top-[124px] z-20 overflow-hidden rounded-2xl">
                  {isSearching ? <div className="p-3 text-xs text-gray-500">{t('pos.searchingCustomers')}</div> : null}
                  {!isSearching ? suggestions.map((customer) => (
                    <button key={customer.id} type="button" onClick={() => handleSelectCustomer(customer)} className="block w-full border-b border-white/40 px-3 py-2 text-left rtl:text-right transition hover:bg-white/50">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-bold text-gray-900">{customer.name}</p>
                          <p className="text-[11px] text-gray-500">{customer.phone}</p>
                          <p className="text-[10px] text-gray-400">{customer.address}</p>
                        </div>
                        {customer.previousDues > 0 ? <span className="rounded-full bg-rose-50 px-2.5 py-1 text-[10px] font-bold text-rose-600">{t('pos.dueAmount', { amount: customer.previousDues })}</span> : null}
                      </div>
                    </button>
                  )) : null}
                  {!isSearching && showNewCustomerPrompt ? (
                    <button type="button" onClick={handleCreateNewCustomer} className="flex w-full items-center gap-2 bg-emerald-50/60 px-3 py-2 text-left rtl:text-right text-emerald-700 transition hover:bg-emerald-100/70">
                      <UserPlus size={16} />
                      <div>
                        <p className="text-sm font-bold">{t('pos.addNewCustomer')}</p>
                        <p className="text-[10px]">{searchQuery.replace(/\D/g, '').length >= 3 ? t('pos.usePhone', { phone: formatPhoneToDigits(searchQuery) }) : t('pos.useName', { name: searchQuery })}</p>
                      </div>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <FormField label={t('common.address')}>
              <input ref={addressInputRef} name="address" value={orderFormData.address} onChange={handleAddressChange} placeholder={orderFormData.orderType === 'Delivery' ? t('pos.addressPlaceholderDelivery') : t('pos.addressPlaceholder')} className={`w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none transition-colors duration-300${deliveryFlashClass('address')}`} />
            </FormField>

            {orderFormData.orderType === 'Delivery' ? (
              <FormField label={t('pos.deliveryFeeLabel')}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <DeliveryFeeButton label={t('pos.free')} active={!isCustomDeliveryFee && deliveryFee === 0} onClick={() => { setIsCustomDeliveryFee(false); setDeliveryFee(0); }} />
                  <DeliveryFeeButton label="30" active={!isCustomDeliveryFee && deliveryFee === 30} onClick={() => { setIsCustomDeliveryFee(false); setDeliveryFee(30); }} />
                  <DeliveryFeeButton label="50" active={!isCustomDeliveryFee && deliveryFee === 50} onClick={() => { setIsCustomDeliveryFee(false); setDeliveryFee(50); }} />
                  <DeliveryFeeButton label={t('pos.custom')} active={isCustomDeliveryFee} onClick={() => setIsCustomDeliveryFee(true)} />
                </div>
                {isCustomDeliveryFee ? (
                  <input
                    type="number"
                    min={0}
                    autoFocus
                    value={deliveryFee === 0 ? '' : deliveryFee}
                    onChange={(event) => setDeliveryFee(Math.max(Number(event.target.value) || 0, 0))}
                    placeholder={t('pos.customDeliveryFeePlaceholder')}
                    className="mt-1.5 w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none"
                  />
                ) : null}
              </FormField>
            ) : null}

            <FormField label={t('pos.orderNoteLabel')}>
              <input name="note" value={orderFormData.note} onChange={handleFormChange} placeholder={t('pos.orderNotePlaceholder')} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none" />
            </FormField>

            {hasElectricityBillItem ? (
              <>
                <FormField label={t('pos.billTidLabel')}>
                  <input name="billTid" value={orderFormData.billTid || ''} onChange={handleFormChange} placeholder={t('pos.billTidPlaceholder')} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none" />
                </FormField>
                <FormField label={t('pos.billNameLabel')}>
                  <input name="billName" value={orderFormData.billName || ''} onChange={handleFormChange} placeholder={t('pos.billNamePlaceholder')} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none" />
                </FormField>
              </>
            ) : null}

            {hasCashItem ? (
              <FormField label={t('pos.cashRecipientNameLabel')}>
                <input name="cashRecipientName" value={orderFormData.cashRecipientName || ''} onChange={handleFormChange} placeholder={t('pos.cashRecipientNamePlaceholder')} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none" />
              </FormField>
            ) : null}

            {selectedCustomerId ? (
              <div className="rounded-xl border border-sky-200/70 bg-sky-50/60 p-2.5 text-[11px] text-sky-700 shadow-inner">
                <div className="flex items-start gap-1.5">
                  <AlertCircle size={14} className="mt-0.5" />
                  <span>{isManualEntry ? t('pos.editingExistingCustomer') : t('pos.customerLoadedFromRecords')}</span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="max-h-[300px] 2xl:max-h-[380px] space-y-3 overflow-y-auto p-4">
            {cart.length === 0 ? (
              <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-[20px] border border-dashed border-white/60 bg-white/30 text-center text-gray-400">
                <ShoppingBag size={40} strokeWidth={1.4} />
                <div>
                  <p className="text-sm font-bold text-gray-500">{t('pos.emptyCartTitle')}</p>
                  <p className="text-[11px]">{t('pos.emptyCartMessage')}</p>
                </div>
              </div>
            ) : cart.map((item, index) => (
              <div key={`${item.id}-${item.variation}-${index}`} className="flex items-center gap-2.5 rounded-[20px] bg-white/45 p-2.5 shadow-inner">
                <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[14px] bg-slate-100 shadow-inner">
                  <img src={resolveProductImage({ image: item.image, name: item.name })} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-gray-900">{item.name}</p>
                  <p className="truncate text-[10px] text-gray-400">{item.variation}</p>
                  {item.specialType ? (
                    // Open-amount entry - the real bill/cash figure, typed
                    // fresh every time (see handleItemPriceChange's own
                    // comment) instead of the fixed catalog price every
                    // other product shows below.
                    <div className="mt-1 flex items-center gap-1">
                      <span className="text-[10px] font-semibold text-gray-500">PKR</span>
                      <input
                        type="number"
                        min={0}
                        autoFocus
                        value={item.price === 0 ? '' : item.price}
                        onChange={(event) => handleItemPriceChange(index, event.target.value)}
                        placeholder={t('pos.enterAmountPlaceholder')}
                        className="w-24 rounded-lg border border-white/60 bg-white/70 px-2 py-1 text-xs font-bold text-gray-900 shadow-inner outline-none"
                      />
                    </div>
                  ) : (
                    // Ordinary products: the catalog price (see addToCart)
                    // is the starting value, but directly editable per
                    // line - a cashier can charge less OR more than the
                    // catalog rate for this one sale (e.g. a negotiated
                    // price), same handleItemPriceChange used above for
                    // Electricity Bill/Cash's own open amount.
                    <div className="mt-1 flex items-center gap-1">
                      <span className="text-[10px] font-semibold text-gray-500">PKR</span>
                      <input
                        type="number"
                        min={0}
                        value={item.price === 0 ? '' : item.price}
                        onChange={(event) => handleItemPriceChange(index, event.target.value)}
                        className="w-20 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-[10px] font-semibold text-gray-700 shadow-none outline-none transition focus:border-white/60 focus:bg-white/70 focus:shadow-inner [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                    </div>
                  )}
                </div>
                {/* Electricity Bill / Cash are one-off, open-amount
                    transactions - there's no real "quantity" to bump (see
                    addToCart's own comment on why re-tapping the card is a
                    no-op for these), so the qty stepper is hidden entirely
                    instead of sitting there pinned at 1. */}
                {!item.specialType ? (
                <div className="glass-pill flex items-center gap-1 rounded-full p-1">
                  <button type="button" onClick={() => handleDecreaseQty(index)} className="rounded-full p-1.5 text-gray-500 transition hover:bg-white/70"><Minus size={10} /></button>
                  {/* Uncontrolled + remounted-on-commit: keying on the
                      committed item.quantity means the box only ever
                      resets to the cart's real value right after a commit
                      (this input's own blur/Enter, or the +/- buttons) -
                      never mid-keystroke, so typing "34" isn't fought by
                      a re-render on every character. */}
                  <input
                    key={`qty-${item.id}-${item.variation}-${index}-${item.quantity}`}
                    type="number"
                    min={1}
                    defaultValue={item.quantity}
                    onFocus={(event) => event.target.select()}
                    onBlur={(event) => handleQuantityInputChange(index, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    className="w-9 min-w-5 rounded-md border border-transparent bg-transparent text-center text-xs font-black text-gray-900 outline-none focus:border-white/70 focus:bg-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <button type="button" onClick={() => handleIncreaseQty(index)} className="rounded-full p-1.5 text-gray-500 transition hover:bg-white/70"><Plus size={10} /></button>
                </div>
                ) : null}
                <div className="min-w-[60px] text-right rtl:text-left">
                  <p className="text-sm font-black text-gray-900">PKR {item.price * item.quantity}</p>
                  <button type="button" onClick={() => handleRemoveItem(index)} className="mt-1 text-[10px] font-semibold text-rose-500 transition hover:text-rose-700">{t('pos.remove')}</button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3 rounded-b-[24px] border-t border-white/40 bg-white/25 p-4">
            <div className="grid grid-cols-3 gap-2">
              <PaymentButton icon={<Banknote size={16} />} label={t('pos.paymentCash')} active={selectedPaymentMethod === 'Cash'} onClick={() => setSelectedPaymentMethod('Cash')} />
              <PaymentButton icon={<CreditCard size={16} />} label={t('pos.paymentCard')} active={selectedPaymentMethod === 'Card'} onClick={() => setSelectedPaymentMethod('Card')} />
              <PaymentButton icon={<Wallet size={16} />} label={t('pos.paymentEWallet')} active={selectedPaymentMethod === 'E-Wallet'} onClick={() => setSelectedPaymentMethod('E-Wallet')} />
            </div>
            <div className="space-y-1.5 rounded-[20px] bg-white/50 p-3 shadow-inner">
              <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500"><span>{t('pos.itemsTotal')}</span><span>PKR {subtotal}</span></div>
              <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500"><span>{t('pos.taxLabel', { rate: taxRate })}</span><span>PKR {Math.round(tax)}</span></div>
              {orderFormData.orderType === 'Delivery' ? (
                <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500"><span>{t('pos.deliveryFeeLabel')}</span><span>{effectiveDeliveryFee > 0 ? `PKR ${effectiveDeliveryFee}` : t('pos.free')}</span></div>
              ) : null}
              <div className="flex items-center justify-between pt-1.5 text-base font-black text-gray-900"><span>{t('pos.totalPayable')}</span><span className="text-emerald-600">PKR {Math.round(total)}</span></div>
            </div>
            <button type="button" onClick={() => void handleSaveOrder()} disabled={isSavingOrder || cart.length === 0 || getMissingDeliveryField() !== null} className="w-full flex items-center justify-center gap-2 rounded-[20px] border-[0.5px] border-white/50 bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] px-5 py-3 text-base font-black text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-3px_8px_rgba(132,144,10,0.4)] transition hover:brightness-105 hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50">
              {isSavingOrder ? <Loader2 size={18} className="animate-spin" /> : null} {isSavingOrder ? t('pos.savingOrder') : t('pos.saveOrder')}
            </button>
          </div>
        </aside>
      </div>

      {/* Hidden iframe that loads the receipt and triggers browser window.print() */}
      {printReadyUrl ? <iframe src={printReadyUrl} className="hidden" title={t('pos.autoPrintFrameTitle')} /> : null}

      {variationPickerGroup ? (
        <VariationPickerModal
          group={variationPickerGroup}
          onSelect={(variation) => {
            addToCart(variation);
            setVariationPickerGroup(null);
          }}
          onClose={() => setVariationPickerGroup(null)}
        />
      ) : null}

      {completePaymentTarget ? (
        <CompleteOrderModal
          order={completePaymentTarget}
          isOnline={isOnline}
          toast={shopToast}
          onClose={() => setCompletePaymentTarget(null)}
          onCompleted={() => setCompletePaymentTarget(null)}
          setPrintReadyUrl={setPrintReadyUrl}
        />
      ) : null}
    </div>
  );
}

function StatusBanner({ tone, text }: { tone: 'success' | 'error' | 'info'; text: string }) {
  return (
    <div className={`glass rounded-[28px] px-5 py-4 text-sm ${tone === 'success' ? 'text-emerald-700' : tone === 'error' ? 'text-rose-700' : 'text-sky-700'}`}>
      {text}
    </div>
  );
}

function SurfaceMessage({ text }: { text: string }) {
  return <div className="glass rounded-[32px] p-8 text-sm text-gray-500">{text}</div>;
}

function IconToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`rounded-full p-2.5 transition ${active ? 'glass-dark' : 'text-gray-500'}`}>{children}</button>;
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</label>
      {children}
    </div>
  );
}

function VariationPickerModal({ group, onSelect, onClose }: { group: ProductGroup; onSelect: (variation: Product) => void; onClose: () => void }) {
  const { t } = useLanguage();
  // Keyboard Shortcuts: Esc closes this popup instantly, same as the shared
  // toast.tsx confirm/popup dialogs - this one's local since the picker
  // isn't part of that shared system.
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);
  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);

  return (
    <div className="glass-overlay fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-strong w-full max-w-sm rounded-[28px] p-6" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center gap-3">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-[16px] bg-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_6px_16px_-6px_rgba(0,0,0,0.3)]">
            <img src={resolveProductImage(group)} alt={group.name} className="h-full w-full object-cover" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-lg font-black text-gray-900">{group.name}</h3>
            <p className="text-xs font-bold text-gray-400">{t('pos.chooseVariation')}</p>
          </div>
        </div>
        <div className="max-h-[320px] space-y-2 overflow-y-auto">
          {group.variations.map((variation) => (
            <button
              key={variation.id}
              type="button"
              onClick={() => onSelect(variation)}
              className="flex w-full items-center justify-between rounded-2xl border border-white/50 bg-white/50 px-4 py-3 text-left rtl:text-right shadow-inner transition hover:border-[#E2F33C]/70 hover:bg-[#FBFDEB]/70"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-gray-900">{variation.variation || t('pos.standardVariation')}</p>
                <p className="text-[10px] font-bold text-gray-400">{variation.stock > 0 ? t('pos.inStock', { count: variation.stock }) : t('pos.unlimitedStock')}</p>
              </div>
              <span className="shrink-0 text-sm font-black text-gray-900">PKR {variation.price}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="glass-pill mt-4 w-full rounded-2xl py-3 text-sm font-black text-gray-600 transition hover:bg-white/70">
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

function PaymentButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-xl border px-2.5 py-2.5 transition ${active ? 'border-[#D6E332] bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-2px_6px_rgba(132,144,10,0.4)]' : 'border-white/50 bg-white/50 text-gray-500 shadow-inner hover:border-[#E2F33C]/70'}`}>
      <div className="flex flex-col items-center gap-1.5">
        {icon}
        <span className="text-[9px] font-bold uppercase tracking-wide">{label}</span>
      </div>
    </button>
  );
}

// Quick Delivery Charges preset button (Free/30/50/Custom) - same active/
// inactive visual language as PaymentButton above, just compact enough to
// sit four-across in the delivery checkout panel.
function DeliveryFeeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition ${active ? 'border-[#D6E332] bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-2px_6px_rgba(132,144,10,0.4)]' : 'border-white/50 bg-white/50 text-gray-500 shadow-inner hover:border-[#E2F33C]/70'}`}>
      {label}
    </button>
  );
}

function hasCustomerPhone(order: SavedOrder) {
  return Boolean(order.customer.phone && order.customer.phone !== '03000000000');
}

function orderNumber(order: SavedOrder) {
  return String(order.dailyOrderNumber ?? order.id.slice(-4)).padStart(3, '0');
}

async function sendOrderPlacedMessage(order: SavedOrder, settings?: ReturnType<typeof getStoreSettings>) {
  if (!hasCustomerPhone(order)) return;

  const header = settings?.receiptHeader || 'The Heaven Slice';
  const orderType = order.orderType === 'DineIn' ? 'Dine In' : order.orderType === 'TakeAway' ? 'Take Away' : 'Delivery';
  const lines = [
    `*${header}*`,
    `Dear ${order.customer.name || 'Customer'}, your order has been placed.`,
    `Order No: *${orderNumber(order)}*`,
    `Order Type: ${orderType}`,
    `Total: *PKR ${Math.round(order.total)}*`,
    '',
    'We will share your receipt when the order is completed.',
    `Thank you for ordering from ${header}.`,
  ];

  await sendWhatsappMessage(order.customer.phone, lines.join('\n')).catch((error) => {
    console.error('Failed to send order placed WhatsApp message:', error);
  });
}
