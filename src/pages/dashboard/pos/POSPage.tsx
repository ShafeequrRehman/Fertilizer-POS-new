import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Banknote, CreditCard, Grid, List, Minus, Plus, Search, ShoppingBag, Trash2, UserPlus, Wallet } from 'lucide-react';
import { checkPendingOrder, createOrder, fetchCustomerSearch, fetchOrders, fetchProducts, fetchTables, fetchTableSettings, fetchWaiters, isAuthenticated, updateCustomer, sendWhatsappMessage, openShopSession } from '@/lib/pos-api';
import { CartItem, Customer, OrderFormData, OrderPayload, Product, Table, Waiter } from '@/lib/pos-types';
import { resolveProductImage } from '@/lib/food-images';
import { getTableTimerRemainingMs, type TableTimerOrder } from '@/lib/table-timer';
import { getStoreSettings } from '@/lib/pos-settings';
import { SavedOrder } from '@/lib/pos-types';
import { useShopSession } from '@/lib/shop-session';
import { hasPermission } from '@/lib/auth';
import { useToast } from '@/lib/toast';
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

// Numeric table names ("1".."20", the default seeded set) sort in natural
// order instead of lexicographically; any custom non-numeric name (e.g.
// "VIP-1") sorts after the numeric ones, then alphabetically.
function sortTables(tables: Table[]) {
  return [...tables].sort((left, right) => {
    const leftNumber = Number(left.name);
    const rightNumber = Number(right.name);
    const leftIsNumeric = left.name.trim() !== '' && !Number.isNaN(leftNumber);
    const rightIsNumeric = right.name.trim() !== '' && !Number.isNaN(rightNumber);

    if (leftIsNumeric && rightIsNumeric) return leftNumber - rightNumber;
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return left.name.localeCompare(right.name);
  });
}

// How often the Dine-In screen re-checks which tables have an active order
// (see loadActiveTableOrders below). There's no push/websocket channel in
// this app, so a short poll is how a second terminal finds out a table
// just got occupied or freed up; navigating back to this screen also
// re-fetches immediately (the effect below re-runs on mount), which is
// what makes payment completion on the Sales page feel instant in the
// common single-terminal workflow.
const TABLE_STATUS_POLL_MS = 5000;

