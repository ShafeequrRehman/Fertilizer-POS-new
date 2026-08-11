import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Banknote, CreditCard, Grid, List, Minus, Plus, Search, ShoppingBag, Trash2, UserPlus, Wallet } from 'lucide-react';
import { ApiError, checkPendingOrder, claimKitchenPrint, claimReceiptPrint, createOrder, fetchCustomerSearch, fetchProducts, fetchWaiters, isAuthenticated, updateCustomer, sendWhatsappMessage, openShopSession } from '@/lib/pos-api';
import { CartItem, Customer, OrderFormData, OrderPayload, Product, Waiter } from '@/lib/pos-types';
import { getProductImageUrl } from '@/lib/asset-path';
import { getStoreSettings } from '@/lib/pos-settings';
import { SavedOrder } from '@/lib/pos-types';
import { useShopSession } from '@/lib/shop-session';
import { hasPermission, getAuthUser, getAuthShop } from '@/lib/auth';
import { useToast } from '@/lib/toast';
import { useNetworkStatus } from '@/lib/network-status';
import { isDesktopApp } from '@/lib/api';
import { createLocalOrder, getReferenceData, pushReferenceData, isLocalHubReachable, getLocalHubStartDiagnostics } from '@/lib/local-hub-api';
import { Store } from 'lucide-react';

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
  const { isOpen: shopIsOpen, loading: shopSessionLoading, refresh: refreshShopSession, openLocally: openShopLocally } = useShopSession();
  const { toast: shopToast } = useToast();
  const { isOnline } = useNetworkStatus();
  const [isOpeningShop, setIsOpeningShop] = useState(false);
  const [categories, setCategories] = useState<string[]>(['All']);
  const [products, setProducts] = useState<Product[]>([]);
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
  const [orderFormData, setOrderFormData] = useState<OrderFormData>({ orderType: 'DineIn', phone: '', customer: '', address: '', previousDues: 0, note: '', waiter: '', table: '' });
  const [printReadyUrl, setPrintReadyUrl] = useState<string | null>(null);
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

  const suggestionRef = useRef<HTMLDivElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Loads the product grid + waiter dropdown from the local hub's cached
  // reference data instead of the cloud - what makes the POS screen itself
  // usable while this till has no internet. That cache is only ever as
  // fresh as the last successful online load (see the push at the bottom
  // of loadProducts below, plus the 5-minute background push in
  // lib/offline-sync.ts) - if this till has genuinely never been online
  // since install, there's nothing to fall back to yet.
  async function loadProductsFromLocalHub() {
    const reachable = await isLocalHubReachable();
    if (!reachable) {
      setCategories(['All']);
      setProducts([]);
      const diagnostics = await getLocalHubStartDiagnostics();
      const reason = diagnostics && !diagnostics.started
        ? ` (${diagnostics.error || 'failed to start'})`
        : '';
      setStatusMessage({ tone: 'error', text: `Offline, and the Local Hub isn't reachable either${reason} - restart the app to enable offline mode.` });
      return;
    }
    const snapshot = await getReferenceData();
    const offlineProducts = (snapshot.products || []) as Product[];
    const offlineWaiters = (snapshot.staff || []) as Waiter[];
    const derivedCategories = Array.from(new Set(offlineProducts.map((p) => p.category).filter(Boolean)));
    setCategories(derivedCategories.length ? ['All', ...derivedCategories] : ['All']);
    setProducts(offlineProducts);
    setWaiters(offlineWaiters.filter((waiter) => waiter.isActive));
    if (offlineProducts.length === 0) {
      setStatusMessage({ tone: 'error', text: "Offline - no cached product data yet. Connect to the internet at least once so this till can build an offline copy." });
    } else {
      setStatusMessage({ tone: 'info', text: `Offline - showing the product list as of the last sync${snapshot.updatedAt ? ` (${new Date(snapshot.updatedAt).toLocaleTimeString()})` : ''}.` });
    }
  }

  useEffect(() => {
    async function loadProducts() {
      if (isDesktopApp() && !isOnline) {
        setIsLoadingProducts(true);
        try {
          await loadProductsFromLocalHub();
        } finally {
          setIsLoadingProducts(false);
        }
        return;
      }

      try {
        const cloudLoad = Promise.all([fetchProducts(), fetchWaiters()]);
        // useNetworkStatus only re-checks every 5s (see network-status.ts),
        // so isOnline can still read stale-true for a moment right after
        // this till actually loses its connection - without a bound here,
        // that moment would show a "Loading products..." spinner for the
        // full 8s cloud-request timeout (see AXIOS_REQUEST_TIMEOUT_MS in
        // lib/api.ts) before falling back to the offline cache. Racing a
        // shorter timeout here keeps that worst case to ~4s instead, at
        // the cost of occasionally falling back to a slightly-stale cache
        // on a genuinely online but very slow connection - an acceptable
        // trade given the till re-runs this effect (with fresh data) the
        // moment isOnline itself catches up.
        const [productResponse, waiterResponse] = isDesktopApp()
          ? await Promise.race([
              cloudLoad,
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Cloud product load timed out')), 4000);
              }),
            ])
          : await cloudLoad;
        setCategories(productResponse?.categories?.length ? productResponse.categories : ['All']);
        setProducts(productResponse?.products ?? []);
        setWaiters(waiterResponse.filter((waiter) => waiter.isActive));

        // Best-effort - keeps the Local Hub's offline copy fresh the
        // moment this till has real data, instead of only ever updating
        // it on the 5-minute background tick (see lib/offline-sync.ts).
        // Never allowed to affect the online product grid above.
        if (isDesktopApp()) {
          void pushReferenceData({
            shopName: getAuthShop()?.name || '',
            products: productResponse?.products || [],
            customers: [],
            staff: waiterResponse,
          }).catch(() => {});
        }
      } catch (error) {
        if (isDesktopApp()) {
          // The cloud call itself failed (e.g. connectivity dropped
          // between the online check above and this request actually
          // going out) - fall back the same way the isOnline branch does,
          // rather than showing a dead product grid.
          await loadProductsFromLocalHub();
        } else {
          setCategories(['All']);
          setProducts([]);
          setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Failed to load products from database.' });
        }
      } finally {
        setIsLoadingProducts(false);
      }
    }
    void loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

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
      setStatusMessage({ tone: 'info', text: 'Login token not found. Orders will not sync to MongoDB until you log in again.' });
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

  const filteredGroups = productGroups.filter((group) => {
    const matchesCategory = activeCategory === 'All' || group.category === activeCategory;
    const matchesSearch = group.name.toLowerCase().includes(productSearchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  // Changing category or search re-filters the whole list, so a stale
  // "load more" position from the previous filter would otherwise leave
  // the grid showing an arbitrary/inconsistent slice - always restart at
  // 10 whenever the filters themselves change.
  useEffect(() => {
    setVisibleProductCount(10);
  }, [activeCategory, productSearchQuery]);

  const visibleGroups = filteredGroups.slice(0, visibleProductCount);
  const hasMoreProducts = filteredGroups.length > visibleGroups.length;

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
  const total = subtotal + tax;

  function showMessage(tone: 'success' | 'error' | 'info', text: string) {
    setStatusMessage({ tone, text });
  }

  function addToCart(product: Product) {
    // Same product and same variation merge into one cart row, matching your older POS logic.
    setCart((previousCart) => {
      const existingIndex = previousCart.findIndex((item) => item.id === product.id && item.variation === product.variation);
      if (existingIndex === -1) {
        return [...previousCart, { id: product.id, name: product.name, price: product.price, quantity: 1, variation: product.variation, image: product.image }];
      }
      return previousCart.map((item, index) => (index === existingIndex ? { ...item, quantity: item.quantity + 1 } : item));
    });
  }

  function clearCart() {
    setCart([]);
  }

  function resetOrderForm() {
    setOrderFormData({ orderType: 'DineIn', phone: '', customer: '', address: '', previousDues: 0, note: '', waiter: '', table: '' });
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
  }

  function handleDecreaseQty(index: number) {
    setCart((previousCart) => previousCart.map((item, itemIndex) => (itemIndex === index ? { ...item, quantity: Math.max(1, item.quantity - 1) } : item)));
  }

  function handleRemoveItem(index: number) {
    setCart((previousCart) => previousCart.filter((_, itemIndex) => itemIndex !== index));
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
      const result = await fetchCustomerSearch(query, searchBy);
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
      showMessage('error', error instanceof Error ? error.message : 'Failed to search customers.');
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
    showMessage('success', `Customer "${customer.name}" loaded into the order form.`);
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
    showMessage('info', 'No saved customer matched. Fill the remaining fields to create one during checkout.');
  }

  async function updateExistingCustomerIfNeeded() {
    if (!selectedCustomerId || !isManualEntry) return;
    await updateCustomer(selectedCustomerId, { name: orderFormData.customer.trim(), phone: orderFormData.phone, address: orderFormData.address, previousDues: orderFormData.previousDues });
  }

  function validateOrderForm() {
    if (cart.length === 0) return showMessage('error', 'Add at least one product before saving the order.'), false;

    if (orderFormData.orderType === 'DineIn') {
      if (!orderFormData.table) return showMessage('error', 'Table number is required for dine-in orders.'), false;
      if (orderFormData.phone && !/^03\d{9}$/.test(orderFormData.phone)) return showMessage('error', 'Use phone format 03XXXXXXXXX, or leave it empty for dine-in.'), false;
      if (orderFormData.phone && !orderFormData.customer.trim()) return showMessage('error', 'Customer name is required when a dine-in phone number is entered.'), false;
      return true;
    }

    if (!orderFormData.customer.trim()) return showMessage('error', 'Customer name is required for takeaway and delivery orders.'), false;
    if (!/^03\d{9}$/.test(orderFormData.phone)) return showMessage('error', 'Use phone format 03XXXXXXXXX for takeaway and delivery orders.'), false;
    if (orderFormData.orderType === 'Delivery' && !orderFormData.address.trim()) return showMessage('error', 'Address is required for delivery orders.'), false;
    return true;
  }

  async function handleSaveOrder() {
    if (isSavingOrderRef.current) return;
    if (!validateOrderForm()) return;
    isSavingOrderRef.current = true;
    setIsSavingOrder(true);
    setStatusMessage(null);

    try {
      // Both of these are cloud lookups/writes - skipped entirely while
      // offline (the till has no way to reach them, and neither is
      // essential to actually ringing up the order) rather than letting a
      // failed network call here block the whole offline order from
      // saving to the Local Hub below.
      if (isDesktopApp() && !isOnline) {
        // no-op: see the branch below, which builds orderPayload and then
        // queues it locally instead of touching the network at all.
      } else {
        await updateExistingCustomerIfNeeded();
      }

      // A customer is allowed to place a new order even while an older one
      // of theirs is still pending - the old order stays exactly as-is
      // (its own line in the order history / kitchen queue) and the
      // outstanding amount on it is folded into "Previous Dues" the next
      // time any of their bills is paid (see Sales page's Complete
      // Payment panel), instead of blocking checkout outright like before.
      if (orderFormData.phone && !(isDesktopApp() && !isOnline)) {
        try {
          const pendingOrder = await checkPendingOrder(orderFormData.phone);
          if (pendingOrder.exists) {
            showMessage('info', 'Note: this customer has an earlier pending bill. It will be added to their next payment.');
          }
        } catch {
          // Non-blocking - if this lookup fails for any reason, still let
          // the order go through.
        }
      }

      const customerName = orderFormData.orderType === 'DineIn' && !orderFormData.customer.trim() ? 'Dine-In Customer' : orderFormData.customer.trim();
      const customerPhone = orderFormData.orderType === 'DineIn' && !orderFormData.phone ? '03000000000' : orderFormData.phone;
      const now = new Date().toISOString();
      const clientSyncId = crypto.randomUUID();

      const orderPayload: OrderPayload = {
        orderId: clientSyncId,
        clientSyncId,
        items: cart.map((item) => ({ name: item.name, price: item.price, quantity: item.quantity, variation: item.variation })),
        total,
        subtotal,
        tax: tax,
        orderType: orderFormData.orderType,
        customer: { name: customerName, phone: customerPhone, address: orderFormData.address },
        address: orderFormData.address,
        note: orderFormData.note,
        waiter: orderFormData.waiter,
        table: orderFormData.table,
        status: 'pending',
        paymentMethod: selectedPaymentMethod,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      // Offline mode: only ever attempted inside the desktop app (the
      // Local Hub - see lib/local-hub-api.ts - only exists there), and
      // only when the till is actually offline right now. A paired
      // phone's own offline fallback lives in CheckoutScreen.tsx on
      // pos-mobile; this branch is specifically the till's own POS screen
      // placing an order straight into its own Local Hub queue.
      const isOfflineOrder = isDesktopApp() && !isOnline;
      let savedOrder: SavedOrder;

      if (isOfflineOrder) {
        const localRecord = await createLocalOrder(orderPayload, { name: getAuthUser()?.name || getAuthUser()?.username });
        savedOrder = {
          ...orderPayload,
          id: `local-${localRecord.id}`,
          dailyOrderNumber: localRecord.localOrderNumber,
        } as SavedOrder;
      } else {
        savedOrder = await createOrder(orderPayload) as SavedOrder;
      }

      setCart([]);
      resetOrderForm();
      if (isOfflineOrder) {
        showMessage('success', `Offline order #${savedOrder.dailyOrderNumber} queued. It'll sync to the cloud automatically once you're back online.`);
      } else if (savedOrder.customerSyncWarning) {
        showMessage('error', `Order ${savedOrder.dailyOrderNumber || savedOrder.id} saved, but: ${savedOrder.customerSyncWarning}`);
      } else {
        showMessage('success', `Order ${savedOrder.dailyOrderNumber || savedOrder.id} saved! Printing kitchen receipt and notifying customer...`);
      }

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
          const claimReceipt = isOfflineOrder ? Promise.resolve() : claimReceiptPrint(savedOrder.id);

          if (settings.kitchenPrinter) {
            // Claim before printing, same rule the background poll follows
            // (see DashboardShell.tsx) - guarantees this order can never
            // get printed twice even if this till's own immediate-print
            // path and the poll loop somehow race on the same order.
            claimKitchen
              .then(() => {
                ipcRenderer.invoke('print-kitchen-receipt-data', savedOrder, settings.kitchenPrinter, printLogo, settings).catch(console.error);
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

          // TakeAway customers pay and collect right away, so their
          // receipt (with the order number) prints now instead of waiting
          // for Complete Payment on the Sales page - same claim-before-
          // print rule as the kitchen ticket above, and DashboardShell.tsx's
          // ReceiptPrintWatcher covers this same claim for TakeAway orders
          // placed from a phone via pos-mobile. SalesPage.tsx checks
          // customerReceiptPrintedAt before its own completion-time print
          // so this order never gets a second copy.
          if (savedOrder.orderType === 'TakeAway') {
            if (settings.counterPrinter) {
              claimReceipt
                .then(async () => {
                  // Small order-number-only slip first, then the full
                  // customer receipt - so the customer has something short
                  // to hold up at the counter when their order is ready.
                  try {
                    await ipcRenderer.invoke('print-order-token-data', savedOrder, settings.counterPrinter, printLogo, settings);
                  } catch (err) {
                    console.error(err);
                  }
                  ipcRenderer.invoke('print-cashier-receipt-data', savedOrder, settings.counterPrinter, printLogo, settings).catch(console.error);
                })
                .catch((err) => {
                  if (!(err instanceof ApiError) || err.status !== 409) {
                    console.error('Receipt print claim failed:', err);
                  }
                });
            } else {
              console.warn("No counter/customer printer configured in settings.");
            }
          }

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
      showMessage('error', error instanceof Error ? error.message : 'Failed to save the order. Check your internet connection and try again.');
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
        shopToast.success('Shop opened offline. Will sync once back online.');
        return;
      }
      await openShopSession();
      await refreshShopSession();
      shopToast.success('Shop opened. Orders can now be taken.');
    } catch (error) {
      shopToast.error(error instanceof Error ? error.message : 'Failed to open shop.');
    } finally {
      setIsOpeningShop(false);
    }
  }

  // The shop must be explicitly opened (see DashboardShell's "Open Shop"
  // button / ShopSessionProvider) before any order can be rung up here -
  // mirrors the same check the backend enforces in orderController.createOrder,
  // so staff see this up front instead of hitting an error after building
  // a whole cart. Loading state is skipped so the screen doesn't flash
  // "closed" for a moment on every page load while the status is fetched.
  if (!shopSessionLoading && !shopIsOpen) {
    const canManage = hasPermission('shop.session.manage');
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center rounded-[32px] bg-white p-10 text-center shadow-sm">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-gray-400">
          <Store size={28} />
        </div>
        <h2 className="text-xl font-black text-gray-900">The shop is closed</h2>
        <p className="mt-2 max-w-sm text-sm font-bold text-gray-400">
          Open the shop to start taking orders. Once open, every order rung up here counts toward this shift's totals until it's closed.
        </p>
        {canManage ? (
          <button
            type="button"
            onClick={() => void handleOpenShopFromPOS()}
            disabled={isOpeningShop}
            className="mt-6 flex items-center gap-2 rounded-full bg-emerald-600 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Store size={16} />
            {isOpeningShop ? 'Opening...' : 'Open Shop'}
          </button>
        ) : (
          <p className="mt-6 text-xs font-bold uppercase tracking-widest text-gray-400">Ask a Manager or the Shop Owner to open the shop.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {statusMessage ? <StatusBanner tone={statusMessage.tone} text={statusMessage.text} /> : null}
      {/* Checkout must always sit to the right of the products, at every
          window size - never stack below - even if that means the product
          grid drops to fewer/narrower columns on smaller screens. */}
      <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3 sm:grid-cols-[minmax(0,1fr)_280px] sm:gap-4 lg:grid-cols-[minmax(0,1.85fr)_340px] 2xl:grid-cols-[minmax(0,1.85fr)_360px] items-start">
        <section className="space-y-5">
          <div className="rounded-[32px] bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-md">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input type="text" value={productSearchQuery} onChange={(event) => setProductSearchQuery(event.target.value)} placeholder="Search products by name" className="w-full rounded-full border border-transparent bg-[#F6F7FB] py-4 pl-12 pr-4 outline-none transition focus:border-[#D6E332]" />
              </div>
              <div className="flex items-center gap-2 self-end rounded-full bg-[#F6F7FB] p-1.5">
                <IconToggleButton active={viewMode === 'grid'} onClick={() => setViewMode('grid')}><Grid size={18} /></IconToggleButton>
                <IconToggleButton active={viewMode === 'list'} onClick={() => setViewMode('list')}><List size={18} /></IconToggleButton>
              </div>
            </div>
            {/* Wraps onto as many lines as needed instead of scrolling
                sideways - every category is visible and one tap away
                instead of needing to drag a horizontal scrollbar to find
                it, which is what this replaces. */}
            <div className="mt-4 flex flex-wrap gap-1.5">
              {categories.map((category) => (
                <button key={category} type="button" onClick={() => setActiveCategory(category)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold transition ${activeCategory === category ? 'bg-black text-white' : 'bg-[#F6F7FB] text-gray-500 hover:bg-gray-100'}`}>
                  {category}
                </button>
              ))}
            </div>
          </div>

          {/* auto-fill/minmax instead of fixed breakpoint column counts - cards
              always get at least ~132px so text/price/button never overflow,
              and the browser fits as many columns as the available width
              (which varies since the checkout panel is always pinned to the
              right) actually allows. */}
          <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2' : 'space-y-2'}>
            {isLoadingProducts ? <SurfaceMessage text="Loading products..." /> : null}
            {!isLoadingProducts && filteredGroups.length === 0 ? <SurfaceMessage text="No products matched your filters." /> : null}
            {!isLoadingProducts && visibleGroups.length > 0 ? visibleGroups.map((group) => {
              const hasVariations = group.variations.length > 1;
              const cheapestPrice = Math.min(...group.variations.map((v) => v.price));
              const totalStock = group.variations.reduce((sum, v) => sum + (v.stock || 0), 0);
              return (
                <button key={group.key} type="button" onClick={() => handleGroupClick(group)} className={`group overflow-hidden rounded-[20px] border border-transparent bg-white p-2.5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[#E2F33C] hover:shadow-md ${viewMode === 'list' ? 'flex items-center gap-3' : 'flex flex-col'}`}>
                  <div className={`relative overflow-hidden rounded-[14px] ${group.color || 'bg-indigo-500'} shrink-0 object-contain p-2 ${viewMode === 'list' ? 'h-16 w-16' : 'mb-2 aspect-[4/3] w-full'}`}>
                    <img src={getProductImageUrl(group.image)} alt={group.name} className="w-full h-full object-contain transition duration-300 group-hover:scale-105" />
                  </div>
                  <div className={`flex flex-col justify-between ${viewMode === 'list' ? 'flex-1 min-w-0' : 'w-full flex-1'}`}>
                    <div>
                      <div className="mb-0.5 flex items-start justify-between gap-1.5">
                        <div className="min-w-0">
                          <h3 className="truncate text-[13px] leading-tight font-black text-gray-800">{group.name}</h3>
                          <p className="truncate text-[9px] font-bold text-gray-400">
                            {hasVariations ? `${group.variations.length} sizes/options` : group.variations[0].variation}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-[#EEF4C4] px-1.5 py-0.5 text-[8px] font-black uppercase text-gray-700">{totalStock}</span>
                      </div>
                      {viewMode === 'list' ? (
                        <p className="mb-2 line-clamp-1 text-[10px] text-gray-500">{group.description}</p>
                      ) : null}

                      {group.isDeal && group.dealItems && group.dealItems.length > 0 ? (
                        <div className="mt-1.5 flex flex-col gap-1 max-h-[60px] overflow-y-auto no-scrollbar">
                          {group.dealItems.map((dealItemId) => {
                            const subItem = products.find(p => String(p.id) === dealItemId);
                            if (!subItem) return null;
                            return (
                              <div key={dealItemId} className="text-[9px] font-bold text-gray-500 bg-gray-50 border border-gray-100 rounded-[6px] px-1.5 py-0.5 truncate flex items-center gap-1">
                                <div className="w-1 h-1 rounded-full bg-rose-400 shrink-0"></div>
                                <span>{subItem.name} {subItem.variation && subItem.variation !== 'Standard' ? `(${subItem.variation})` : ''}</span>
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
                      <p className="truncate text-[12px] font-black text-gray-900">{hasVariations ? `From PKR ${cheapestPrice}` : `PKR ${group.variations[0].price}`}</p>
                      <span className="mt-1.5 inline-flex w-fit shrink-0 items-center justify-center rounded-[8px] bg-black h-[22px] px-2.5 text-[9px] font-bold text-white transition group-hover:bg-[#E2F33C] group-hover:text-black">{hasVariations ? 'Select' : 'Add'}</span>
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
                Load More ({filteredGroups.length - visibleGroups.length} more)
              </button>
            </div>
          ) : null}
        </section>

        <aside className="rounded-[24px] bg-white shadow-sm sticky top-6">
          <div className="border-b border-gray-100 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">Current Order</p>
                <h2 className="text-xl font-black text-gray-900">POS Checkout</h2>
              </div>
              <button type="button" onClick={clearCart} disabled={cart.length === 0} className="rounded-xl bg-gray-50 p-2.5 text-gray-400 transition hover:bg-rose-50 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-50">
                <Trash2 size={16} />
              </button>
            </div>
          </div>

          <div className="space-y-3 border-b border-gray-100 bg-[#F8F9FB] p-4">
            <select name="orderType" value={orderFormData.orderType} onChange={handleFormChange} className="w-full rounded-xl border border-white bg-white px-3 py-2 text-sm outline-none">
              <option value="DineIn">Dine In</option>
              <option value="TakeAway">Take Away</option>
              <option value="Delivery">Delivery</option>
            </select>

            <div className="relative space-y-3">
              <FormField label="Phone Number">
                <input ref={phoneInputRef} name="phone" value={orderFormData.phone} onChange={handlePhoneChange} onFocus={() => (suggestions.length > 0 || showNewCustomerPrompt) && setShowSuggestions(true)} placeholder={orderFormData.orderType === 'DineIn' ? 'Phone (optional for dine-in)' : 'Phone * (03XXXXXXXXX)'} className="w-full rounded-xl border border-white bg-white px-3 py-2 text-sm outline-none" />
              </FormField>
              <FormField label="Customer Name">
                <input ref={nameInputRef} name="customer" value={orderFormData.customer} onChange={handleNameChange} onFocus={() => (suggestions.length > 0 || showNewCustomerPrompt) && setShowSuggestions(true)} placeholder={orderFormData.orderType === 'DineIn' ? 'Customer name (optional)' : 'Customer name *'} className="w-full rounded-xl border border-white bg-white px-3 py-2 text-sm outline-none" />
              </FormField>

              {showSuggestions && (suggestions.length > 0 || showNewCustomerPrompt) ? (
                <div ref={suggestionRef} className="absolute left-0 right-0 top-[124px] z-20 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl">
                  {isSearching ? <div className="p-3 text-xs text-gray-500">Searching customers...</div> : null}
                  {!isSearching ? suggestions.map((customer) => (
                    <button key={customer.id} type="button" onClick={() => handleSelectCustomer(customer)} className="block w-full border-b border-gray-100 px-3 py-2 text-left transition hover:bg-[#F8F9FB]">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-bold text-gray-900">{customer.name}</p>
                          <p className="text-[11px] text-gray-500">{customer.phone}</p>
                          <p className="text-[10px] text-gray-400">{customer.address}</p>
                        </div>
                        {customer.previousDues > 0 ? <span className="rounded-full bg-rose-50 px-2.5 py-1 text-[10px] font-bold text-rose-600">Due PKR {customer.previousDues}</span> : null}
                      </div>
                    </button>
                  )) : null}
                  {!isSearching && showNewCustomerPrompt ? (
                    <button type="button" onClick={handleCreateNewCustomer} className="flex w-full items-center gap-2 bg-emerald-50 px-3 py-2 text-left text-emerald-700 transition hover:bg-emerald-100">
                      <UserPlus size={16} />
                      <div>
                        <p className="text-sm font-bold">Add New Customer</p>
                        <p className="text-[10px]">{searchQuery.replace(/\D/g, '').length >= 3 ? `Use phone: ${formatPhoneToDigits(searchQuery)}` : `Use name: ${searchQuery}`}</p>
                      </div>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <FormField label="Address">
              <input name="address" value={orderFormData.address} onChange={handleAddressChange} placeholder={orderFormData.orderType === 'Delivery' ? 'Customer address *' : 'Customer address'} className="w-full rounded-xl border border-white bg-white px-3 py-2 text-sm outline-none" />
            </FormField>
            <FormField label="Order Note">
              <input name="note" value={orderFormData.note} onChange={handleFormChange} placeholder="Any special instructions..." className="w-full rounded-xl border border-white bg-white px-3 py-2 text-sm outline-none" />
            </FormField>
            {orderFormData.orderType === 'DineIn' ? (
              <>
                <FormField label="Waiter">
                  <select name="waiter" value={orderFormData.waiter} onChange={handleFormChange} className="w-full rounded-xl border border-white bg-white px-3 py-2 text-sm outline-none">
                    <option value="">Select waiter</option>
                    {waiters.map((waiter) => <option key={waiter.id} value={waiter.name}>{waiter.name}</option>)}
                  </select>
                </FormField>
                <FormField label="Table Number">
                  <select name="table" value={orderFormData.table} onChange={handleFormChange} className="w-full rounded-xl border border-white bg-white px-3 py-2 text-sm outline-none">
                    <option value="">Select table</option>
                    {Array.from({ length: 20 }).map((_, index) => <option key={index + 1} value={String(index + 1)}>Table {index + 1}</option>)}
                  </select>
                </FormField>
              </>
            ) : null}

            {selectedCustomerId ? (
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-2.5 text-[11px] text-sky-700">
                <div className="flex items-start gap-1.5">
                  <AlertCircle size={14} className="mt-0.5" />
                  <span>{isManualEntry ? 'Editing an existing customer. Saving the order will also update that customer record.' : 'Customer details were loaded from saved records.'}</span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="max-h-[300px] 2xl:max-h-[380px] space-y-3 overflow-y-auto p-4">
            {cart.length === 0 ? (
              <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-[20px] border border-dashed border-gray-200 bg-[#FAFBFC] text-center text-gray-400">
                <ShoppingBag size={40} strokeWidth={1.4} />
                <div>
                  <p className="text-sm font-bold text-gray-500">Your cart is empty</p>
                  <p className="text-[11px]">Select a product card to start the order.</p>
                </div>
              </div>
            ) : cart.map((item, index) => (
              <div key={`${item.id}-${item.variation}-${index}`} className="flex items-center gap-2.5 rounded-[20px] bg-[#FAFBFC] p-2.5">
                <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[14px] bg-indigo-50 p-1">
                  <img src={getProductImageUrl(item.image)} alt={item.name} className="w-full h-full object-contain drop-shadow-sm" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-gray-900">{item.name}</p>
                  <p className="truncate text-[10px] text-gray-400">{item.variation}</p>
                  <p className="text-[10px] font-semibold text-gray-500">PKR {item.price} each</p>
                </div>
                <div className="flex items-center gap-1 rounded-full bg-white p-1">
                  <button type="button" onClick={() => handleDecreaseQty(index)} className="rounded-full p-1.5 text-gray-500 transition hover:bg-gray-100"><Minus size={10} /></button>
                  <span className="min-w-5 text-center text-xs font-black">{item.quantity}</span>
                  <button type="button" onClick={() => handleIncreaseQty(index)} className="rounded-full p-1.5 text-gray-500 transition hover:bg-gray-100"><Plus size={10} /></button>
                </div>
                <div className="min-w-[60px] text-right">
                  <p className="text-sm font-black text-gray-900">PKR {item.price * item.quantity}</p>
                  <button type="button" onClick={() => handleRemoveItem(index)} className="mt-1 text-[10px] font-semibold text-rose-500 transition hover:text-rose-700">Remove</button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3 rounded-b-[24px] bg-[#F8F9FB] p-4">
            <div className="grid grid-cols-3 gap-2">
              <PaymentButton icon={<Banknote size={16} />} label="Cash" active={selectedPaymentMethod === 'Cash'} onClick={() => setSelectedPaymentMethod('Cash')} />
              <PaymentButton icon={<CreditCard size={16} />} label="Card" active={selectedPaymentMethod === 'Card'} onClick={() => setSelectedPaymentMethod('Card')} />
              <PaymentButton icon={<Wallet size={16} />} label="E-Wallet" active={selectedPaymentMethod === 'E-Wallet'} onClick={() => setSelectedPaymentMethod('E-Wallet')} />
            </div>
            <div className="space-y-1.5 rounded-[20px] bg-white p-3">
              <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500"><span>Items Total</span><span>PKR {subtotal}</span></div>
              <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500"><span>Tax ({taxRate}%)</span><span>PKR {Math.round(tax)}</span></div>
              <div className="flex items-center justify-between pt-1.5 text-base font-black text-gray-900"><span>Total Payable</span><span className="text-emerald-600">PKR {Math.round(total)}</span></div>
            </div>
            <button type="button" onClick={() => void handleSaveOrder()} disabled={isSavingOrder || cart.length === 0} className="w-full rounded-[20px] bg-[#E2F33C] px-5 py-3 text-base font-black text-black shadow-lg shadow-yellow-200/60 transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50">
              {isSavingOrder ? 'Saving Order...' : 'Save Order'}
            </button>
          </div>
        </aside>
      </div>

      {/* Hidden iframe that loads the receipt and triggers browser window.print() */}
      {printReadyUrl ? <iframe src={printReadyUrl} className="hidden" title="Auto Print Frame" /> : null}

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
    </div>
  );
}

function StatusBanner({ tone, text }: { tone: 'success' | 'error' | 'info'; text: string }) {
  return (
    <div className={`rounded-[28px] border px-5 py-4 text-sm shadow-sm ${tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-sky-200 bg-sky-50 text-sky-700'}`}>
      {text}
    </div>
  );
}

function SurfaceMessage({ text }: { text: string }) {
  return <div className="rounded-[32px] bg-white p-8 text-sm text-gray-500 shadow-sm">{text}</div>;
}

function IconToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`rounded-full p-2.5 transition ${active ? 'bg-[#E2F33C] text-black shadow-sm' : 'text-gray-500'}`}>{children}</button>;
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-[28px] bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center gap-3">
          <div className={`h-14 w-14 shrink-0 overflow-hidden rounded-[16px] ${group.color || 'bg-indigo-500'} p-2`}>
            <img src={getProductImageUrl(group.image)} alt={group.name} className="h-full w-full object-contain" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-lg font-black text-gray-900">{group.name}</h3>
            <p className="text-xs font-bold text-gray-400">Choose a size / variation</p>
          </div>
        </div>
        <div className="max-h-[320px] space-y-2 overflow-y-auto">
          {group.variations.map((variation) => (
            <button
              key={variation.id}
              type="button"
              onClick={() => onSelect(variation)}
              className="flex w-full items-center justify-between rounded-2xl border border-gray-100 bg-[#FAFBFC] px-4 py-3 text-left transition hover:border-[#E2F33C] hover:bg-[#FBFDEB]"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-gray-900">{variation.variation || 'Standard'}</p>
                <p className="text-[10px] font-bold text-gray-400">{variation.stock > 0 ? `${variation.stock} in stock` : 'Unlimited stock'}</p>
              </div>
              <span className="shrink-0 text-sm font-black text-gray-900">PKR {variation.price}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-2xl bg-gray-100 py-3 text-sm font-black text-gray-600 transition hover:bg-gray-200">
          Cancel
        </button>
      </div>
    </div>
  );
}

function PaymentButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-xl border px-2.5 py-2.5 transition ${active ? 'border-[#E2F33C] bg-[#F4F7C8] text-black' : 'border-gray-100 bg-white text-gray-500 hover:border-[#E2F33C]'}`}>
      <div className="flex flex-col items-center gap-1.5">
        {icon}
        <span className="text-[9px] font-bold uppercase tracking-wide">{label}</span>
      </div>
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