function formatTableCountdown(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function POSPage() {
  const { isOpen: shopIsOpen, loading: shopSessionLoading, refresh: refreshShopSession } = useShopSession();
  const { toast: shopToast, popup } = useToast();
  const [isOpeningShop, setIsOpeningShop] = useState(false);
  const [categories, setCategories] = useState<string[]>(['All']);
  const [products, setProducts] = useState<Product[]>([]);
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  // Estimated combined prep + dining duration (minutes) - a shop-wide
  // setting from TableManagementSection.tsx, defaulting to 45. Drives both
  // this screen's countdown display and (mirrored server-side in
  // orderController.createOrder) whether a table can be selected at all.
  const [tableTurnoverMinutes, setTableTurnoverMinutes] = useState(45);
  // tableName -> the most recent still-pending, not-yet-cleared DineIn
  // order occupying it (createdAt + any staff-granted extension). A table
  // stays locked for as long as it has an entry here at all - see
  // getTableRemainingMs/isTableLocked below. Refreshed on a timer
  // (TABLE_STATUS_POLL_MS) rather than a push channel, since this app has
  // no websocket/live channel to the backend; the same data also feeds the
  // real-time table-timer alert popup (TableTimerAlertWatcher.tsx, mounted
  // in DashboardShell) which fires when one of these crosses its deadline.
  const [activeTableOrders, setActiveTableOrders] = useState<Record<string, TableTimerOrder>>({});
  // Ticks every second purely to force the countdown labels (and the
  // locked/unlocked state derived from them) to re-render - the underlying
  // truth is always "now vs. activeTableOrders", never this value itself.
  const [tableClockTick, setTableClockTick] = useState(() => Date.now());
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

  const suggestionRef = useRef<HTMLDivElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function loadProducts() {
      try {
        const [productResponse, waiterResponse, tableResponse] = await Promise.all([
          fetchProducts(),
          fetchWaiters(),
          fetchTables(),
        ]);
        setCategories(productResponse?.categories?.length ? productResponse.categories : ['All']);
        setProducts(productResponse?.products ?? []);
        setWaiters(waiterResponse.filter((waiter) => waiter.isActive));
        setTables(sortTables((tableResponse ?? []).filter((table) => table.isActive)));
      } catch (error) {
        setCategories(['All']);
        setProducts([]);
        setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Failed to load products from database.' });
      } finally {
        setIsLoadingProducts(false);
      }
    }
    void loadProducts();
  }, []);

  useEffect(() => {
    void fetchTableSettings().then((settings) => {
      if (settings?.tableTurnoverMinutes) setTableTurnoverMinutes(settings.tableTurnoverMinutes);
    });
  }, []);

  // Which tables currently have an active (pending, un-expired) DineIn
  // order, so the table grid below can lock them out. Called once
  // immediately on mount, again right after this screen creates a new
  // order (so the table it just used locks without waiting for the next
  // poll), and on a short interval so a second terminal picks up changes
  // too - navigating back to this screen after completing payment on the
  // Sales page also re-runs the mount call, which is what makes a freed
  // table feel instant in the common single-terminal workflow.
  async function loadActiveTableOrders() {
    try {
      const orders = await fetchOrders({ status: 'pending', orderType: 'DineIn' });
      const nextActiveTableOrders: Record<string, TableTimerOrder> = {};
      // Re-check status/orderType/table client-side instead of trusting the
      // query params alone - a paid/completed/cancelled order must never
      // keep a table locked, and this way a mismatched or stale backend
      // (e.g. one that hasn't picked up a filter change yet) can't silently
      // leave a freed table stuck showing a countdown. A tableTimerCleared
      // order (staff dismissed it via the real-time alert's "Clear Table")
      // never locks the table either, even though it's still "pending".
      (orders ?? [])
        .filter((order) => order.status === 'pending' && order.orderType === 'DineIn' && order.table && !order.tableTimerCleared)
        .forEach((order) => {
          const existing = nextActiveTableOrders[order.table];
          if (!existing || new Date(order.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
            nextActiveTableOrders[order.table] = { createdAt: order.createdAt, timerExtendedMinutes: order.timerExtendedMinutes };
          }
        });
      setActiveTableOrders(nextActiveTableOrders);
    } catch (error) {
      // Non-blocking - table locks/countdowns just skip this refresh; the
      // next poll (or the next visit to this screen) retries. Logged
      // (instead of swallowed entirely) so a persistently failing poll is
      // at least visible in devtools rather than silently freezing every
      // table's lock state at whatever it last successfully loaded.
      console.error('Failed to refresh table occupancy:', error);
    }
  }

  useEffect(() => {
    void loadActiveTableOrders();
    const interval = setInterval(() => void loadActiveTableOrders(), TABLE_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setTableClockTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // null = table isn't occupied at all. Otherwise the raw milliseconds left
  // on the countdown - which CAN be negative once the timer has expired.
  // Unlike the earlier "hard cutoff" behavior, an expired timer no longer
  // silently frees the table on its own: it stays locked until staff act on
  // the real-time alert popup (TableTimerAlertWatcher.tsx) with either
  // "Clear Table" or "Extend +10 Minutes" - see isTableLocked below, which
  // is what actually gates table selection.
  function getTableRemainingMs(tableName: string): number | null {
    const occupying = activeTableOrders[tableName];
    if (!occupying) return null;
    void tableClockTick; // re-evaluated every second purely to re-render the live countdown
    return getTableTimerRemainingMs(occupying, tableTurnoverMinutes);
  }

  // Whether a table can be selected for a new order right now - true for as
  // long as it has any occupying entry at all, regardless of whether its
  // countdown has already reached zero (see getTableRemainingMs above).
  function isTableLocked(tableName: string): boolean {
    return Boolean(activeTableOrders[tableName]);
  }

  // If the table currently selected in the form gets taken by another
  // order (a second terminal, most likely) while this cashier is still
  // building the cart, drop the now-stale selection instead of letting them
  // submit straight into the 409 the backend would return.
  useEffect(() => {
    if (!orderFormData.table) return;
    if (!isTableLocked(orderFormData.table)) return;
    const takenTable = orderFormData.table;
    setOrderFormData((previous) => (previous.table === takenTable ? { ...previous, table: '' } : previous));
    popup({ tone: 'error', title: 'Table No Longer Available', message: `Table ${takenTable} was just taken by another order. Pick a different table.` });
    // Only re-checks when the underlying lock data changes, not on every
    // orderFormData edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTableOrders, tableClockTick]);

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
    shopToast.success(`Customer "${customer.name}" loaded into the order form.`);
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
    shopToast.info('No saved customer matched. Fill the remaining fields to create one during checkout.');
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
    popup({ tone: 'error', title: "Can't Save Order", message });
    return false;
  }

  function validateOrderForm() {
    if (cart.length === 0) return showValidationError('Add at least one product before saving the order.');

    if (orderFormData.orderType === 'DineIn') {
      if (!orderFormData.table) return showValidationError('Please select a table before saving a dine-in order.');
      if (orderFormData.phone && !/^03\d{9}$/.test(orderFormData.phone)) return showValidationError('Use phone format 03XXXXXXXXX, or leave it empty for dine-in.');
      if (orderFormData.phone && !orderFormData.customer.trim()) return showValidationError('Customer name is required when a dine-in phone number is entered.');
      return true;
    }

    if (!orderFormData.customer.trim()) return showValidationError('Customer name is required for takeaway and delivery orders.');
    if (!/^03\d{9}$/.test(orderFormData.phone)) return showValidationError('Use phone format 03XXXXXXXXX for takeaway and delivery orders.');
    if (orderFormData.orderType === 'Delivery' && !orderFormData.address.trim()) return showValidationError('Address is required for delivery orders.');
    return true;
  }

  async function handleSaveOrder() {
    if (isSavingOrderRef.current) return;
    if (!validateOrderForm()) return;
    isSavingOrderRef.current = true;
    setIsSavingOrder(true);

    try {
      await updateExistingCustomerIfNeeded();

      // A customer is allowed to place a new order even while an older one
      // of theirs is still pending - the old order stays exactly as-is
      // (its own line in the order history / kitchen queue) and the
      // outstanding amount on it is folded into "Previous Dues" the next
      // time any of their bills is paid (see Sales page's Complete
      // Payment panel), instead of blocking checkout outright like before.
      if (orderFormData.phone) {
        try {
          const pendingOrder = await checkPendingOrder(orderFormData.phone);
          if (pendingOrder.exists) {
            shopToast.info('Note: this customer has an earlier pending bill. It will be added to their next payment.');
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
        items: cart.map((item) => ({ name: item.name, price: item.price, quantity: item.quantity, variation: item.variation, image: item.image })),
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

      const savedOrder = await createOrder(orderPayload) as SavedOrder;

      setCart([]);
      resetOrderForm();
      // Lock the table this order just used right away, instead of
      // waiting up to TABLE_STATUS_POLL_MS for the next poll to notice it.
      if (savedOrder.orderType === 'DineIn' && savedOrder.table) void loadActiveTableOrders();
      // "content based on activity context" (Technical Requirements #1): a
      // dine-in order mentions its table, and a customer-sync failure gets
      // its own warning-toned popup instead of pretending everything went
      // perfectly - the order itself is still saved fine either way.
      const savedOrderLabel = `Order #${savedOrder.dailyOrderNumber || savedOrder.id}`;
      const contextLine = savedOrder.orderType === 'DineIn' && savedOrder.table
        ? `Table ${savedOrder.table} - kitchen receipt is printing now.`
        : 'Kitchen receipt is printing now.';

      if (savedOrder.customerSyncWarning) {
        popup({ tone: 'error', title: 'Order Saved, With a Warning', message: `${savedOrderLabel} was saved, but: ${savedOrder.customerSyncWarning}` });
      } else {
        popup({ tone: 'success', title: 'Order Saved Successfully', message: `${savedOrderLabel} saved! ${contextLine}` });
      }

      const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
      if (isElectron) {
        try {
          const electronRequire = (window as ElectronWindow).require;
          const { ipcRenderer } = electronRequire('electron');
          const settings = getStoreSettings();
          const printLogo = localStorage.getItem('preferred-print-logo');

          if (settings.kitchenPrinter) {
            ipcRenderer.invoke('print-kitchen-receipt-data', savedOrder, settings.kitchenPrinter, printLogo, settings).catch(console.error);
          } else {
            console.warn("No kitchen printer configured in settings.");
          }

          void sendOrderPlacedMessage(savedOrder, settings);
        } catch (err) {
          console.error("Electron print error:", err);
          setPrintReadyUrl(`/dashboard/sales/print/${savedOrder.id}?auto=true&type=kitchen`);
          void sendOrderPlacedMessage(savedOrder, getStoreSettings());
        }
      } else {
        setPrintReadyUrl(`/dashboard/sales/print/${savedOrder.id}?auto=true&type=kitchen`);
        void sendOrderPlacedMessage(savedOrder, getStoreSettings());
      }
    } catch (error) {
      popup({ tone: 'error', title: "Order Wasn't Saved", message: error instanceof Error ? error.message : 'Failed to save the order. Check your internet connection and try again.' });
    } finally {
      isSavingOrderRef.current = false;
      setIsSavingOrder(false);
    }
  }

  async function handleOpenShopFromPOS() {
    setIsOpeningShop(true);
    try {
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
      <div className="glass flex min-h-[70vh] flex-col items-center justify-center rounded-[32px] p-10 text-center">
        <div className="glass-pill mb-5 flex h-16 w-16 items-center justify-center rounded-full text-gray-400">
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
            className="mt-6 flex items-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-emerald-400 to-emerald-600 px-6 py-3 text-sm font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_8px_rgba(6,95,70,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
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
          <div className="glass rounded-[32px] p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-md">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input type="text" value={productSearchQuery} onChange={(event) => setProductSearchQuery(event.target.value)} placeholder="Search products by name" className="w-full rounded-full border border-white/60 bg-white/50 py-4 pl-12 pr-4 shadow-inner outline-none transition focus:border-[#D6E332]" />
              </div>
              <div className="glass-pill flex items-center gap-2 self-end rounded-full p-1.5">
                <IconToggleButton active={viewMode === 'grid'} onClick={() => setViewMode('grid')}><Grid size={18} /></IconToggleButton>
                <IconToggleButton active={viewMode === 'list'} onClick={() => setViewMode('list')}><List size={18} /></IconToggleButton>
              </div>
            </div>
            <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
              {categories.map((category) => (
                <button key={category} type="button" onClick={() => setActiveCategory(category)} className={`whitespace-nowrap rounded-full px-5 py-2.5 text-sm font-bold transition ${activeCategory === category ? 'glass-dark' : 'bg-white/50 text-gray-600 shadow-inner hover:bg-white/70'}`}>
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
          <div className={viewMode === 'grid' ? 'grid grid-cols-3 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5' : 'space-y-2'}>
            {isLoadingProducts ? <SurfaceMessage text="Loading products..." /> : null}
            {!isLoadingProducts && filteredGroups.length === 0 ? <SurfaceMessage text="No products matched your filters." /> : null}
            {!isLoadingProducts && filteredGroups.length > 0 ? filteredGroups.map((group) => {
              const hasVariations = group.variations.length > 1;
              const cheapestPrice = Math.min(...group.variations.map((v) => v.price));
              const totalStock = group.variations.reduce((sum, v) => sum + (v.stock || 0), 0);
              return (
                <button key={group.key} type="button" onClick={() => handleGroupClick(group)} className={`group overflow-hidden rounded-[20px] border-[0.5px] border-white/50 bg-gradient-to-br from-white/70 to-white/30 p-2.5 text-left backdrop-blur-xl backdrop-saturate-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-3px_8px_rgba(15,23,42,0.12)] transition hover:-translate-y-0.5 hover:border-[#E2F33C]/70 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_10px_rgba(214,227,50,0.35)] ${viewMode === 'list' ? 'flex items-center gap-3' : 'flex flex-col'}`}>
                  <div className={`relative overflow-hidden rounded-[14px] bg-slate-100 shrink-0 shadow-inner ${viewMode === 'list' ? 'h-16 w-16' : 'mb-2 aspect-[4/3] w-full'}`}>
                    <img src={resolveProductImage(group)} alt={group.name} loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-110" />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent" />
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
                    <div className={`flex items-center justify-between gap-1 ${viewMode === 'list' ? '' : 'mt-3 pt-2 border-t border-gray-50'}`}>
                      <span className="min-w-0 truncate text-[12px] font-black text-gray-900">{hasVariations ? `From PKR ${cheapestPrice}` : `PKR ${group.variations[0].price}`}</span>
                      <span className="shrink-0 rounded-[8px] flex items-center justify-center bg-black h-[22px] px-2 text-[9px] font-bold text-white transition group-hover:bg-[#E2F33C] group-hover:text-black">{hasVariations ? 'Select' : 'Add'}</span>
                    </div>
                  </div>
                </button>
              );
            }) : null}
          </div>
        </section>

        <aside className="glass sticky top-6 rounded-[24px]">
          <div className="border-b border-white/40 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">Current Order</p>
                <h2 className="text-xl font-black text-gray-900">POS Checkout</h2>
              </div>
              <button type="button" onClick={clearCart} disabled={cart.length === 0} className="glass-pill rounded-xl p-2.5 text-gray-400 transition hover:bg-rose-50/70 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-50">
                <Trash2 size={16} />
              </button>
            </div>
          </div>

          <div className="space-y-3 border-b border-white/40 bg-white/25 p-4">
            <select name="orderType" value={orderFormData.orderType} onChange={handleFormChange} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none">
              <option value="DineIn">Dine In</option>
              <option value="TakeAway">Take Away</option>
              <option value="Delivery">Delivery</option>
            </select>

            <div className="relative space-y-3">
              <FormField label="Phone Number">
                <input ref={phoneInputRef} name="phone" value={orderFormData.phone} onChange={handlePhoneChange} onFocus={() => (suggestions.length > 0 || showNewCustomerPrompt) && setShowSuggestions(true)} placeholder={orderFormData.orderType === 'DineIn' ? 'Phone (optional for dine-in)' : 'Phone * (03XXXXXXXXX)'} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none" />
              </FormField>
              <FormField label="Customer Name">
                <input ref={nameInputRef} name="customer" value={orderFormData.customer} onChange={handleNameChange} onFocus={() => (suggestions.length > 0 || showNewCustomerPrompt) && setShowSuggestions(true)} placeholder={orderFormData.orderType === 'DineIn' ? 'Customer name (optional)' : 'Customer name *'} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none" />
              </FormField>

              {showSuggestions && (suggestions.length > 0 || showNewCustomerPrompt) ? (
                <div ref={suggestionRef} className="glass-strong absolute left-0 right-0 top-[124px] z-20 overflow-hidden rounded-2xl">
                  {isSearching ? <div className="p-3 text-xs text-gray-500">Searching customers...</div> : null}
                  {!isSearching ? suggestions.map((customer) => (
                    <button key={customer.id} type="button" onClick={() => handleSelectCustomer(customer)} className="block w-full border-b border-white/40 px-3 py-2 text-left transition hover:bg-white/50">
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
                    <button type="button" onClick={handleCreateNewCustomer} className="flex w-full items-center gap-2 bg-emerald-50/60 px-3 py-2 text-left text-emerald-700 transition hover:bg-emerald-100/70">
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
              <input name="address" value={orderFormData.address} onChange={handleAddressChange} placeholder={orderFormData.orderType === 'Delivery' ? 'Customer address *' : 'Customer address'} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none" />
            </FormField>
            <FormField label="Order Note">
              <input name="note" value={orderFormData.note} onChange={handleFormChange} placeholder="Any special instructions..." className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none" />
            </FormField>
            {orderFormData.orderType === 'DineIn' ? (
              <>
                <FormField label="Waiter">
                  <select name="waiter" value={orderFormData.waiter} onChange={handleFormChange} className="w-full rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm shadow-inner outline-none">
                    <option value="">Select waiter</option>
                    {waiters.map((waiter) => <option key={waiter.id} value={waiter.name}>{waiter.name}</option>)}
                  </select>
                </FormField>
                <FormField label="Table Number">
                  {tables.length === 0 ? (
                    <p className="rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-xs font-bold text-gray-400 shadow-inner">No tables configured yet.</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-5 gap-2">
                        {tables.map((table) => {
                          const isSelected = orderFormData.table === table.name;
                          const remainingMs = getTableRemainingMs(table.name);
                          const isLocked = isTableLocked(table.name);
                          // Once the countdown reaches zero the table stays
                          // locked (no more silent auto-unlock) - it just
                          // switches from a live countdown to an "Expired"
                          // state until staff clear or extend it from the
                          // real-time alert popup elsewhere on the Dashboard.
                          const isExpired = isLocked && remainingMs !== null && remainingMs <= 0;
                          return (
                            <button
                              key={table.id}
                              type="button"
                              disabled={isLocked}
                              onClick={() => setOrderFormData((previous) => ({ ...previous, table: previous.table === table.name ? '' : table.name }))}
                              title={
                                isExpired
                                  ? `Table ${table.name} - timer expired, awaiting staff to clear or extend it`
                                  : isLocked
                                    ? `Table ${table.name} - occupied, free in ~${formatTableCountdown(remainingMs ?? 0)}`
                                    : table.isFamily
                                      ? `Table ${table.name} - Family Table`
                                      : `Table ${table.name}`
                              }
                              className={`relative flex flex-col items-center justify-center gap-0.5 rounded-xl border px-2 py-2 text-xs font-black leading-tight backdrop-blur-md transition ${
                                isExpired
                                  ? 'cursor-not-allowed border-rose-300/70 bg-rose-50/50 text-rose-500 shadow-inner'
                                  : isLocked
                                    ? 'cursor-not-allowed border-white/40 bg-white/30 text-gray-400 shadow-inner'
                                    : isSelected
                                      ? 'border-[#D6E332] bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-2px_6px_rgba(132,144,10,0.4)]'
                                      : table.isFamily
                                        ? 'border-pink-200/70 bg-pink-50/60 text-pink-700 shadow-inner hover:border-pink-300'
                                        : 'border-white/50 bg-white/50 text-gray-600 shadow-inner hover:border-[#E2F33C]/70'
                              }`}
                            >
                              <span>{table.name}</span>
                              {isExpired ? (
                                <span className="text-[9px] font-black normal-case text-rose-500">Expired</span>
                              ) : isLocked ? (
                                <span className="text-[9px] font-bold normal-case text-gray-400">{formatTableCountdown(remainingMs ?? 0)}</span>
                              ) : null}
                              {table.isFamily ? (
                                <span className={`absolute -right-1.5 -top-1.5 rounded-full px-1 text-[8px] font-black leading-[14px] text-white ${isLocked ? 'bg-gray-400' : 'bg-pink-500'}`}>F</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-bold">
                        {tables.some((table) => table.isFamily) ? (
                          <p className="flex items-center gap-1.5 text-pink-600">
                            <span className="inline-block h-2 w-2 rounded-full bg-pink-500" /> Family Table
                          </p>
                        ) : null}
                        <p className="flex items-center gap-1.5 text-gray-400">
                          <span className="inline-block h-2 w-2 rounded-full bg-gray-300" /> Occupied (frees up when paid, cleared, or extended)
                        </p>
                        <p className="flex items-center gap-1.5 text-rose-500">
                          <span className="inline-block h-2 w-2 rounded-full bg-rose-400" /> Expired - awaiting staff decision
                        </p>
                      </div>
                    </>
                  )}
                </FormField>
              </>
            ) : null}

            {selectedCustomerId ? (
              <div className="rounded-xl border border-sky-200/70 bg-sky-50/60 p-2.5 text-[11px] text-sky-700 shadow-inner">
                <div className="flex items-start gap-1.5">
                  <AlertCircle size={14} className="mt-0.5" />
                  <span>{isManualEntry ? 'Editing an existing customer. Saving the order will also update that customer record.' : 'Customer details were loaded from saved records.'}</span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="max-h-[300px] 2xl:max-h-[380px] space-y-3 overflow-y-auto p-4">
            {cart.length === 0 ? (
              <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-[20px] border border-dashed border-white/60 bg-white/30 text-center text-gray-400">
                <ShoppingBag size={40} strokeWidth={1.4} />
                <div>
                  <p className="text-sm font-bold text-gray-500">Your cart is empty</p>
                  <p className="text-[11px]">Select a product card to start the order.</p>
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
                  <p className="text-[10px] font-semibold text-gray-500">PKR {item.price} each</p>
                </div>
                <div className="glass-pill flex items-center gap-1 rounded-full p-1">
                  <button type="button" onClick={() => handleDecreaseQty(index)} className="rounded-full p-1.5 text-gray-500 transition hover:bg-white/70"><Minus size={10} /></button>
                  <span className="min-w-5 text-center text-xs font-black">{item.quantity}</span>
                  <button type="button" onClick={() => handleIncreaseQty(index)} className="rounded-full p-1.5 text-gray-500 transition hover:bg-white/70"><Plus size={10} /></button>
                </div>
                <div className="min-w-[60px] text-right">
                  <p className="text-sm font-black text-gray-900">PKR {item.price * item.quantity}</p>
                  <button type="button" onClick={() => handleRemoveItem(index)} className="mt-1 text-[10px] font-semibold text-rose-500 transition hover:text-rose-700">Remove</button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3 rounded-b-[24px] border-t border-white/40 bg-white/25 p-4">
            <div className="grid grid-cols-3 gap-2">
              <PaymentButton icon={<Banknote size={16} />} label="Cash" active={selectedPaymentMethod === 'Cash'} onClick={() => setSelectedPaymentMethod('Cash')} />
              <PaymentButton icon={<CreditCard size={16} />} label="Card" active={selectedPaymentMethod === 'Card'} onClick={() => setSelectedPaymentMethod('Card')} />
              <PaymentButton icon={<Wallet size={16} />} label="E-Wallet" active={selectedPaymentMethod === 'E-Wallet'} onClick={() => setSelectedPaymentMethod('E-Wallet')} />
            </div>
            <div className="space-y-1.5 rounded-[20px] bg-white/50 p-3 shadow-inner">
              <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500"><span>Items Total</span><span>PKR {subtotal}</span></div>
              <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500"><span>Tax ({taxRate}%)</span><span>PKR {Math.round(tax)}</span></div>
              <div className="flex items-center justify-between pt-1.5 text-base font-black text-gray-900"><span>Total Payable</span><span className="text-emerald-600">PKR {Math.round(total)}</span></div>
            </div>
            <button type="button" onClick={() => void handleSaveOrder()} disabled={isSavingOrder || cart.length === 0} className="w-full rounded-[20px] border-[0.5px] border-white/50 bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] px-5 py-3 text-base font-black text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-3px_8px_rgba(132,144,10,0.4)] transition hover:brightness-105 hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50">
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
  return (
    <div className="glass-overlay fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-strong w-full max-w-sm rounded-[28px] p-6" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center gap-3">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-[16px] bg-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_6px_16px_-6px_rgba(0,0,0,0.3)]">
            <img src={resolveProductImage(group)} alt={group.name} className="h-full w-full object-cover" />
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
              className="flex w-full items-center justify-between rounded-2xl border border-white/50 bg-white/50 px-4 py-3 text-left shadow-inner transition hover:border-[#E2F33C]/70 hover:bg-[#FBFDEB]/70"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-gray-900">{variation.variation || 'Standard'}</p>
                <p className="text-[10px] font-bold text-gray-400">{variation.stock > 0 ? `${variation.stock} in stock` : 'Unlimited stock'}</p>
              </div>
              <span className="shrink-0 text-sm font-black text-gray-900">PKR {variation.price}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="glass-pill mt-4 w-full rounded-2xl py-3 text-sm font-black text-gray-600 transition hover:bg-white/70">
          Cancel
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
