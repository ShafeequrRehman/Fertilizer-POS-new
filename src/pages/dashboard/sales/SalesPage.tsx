import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, PackagePlus, Pencil, Phone, Printer, RefreshCcw, Search, ShoppingBag, UserRound, XCircle } from 'lucide-react';
import { ApiError, claimKitchenUpdatePrint, fetchCustomerOutstanding, fetchOccupiedDineInTables, fetchOrder, fetchOrders, fetchOrdersList, fetchProducts, fetchShopProfile, fetchShopSessionHistory, fetchWaiters, isAuthenticated, updateOrder, sendWhatsappMessage, sendWhatsappDocument } from '@/lib/pos-api';
import { formatTableLabel, getTableOptions } from '@/lib/table-options';
import { Discount, Product, SavedOrder, ShopSession, Waiter } from '@/lib/pos-types';
import { StoreSettings, getStoreSettings } from '@/lib/pos-settings';
import { hasPermission } from '@/lib/auth';
import { getBusinessWindow, filterOrdersInBusinessWindow, useShopSession } from '@/lib/shop-session';
import { isDesktopApp } from '@/lib/api';
import { useNetworkStatus } from '@/lib/network-status';
import { getLocalHubStartDiagnostics, getOccupiedTablesCache, getReferenceData, pushOccupiedTablesCache, pushOrdersCache } from '@/lib/local-hub-api';
import { loadOrdersFromLocalHub, saveOrderEditOffline, computeKitchenPrintDelta } from '@/lib/offline-order-helpers';
import { triggerBackgroundSync } from '@/lib/offline-sync';
import { reportPrintOutcome, listenForPrintSentMessages } from '@/lib/print-notify';
import { buildCategoryLookup, dispatchKitchenPrints, isCategoryPrintRoutingEnabled } from '@/lib/kitchen-print-routing';
import { useToast } from '@/lib/toast';
import AddItemsManager from '@/pages/dashboard/sales/components/AddItemsManager';
import CancelOrderModal from '@/components/CancelOrderModal';

const BASE_FILTERS = ['All', 'Dine In', 'Take Away', 'Delivery'];

type ElectronWindow = Window & typeof globalThis & {
  require?: (moduleName: 'electron') => {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  };
};

type ReceiptPdfResult = {
  success: boolean;
  pdfPath?: string;
  fileBase64?: string;
  error?: string;
};

function isReceiptPdfResult(value: unknown): value is ReceiptPdfResult {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

export default function SalesPage() {
  const { toast } = useToast();
  // The hidden auto-print iframe (see printReadyUrl further down) loads
  // PrintOrderPage.tsx in its own separate React tree - a toast shown from
  // inside it would render invisibly in that hidden iframe. It posts a
  // message up here instead once it's actually called window.print(); this
  // is what shows the popup for real, on screen. See print-notify.ts.
  useEffect(() => listenForPrintSentMessages(toast), [toast]);
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  // Real, DB-backed waiters (previously this filter row had hardcoded
  // placeholder names - "Fariha"/"Ahsan Raza"/etc - that never matched any
  // real order and made the filter buttons silently do nothing when
  // clicked) - see BASE_FILTERS above and the filters memo below.
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  // This shop's custom DineIn table labels (Shop.tables), if configured -
  // see src/lib/table-options.ts. Passed down to TableChangeModal and used
  // by this page's own "Table {x}" display spots.
  const [shopTables, setShopTables] = useState<string[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<SavedOrder | null>(null);
  // Mirror of selectedOrder for refresh() to read - refresh() itself is
  // recreated fresh every render, but the 45-second poll's setInterval
  // (see the mount effect below) closes over whichever copy existed at
  // mount and never sees later ones, so reading `selectedOrder` directly
  // in there would always see it as null. Same stale-closure fix already
  // used in RecordPage.tsx for the same reason.
  const selectedOrderRef = useRef(selectedOrder);
  useEffect(() => { selectedOrderRef.current = selectedOrder; }, [selectedOrder]);
  // Bumped every time this till makes a LOCAL, optimistic order edit
  // (saveUpdate/completeOrder, cancellation, etc. - anywhere that calls
  // setOrders directly outside of refresh()/loadFromCache()). refresh()
  // below is a several-second round trip to the cloud on a slow
  // connection; if a cashier completes an order WHILE an earlier refresh()
  // tick is still in flight, that refresh can resolve with pre-completion
  // data AFTER the optimistic update already landed, and its own blind
  // `setOrders(data)` would silently flip the just-completed order back to
  // "pending" for a moment - a visible flicker (vanish, reappear, vanish
  // again once the next correct refresh lands). Every local edit captures
  // the current value and increments it; refresh() captures it before its
  // network round trip and only applies its result if nothing local
  // happened in the meantime, so a stale response can never clobber a
  // fresher local write.
  const localEditVersionRef = useRef(0);
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPayment, setShowPayment] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showAddItems, setShowAddItems] = useState(false);
  const [showTableEdit, setShowTableEdit] = useState(false);
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [shopSession, setShopSession] = useState<ShopSession | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  // Requires a deliberate, explicit tick before "Confirm Payment" is
  // allowed through with nothing typed in Amount Paid - see completeOrder's
  // own comment for why an accidental/stray click on Confirm Payment
  // shouldn't be able to silently leave an order fully unpaid. Typing a
  // real amount doesn't need this at all; it's only the "nothing entered"
  // case this guards.
  const [confirmPending, setConfirmPending] = useState(false);
  // Discount now lives here, not in POS checkout - the cashier applies it
  // when actually completing/collecting payment on an order, using either a
  // flat PKR amount or a percent of the subtotal (Amount wins if both are
  // filled). Cleared every time the Complete Payment modal is opened so it
  // never bleeds from one order into the next.
  const [discountAmountInput, setDiscountAmountInput] = useState('');
  const [discountPercentInput, setDiscountPercentInput] = useState('');
  const [customerDue, setCustomerDue] = useState(0);
  const [printReadyUrl, setPrintReadyUrl] = useState<string | null>(null);
  const [isSendingWA, setIsSendingWA] = useState(false);
  // Order list shows 10, "Load More" grows it by 10 - same pattern as
  // Record/Ledger/Dues.
  const [visibleOrderCount, setVisibleOrderCount] = useState(10);

  const { isOnline } = useNetworkStatus();
  // The shared, cached shop-open state (see shop-session.tsx) - used as a
  // fallback below when this page's own cloud-only shopSession fetch can't
  // be reached, so this page never wrongly contradicts the topbar's own
  // "Open since ..." badge (which reads from the same cache).
  const { session: cachedShopSession } = useShopSession();

  // Always the FIRST (and, offline, only) thing this page shows - see
  // offline-order-helpers.ts's loadOrdersFromLocalHub/mergeOrdersForDisplay
  // for how the Local Hub's cached cloud snapshot gets combined with
  // whatever this till still has queued locally (new orders, edits).
  // Never a live cloud call, so this is instant every time regardless of
  // connectivity - what makes it safe to always run first, online or not,
  // instead of the old approach of gating on the isOnline flag (which
  // only re-checks every 5s - see network-status.ts - and was letting a
  // stale "online" reading send this page into an 8-second cloud timeout
  // even with the internet genuinely off). Cloud sync exists purely to
  // keep this cache fresh in the background and let other devices/views
  // see this till's orders too - never something this page's own render
  // waits on.
  async function loadFromCache() {
    if (cachedShopSession) setShopSession((current) => current ?? cachedShopSession);
    try {
      // Same staleness guard as refresh() - loadOrdersFromLocalHub() is
      // local-only (fast), but a slow render/await tick is still enough to
      // occasionally lose a race against a local edit that happened while
      // this was in flight, so it gets the same protection for consistency.
      const versionAtStart = localEditVersionRef.current;
      const merged = await loadOrdersFromLocalHub();
      if (localEditVersionRef.current === versionAtStart) {
        setOrders(merged);
        const scoped = filterOrdersInBusinessWindow(merged, getBusinessWindow(cachedShopSession, new Date()));
        setSelectedOrder((current) => (current ? merged.find((order) => order.id === current.id) ?? scoped[0] ?? null : scoped[0] ?? null));
      }
      try {
        const snapshot = await getReferenceData();
        if (snapshot.products?.length) setProducts(snapshot.products as Product[]);
        const offlineWaiters = (snapshot.staff || []) as Waiter[];
        if (offlineWaiters.length) setWaiters(offlineWaiters.filter((waiter) => waiter.isActive));
        if (snapshot.tables?.length) setShopTables(snapshot.tables);
      } catch {
        // Best-effort - only used by the Add Items modal / waiter filter, never blocks the order list above.
      }
    } catch {
      const diagnostics = await getLocalHubStartDiagnostics();
      const reason = diagnostics && !diagnostics.started ? ` (${diagnostics.error || 'failed to start'})` : '';
      setStatus({ tone: 'error', text: `Couldn't reach this till's own Local Hub${reason} - restart the app to enable offline order history.` });
    }
  }

  async function loadAny() {
    if (isDesktopApp()) {
      await loadFromCache();
      // Best-effort, not awaited - refresh() below updates state (and the
      // Local Hub's cache) with the real cloud data if/when it lands, but
      // the cache-first paint above already gave the cashier something to
      // work with immediately either way. Deliberately still the FULL
      // (non-lean) fetch here, not the list=true one browser tabs use
      // below: loadFromCache() just painted this till with real, complete
      // order data from the Local Hub, so a lean sync landing moments
      // later would actually downgrade selectedOrder back into the
      // "not hydrated yet" placeholder state and grey out its own action
      // buttons for no reason - there's no slow-network problem to solve
      // here that loadFromCache() hasn't already solved.
      if (isOnline) void refresh(false);
    } else {
      // No Local Hub to cache-first paint from (a plain browser tab, not
      // the Electron till) - this IS the code path that was actually
      // timing out (see getOrders'/pos-api.ts's own comments), so it gets
      // the lean list=true fetch, hydrating any order the user actually
      // opens via selectOrder/refreshOne below.
      await refresh(true);
    }
  }

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const storeSettings = getStoreSettings();
        setSettings(storeSettings);
        await loadAny();
      } finally {
        setLoading(false);
      }
    }
    if (!isAuthenticated()) setStatus({ tone: 'info', text: 'Login token not found. Sales updates will not sync to MongoDB until you log in again.' });
    void load();
    // Shop status can change (someone closes the shop) while this page is
    // sitting open, so the shift window is kept in sync the same way
    // RecordPage.tsx and the Dashboard do.
    const intervalId = setInterval(() => void loadAny(), 45000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // A customer can have more than one order open at once now, so "Previous
  // Dues" here means the customer's TRUE outstanding balance - every other
  // non-cancelled order's unpaid amount, plus the older previousDues
  // lump-sum - not just that old lump-sum on its own. This is what makes an
  // earlier pending bill actually show up as part of the current one.
  useEffect(() => {
    async function loadDue() {
      if (!selectedOrder?.customer.phone || selectedOrder.customer.phone === '03000000000') return setCustomerDue(0);
      // Cloud-only lookup (rolls in every OTHER unpaid order of this
      // customer's, which only the cloud has a full view of) - skipped
      // outright while offline instead of waiting out a doomed request's
      // timeout just to land on the same 0 anyway. Complete Payment still
      // works fine without it, it just won't also collect other unrelated
      // dues in the same payment until this syncs (same as RecordPage.tsx's
      // own Complete Order modal).
      if (isDesktopApp() && !isOnline) return setCustomerDue(0);
      try {
        const result = await fetchCustomerOutstanding(selectedOrder.customer.phone, selectedOrder.id);
        setCustomerDue(Number(result?.outstanding ?? 0));
      } catch {
        setCustomerDue(0);
      }
    }
    void loadDue();
  }, [selectedOrder, isOnline]);

  // "Today" here is exactly the current/most recent shop shift - same
  // definition used on the Dashboard and Record page - not a fixed
  // calendar date. While a shift is open the window is [openedAt, now)
  // and keeps growing across midnight instead of splitting into two
  // separate "days"; once closed it freezes at [openedAt, closedAt).
  const sessionWindow = useMemo(() => getBusinessWindow(shopSession, new Date()), [shopSession]);

  // Real DB waiters appended after the fixed order-type filters - see
  // BASE_FILTERS above.
  const filters = useMemo(() => [...BASE_FILTERS, ...waiters.map((waiter) => waiter.name)], [waiters]);

  const shiftOrders = useMemo(
    () => filterOrdersInBusinessWindow(orders, sessionWindow),
    [orders, sessionWindow],
  );

  // Type/waiter + search filtered, but NOT restricted by status - this is
  // what the Completed/Cancelled StatCards below count from, so they stay
  // "today's shift" numbers even though the list itself (visibleOrders,
  // below) is sourced differently.
  const filteredOrders = useMemo(() => shiftOrders.filter((order) => {
    const byFilter = filter === 'All'
      || (filter === 'Dine In' && order.orderType === 'DineIn')
      || (filter === 'Take Away' && order.orderType === 'TakeAway')
      || (filter === 'Delivery' && order.orderType === 'Delivery')
      || order.waiter === filter;
    const haystack = `${order.id} ${order.dailyOrderNumber ?? ''} ${label(order)} ${phoneLabel(order)}`.toLowerCase();
    return byFilter && haystack.includes(search.toLowerCase());
  }), [filter, shiftOrders, search]);

  // Every currently pending order shop-wide, with NO shift/date bound - a
  // still-open DineIn table or unclosed Delivery has to stay findable here
  // no matter how old it is, otherwise it silently falls out of the list
  // the moment a new shift opens after it (exactly the "some pending
  // orders are missing" bug this was built to fix). Bounded by count -
  // there's only ever as many of these as there are still-open tabs/
  // tables - not by order history size, same reasoning as RecordPage.tsx's
  // own allPendingOrders and the backend's status=pending unbounded fetch.
  const allPendingOrders = useMemo(() => orders.filter((order) => order.status === 'pending'), [orders]);

  // The actual order list only ever shows still-open (pending) orders - a
  // completed or cancelled order is done, and cluttered the list a cashier
  // is scanning to find who still needs attention. Already-settled orders
  // remain fully intact in the database (and countable via the Completed/
  // Cancelled StatCards, which read from filteredOrders instead) - this
  // only affects what's rendered here. Sourced from allPendingOrders
  // (unbounded), NOT filteredOrders (shift-scoped) - see that comment
  // above for why.
  const visibleOrders = useMemo(() => allPendingOrders.filter((order) => {
    const byFilter = filter === 'All'
      || (filter === 'Dine In' && order.orderType === 'DineIn')
      || (filter === 'Take Away' && order.orderType === 'TakeAway')
      || (filter === 'Delivery' && order.orderType === 'Delivery')
      || order.waiter === filter;
    const haystack = `${order.id} ${order.dailyOrderNumber ?? ''} ${label(order)} ${phoneLabel(order)}`.toLowerCase();
    return byFilter && haystack.includes(search.toLowerCase());
  }), [filter, allPendingOrders, search]);

  // A new filter/search re-derives the whole list, so a stale "load more"
  // position would otherwise leave the grid showing an arbitrary/
  // inconsistent slice - always restart at 10 when they change.
  useEffect(() => {
    setVisibleOrderCount(10);
  }, [filter, search, allPendingOrders]);

  const pagedOrders = visibleOrders.slice(0, visibleOrderCount);

  // True once selectedOrder is either nothing, or a REAL full order (not
  // the lean list placeholder - see SavedOrder['itemCount']'s comment).
  // Every action below that can save a change, print a receipt/ticket, or
  // build a WhatsApp message ultimately reads selectedOrder.items (directly,
  // or via saveUpdate -> computeKitchenPrintDelta / applyPatchOptimistically
  // - see offline-order-helpers.ts) - gating on this stops a fast click
  // right after selecting a card from ever acting on a still-empty
  // placeholder items array, which could otherwise print a wrong/blank
  // kitchen ticket or momentarily corrupt the optimistic offline total.
  const isSelectedOrderHydrated = !selectedOrder || selectedOrder.itemCount === undefined;

  const orderSubtotal = selectedOrder?.subtotal ?? selectedOrder?.total ?? 0;
  const orderTax = selectedOrder?.tax ?? 0;
  const discountAmountValue = Number(discountAmountInput) || 0;
  const discountPercentValue = Number(discountPercentInput) || 0;
  const discountType: Discount['type'] = discountAmountValue > 0 ? 'value' : 'percent';
  const discountRawValue = discountAmountValue > 0 ? discountAmountValue : discountPercentValue;
  const discountAmount = discountRawValue > 0 && orderSubtotal > 0
    ? Math.min(discountType === 'percent' ? Math.round((orderSubtotal * discountRawValue) / 100) : Math.round(discountRawValue), orderSubtotal)
    : 0;
  const discountForOrder: Discount | null = discountAmount > 0 ? { type: discountType, value: discountRawValue, amount: discountAmount } : null;
  const adjustedTotal = Math.max(orderSubtotal + orderTax - discountAmount, 0);
  const payable = adjustedTotal + customerDue;

  async function refresh(lean: boolean) {
    try {
      // Two fetches, merged: the last-14-days window (a generous margin
      // over any realistic gap between shifts, keeps this 45-second poll
      // fast regardless of how much order history this shop has
      // accumulated overall - see getOrders' `since` handling in
      // orderController.js) PLUS every currently pending order shop-wide
      // with NO date bound at all. Without the second call, a still-open
      // DineIn table or Delivery placed more than 14 days ago (or from
      // before the current/last shift) would silently vanish from this
      // page's list the moment it aged out of the window - exactly the
      // "pending orders missing" bug this was built to fix. See
      // allPendingOrders above for where the merged result actually gets
      // used.
      //
      // lean picks fetchOrdersList (items excluded, itemCount instead) vs
      // fetchOrders (full documents) - see loadAny()'s own comment for
      // which callers pass which and why.
      // Captured before the network round trip below - see
      // localEditVersionRef's own comment. If a local edit (Complete
      // Payment, cancellation, etc.) bumps this while the fetch is still in
      // flight, this refresh's own result is stale by the time it lands and
      // must not overwrite what the cashier already sees.
      const versionAtStart = localEditVersionRef.current;
      const fetchList = lean ? fetchOrdersList : fetchOrders;
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const [recentData, pendingData, history] = await Promise.all([
        fetchList({ since }),
        fetchList({ status: 'pending' }),
        fetchShopSessionHistory(),
      ]);
      const latestSession = history && history.length > 0 ? history[0] : null;
      setShopSession(latestSession);

      const isStale = localEditVersionRef.current !== versionAtStart;

      if (recentData && !isStale) {
        const merged = new Map(recentData.map((order) => [order.id, order]));
        (pendingData || []).forEach((order) => merged.set(order.id, order));
        const data = Array.from(merged.values());
        setOrders(data);

        // Default selection should come from THIS shift's orders, not just
        // "the newest order overall" - otherwise the very first thing shown
        // on load could be a stale order from a previous shift that isn't
        // even in the visible list below it. A selection the user already
        // made is left alone as long as the order still exists at all.
        const scoped = filterOrdersInBusinessWindow(data, getBusinessWindow(latestSession, new Date()));

        // Read via the ref, not the `selectedOrder` closed over by this
        // function - see selectedOrderRef's own comment for why the 45s
        // poll's copy of `selectedOrder` would otherwise always be stale.
        const previouslySelected = selectedOrderRef.current;
        let nextSelection: SavedOrder | null;
        if (!previouslySelected) {
          nextSelection = scoped[0] ?? null;
        } else {
          const match = data.find((order) => order.id === previouslySelected.id);
          if (!match) {
            nextSelection = scoped[0] ?? null;
          } else if (lean && previouslySelected.itemCount === undefined) {
            // A lean poll landing while the cashier already has a fully
            // hydrated order open must never silently swap it back for the
            // items-less placeholder mid-transaction - see
            // isSelectedOrderHydrated's own comment. The next explicit
            // selectOrder/refreshOne (or a non-lean refresh) still picks up
            // any real change to it.
            nextSelection = previouslySelected;
          } else {
            nextSelection = match;
          }
        }
        setSelectedOrder(nextSelection);
        selectedOrderRef.current = nextSelection;

        // This page just auto-picked an order (page load, or the previous
        // selection disappeared) from lean data with no explicit card
        // click to trigger selectOrder's own hydrate-in-background call -
        // do it here instead, so the very first order shown on a plain
        // browser tab's Sales page still gets its action buttons enabled
        // as soon as the full order lands, not only once the cashier
        // clicks something else first.
        if (lean && nextSelection && nextSelection.itemCount !== undefined && nextSelection.id !== previouslySelected?.id) {
          void refreshOne(nextSelection.id);
        }

        // Keeps the Local Hub's order cache fresh the moment this till has
        // real data, instead of only ever updating it on the 5-minute
        // background tick (see lib/offline-sync.ts) - same reasoning as
        // POSPage.tsx's product reference-data push.
        if (isDesktopApp()) {
          void pushOrdersCache(data).catch(() => {});
        }
      }

      try {
        const productData = await fetchProducts();
        if (productData) setProducts(productData.products);
      } catch {
        // Best-effort - the cache-first paint already has a product list.
      }

      try {
        const waiterData = await fetchWaiters();
        if (waiterData) setWaiters(waiterData.filter((waiter) => waiter.isActive));
      } catch {
        // Best-effort - falls back to whatever the offline cache already had.
      }

      try {
        const shopProfile = await fetchShopProfile();
        setShopTables(shopProfile?.tables || []);
      } catch {
        // Best-effort - falls back to whatever the offline cache already had
        // (or the default numbered list if this till has never fetched it).
      }
    } catch (err) {
      console.error('Failed to load orders', err);
      // Let's not wipe out the current orders if it's just a transient error,
      // but we could setStatus here. For now, just catch it safely.
    }
  }

  async function refreshProducts() {
    const productData = await fetchProducts();
    setProducts(productData.products);
  }

  async function refreshOne(id: string) {
    // Offline: re-derive from the same cached-cloud-snapshot-plus-pending-
    // edits merge loadFromCache already uses for the whole list, instead
    // of a live fetchOrder that would just fail outright with nothing to
    // show for it (previously an unhandled rejection - the button looked
    // broken with no explanation).
    if (isDesktopApp() && !isOnline) {
      try {
        const merged = await loadOrdersFromLocalHub();
        const found = merged.find((order) => order.id === id);
        if (found) {
          setOrders((previous) => previous.map((order) => order.id === id ? found : order));
          setSelectedOrder(found);
        } else {
          toast.error("This order isn't in this till's local cache - try again once back online.");
        }
      } catch {
        toast.error("Couldn't refresh this order offline.");
      }
      return;
    }
    try {
      const updated = await fetchOrder(id);
      setOrders((previous) => previous.map((order) => order.id === id ? updated : order));
      setSelectedOrder(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not refresh this order.');
    }
  }

  // Card click handler for the order list. Selects immediately with
  // whatever data the card already had (instant - no spinner, no blocked
  // click) so the detail panel's read-only fields (customer, totals,
  // status, etc, all present even on a lean placeholder) show right away.
  // If that data came from the lean list=true endpoint (itemCount set,
  // items empty), it also kicks off refreshOne in the background to fetch
  // the real full order - see isSelectedOrderHydrated's own comment for
  // why every action button stays disabled until that lands. A card
  // that was already full (itemCount undefined - either this page never
  // went lean at all, or a previous refreshOne/saveUpdate already
  // hydrated it) skips the extra round trip entirely.
  function selectOrder(order: SavedOrder) {
    setSelectedOrder(order);
    if (order.itemCount !== undefined) {
      void refreshOne(order.id);
    }
  }

  async function saveUpdate(payload: Parameters<typeof updateOrder>[1]) {
    if (!selectedOrder) return null;

    if (isDesktopApp()) {
      // Always local-first inside the desktop app, online or not - queues
      // to the Local Hub and returns instantly instead of waiting on a
      // live cloud round trip (see offline-order-helpers.ts's
      // saveOrderEditOffline for the split between the two cases: still-
      // local order vs. one that already has a real cloud _id). No
      // claim-before-print coordination or WhatsApp here (claims exist to
      // coordinate printing ACROSS devices via the cloud; this till
      // prints its own kitchen ticket immediately below either way, and
      // WhatsApp is explicitly online-only, sent separately once this
      // syncs). Nothing else could possibly be racing to print this same
      // delta while it's still only sitting on this till, so there's no
      // claim to make first. Everything queued here - dues cascade
      // included - is replayed for real moments later, once
      // triggerBackgroundSync's immediate sync attempt lands (typically a
      // second or two, not the full 5-minute timer) or, if actually
      // offline, once back online.
      const kitchenDelta = computeKitchenPrintDelta(selectedOrder, payload);
      const printSettings = getStoreSettings();
      const isElectronNow = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
      // counterPrinter only counts here for Urban Crunch (see
      // kitchen-print-routing.ts) - every other shop only ever prints to
      // kitchenPrinter.
      const willPrintKitchen = isElectronNow && kitchenDelta.length > 0 && !!(printSettings.kitchenPrinter || (isCategoryPrintRoutingEnabled() && printSettings.counterPrinter));
      // No order type - DineIn, TakeAway, or Delivery - auto-prints its
      // customer receipt at completion, offline or on. It's always a
      // deliberate, on-demand action via the Print Receipt button or
      // printer icon on the order detail card, never automatic. Passing
      // `false` as receiptPrinted below (instead of ever claiming/printing
      // it here) is what keeps customerReceiptPrintedAt unset, so that
      // on-demand print is always available later.

      try {
        const updated = await saveOrderEditOffline(selectedOrder, payload, willPrintKitchen, false);
        localEditVersionRef.current += 1;
        setOrders((previous) => previous.map((order) => order.id === updated.id ? updated : order));
        setSelectedOrder(updated);

        if (willPrintKitchen) {
          try {
            const electronRequire = (window as ElectronWindow).require;
            const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
            if (ipcRenderer) {
              const printLogo = localStorage.getItem('preferred-print-logo');
              const categoryLookup = buildCategoryLookup(products);
              await dispatchKitchenPrints(
                kitchenDelta,
                categoryLookup,
                printSettings,
                async (groupItems, printerName, label) => {
                  const printPromise = ipcRenderer.invoke('print-kitchen-receipt-data', { ...updated, items: groupItems }, printerName, printLogo, printSettings);
                  reportPrintOutcome(printPromise, label, toast);
                  await printPromise.catch(() => {});
                },
              );
            }
          } catch (printErr) {
            console.error('Offline kitchen update print failed:', printErr);
          }
        }

        triggerBackgroundSync();
        setStatus({
          tone: 'info',
          text: willPrintKitchen
            ? `Saved - kitchen ticket printed. ${isOnline ? 'Syncing to the cloud...' : 'Will sync once back online.'}`
            : isOnline ? 'Saved - syncing to the cloud...' : 'Saved - will sync once back online.',
        });
        return updated;
      } catch (err) {
        setStatus({ tone: 'error', text: err instanceof Error ? err.message : 'Could not save this change.' });
        return null;
      }
    }

    // Only ever reached from a plain browser tab now (no Local Hub to
    // queue into - see the isDesktopApp() branch above, which now always
    // handles the desktop app, online or not) - a real live cloud call is
    // the only option it has.
    const updated = await updateOrder(selectedOrder.id, payload);
    localEditVersionRef.current += 1;
    setOrders((previous) => previous.map((order) => order.id === updated.id ? updated : order));
    setSelectedOrder(updated);

    // The only thing this ever auto-prints is a kitchen ticket for items
    // just added (addItems) - completing an order never auto-prints the
    // customer receipt here, for any order type (see the offline branch
    // above for the full reasoning; the receipt stays available on demand
    // via the Print Receipt button / printer icon).
    if (payload.action !== 'addItems') {
      return updated;
    }

    // Claim-before-print, same invariant used everywhere else a kitchen
    // ticket gets auto-printed (see POSPage.tsx / DashboardShell.tsx's
    // KitchenUpdateWatcher). This is what makes adding items to an order
    // from the mobile app work the same as doing it here: the phone has no
    // printer of its own, so DashboardShell's watcher polls for updated,
    // unclaimed orders and prints them on this till - and this claim is
    // what stops both the watcher and this same tick here from printing
    // two copies when the till itself makes the edit.
    let kitchenUpdateItems: SavedOrder['items'] | null = null;
    try {
      const claimed = await claimKitchenUpdatePrint(updated.id);
      if (!claimed || claimed.items.length === 0) return updated;
      kitchenUpdateItems = claimed.items;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) {
        console.error('Kitchen update claim failed:', err);
      }
      // DashboardShell's KitchenUpdateWatcher is the safety net, no local
      // fallback here.
      return updated;
    }

    // Browser/no-printer fallback goes through PrintOrderPage.tsx, which
    // fetches the order fresh (full merged item list) - stash just the
    // claimed new items here for that page to pick up instead.
    function printPageUrl() {
      if (kitchenUpdateItems) {
        try {
          sessionStorage.setItem(`kitchen-add-items-${updated.id}`, JSON.stringify(kitchenUpdateItems));
        } catch {
          // sessionStorage unavailable - the fallback page will just show
          // the full item list instead, which is an acceptable degradation.
        }
      }
      return `/dashboard/sales/print/${updated.id}?auto=true&type=kitchen`;
    }

    const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
    if (isElectron && settings) {
      try {
        const electronRequire = (window as ElectronWindow).require;
        const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
        if (!ipcRenderer) throw new Error('Electron IPC is unavailable.');

        const printLogo = localStorage.getItem('preferred-print-logo');
        // Only the claimed delta ever goes to the kitchen - reprinting the
        // whole order's items would have the kitchen re-cook stuff they
        // already started (or finished) on the original ticket. Ice Cream/
        // Drinks/Shwarma items within that delta route to the counter
        // printer instead - see kitchen-print-routing.ts.
        const deltaItems = kitchenUpdateItems || [];

        // main.js's print handlers never reject - a real failure (bad
        // printer name, react-pdf render error, etc.) comes back as
        // { success: false, error }, not a thrown/rejected promise - so a
        // bare .catch() here was never actually seeing those failures.
        // reportPrintOutcome (print-notify.ts) checks result.success
        // explicitly, surfacing a genuine print failure AND popping the
        // success toast on a real success, instead of both looking
        // identical to a silent no-op.
        if (settings.kitchenPrinter || settings.counterPrinter) {
          const categoryLookup = buildCategoryLookup(products);
          void dispatchKitchenPrints(
            deltaItems,
            categoryLookup,
            settings,
            (groupItems, printerName, label) =>
              reportPrintOutcome(ipcRenderer.invoke('print-kitchen-receipt-data', { ...updated, items: groupItems }, printerName, printLogo, settings), label, toast),
          );
        } else {
          setPrintReadyUrl(printPageUrl());
        }
      } catch {
        setPrintReadyUrl(printPageUrl());
      }
    } else {
      setPrintReadyUrl(printPageUrl());
    }

    return updated;
  }

  // Same direct-IPC-else-fallback-page pattern used everywhere else in this
  // file - prints on this till's own counter printer immediately if one's
  // configured, otherwise opens the Manual Print Center page. Shared by the
  // on-demand Print Receipt button below and completeOrder's own
  // auto-print, so both ever only have one real implementation.
  function printCustomerReceipt(order: SavedOrder) {
    const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
    if (isElectron && settings && settings.counterPrinter) {
      try {
        const electronRequire = (window as ElectronWindow).require;
        const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
        if (!ipcRenderer) throw new Error('Electron IPC is unavailable.');
        const printLogo = localStorage.getItem('preferred-print-logo');
        // customerDue mirrors the "Previous Dues" figure shown on screen,
        // same as every other cashier receipt print in this file, so the
        // printed receipt always matches what the cashier saw.
        const receiptData = { ...order, previousDues: customerDue };
        reportPrintOutcome(
          ipcRenderer.invoke('print-cashier-receipt-data', receiptData, settings.counterPrinter, printLogo, settings),
          'Customer receipt',
          toast,
        );
      } catch {
        setPrintReadyUrl(`/dashboard/sales/print/${order.id}?auto=true&type=cashier`);
      }
    } else {
      setPrintReadyUrl(`/dashboard/sales/print/${order.id}?auto=true&type=cashier`);
    }
  }

  async function completeOrder(full: boolean) {
    if (!selectedOrder) return;
    const paid = full ? payable : Number(paymentAmount || 0);
    if (!full && (paid < 0 || paid > payable)) return setStatus({ tone: 'error', text: 'Enter a valid payment amount.' });
    // Nothing typed in Amount Paid is only allowed through with the
    // "Put in Pending" box explicitly ticked - a bare Confirm Payment
    // click with an empty field (a stray click, a misplaced tap) used to
    // silently complete the order with paid=0 and leave the whole bill as
    // an unpaid due with no confirmation at all. Typing any real amount
    // (partial or full via the field) never needs the tick.
    if (!full && paid === 0 && !confirmPending) {
      return setStatus({ tone: 'error', text: "Enter a payment amount, or check \"Put in Pending\" to confirm this order with no payment collected." });
    }
    // Completing with less than the full payable amount leaves a real due
    // on this customer's account - Customer Dues/Ledger can only ever find
    // that debt again by looking up orders by customer.phone (see
    // backend/controllers/customerController.js's getCustomerLedger, which
    // explicitly skips the walk-in placeholder phone). A due recorded
    // against "Dine-In Customer" / 03000000000 is therefore permanently
    // untrackable and unreachable for a reminder the moment this modal
    // closes - so a real name + phone are required before this is allowed
    // to leave anything unpaid. A full payment never leaves a due, so
    // walk-ins can still check out with no customer details exactly as
    // before.
    if (paid < payable) {
      if (!hasCustomerPhone(selectedOrder) || !selectedOrder.customer.name?.trim()) {
        return setStatus({ tone: 'error', text: "Add the customer's name and phone number before confirming a partial payment - dues need a real customer to track them against. Edit the order first, or pay in full instead." });
      }
    }
    // `paid` here is the FULL amount actually collected right now - this
    // order's own bill plus whatever of the customer's other outstanding
    // dues (Previous Dues, above) the cashier chose to collect alongside
    // it. The backend's completeAndSettle action pays down the customer's
    // older dues/pending orders first with it, oldest first, and only
    // applies what's left to this order - see orderController.updateOrder.
    const updated = await saveUpdate({ status: 'completed', action: 'completeAndSettle', paidAmount: paid, discount: discountForOrder });
    if (!updated) return;
    // Auto-print the customer receipt the instant the order completes,
    // same till, same click - no background watcher involved (there used
    // to be one, sibling to KitchenPrintWatcher, removed entirely - see
    // DashboardShell.tsx's comment on why). Fires for every order type -
    // DineIn, TakeAway, Delivery - all of them start "pending" and only
    // ever reach "completed" through this same action (see POSPage.tsx's
    // createOrder call, which always sends status: 'pending' regardless of
    // orderType; TakeAway's old placement-time receipt print was removed
    // entirely - see POSPage.tsx's own comment on why). The
    // customerReceiptPrintedAt guard is defense-in-depth for if a receipt
    // somehow already got marked printed some other way - printCustomerReceipt
    // itself never sets it, so the button/printer icon stay available for a
    // reprint regardless.
    if (!updated.customerReceiptPrintedAt) {
      printCustomerReceipt(updated);
    }
    // Fire-and-forget: the order is already durably saved locally by
    // saveUpdate above, and this is a PDF render (Electron IPC) plus a
    // WhatsApp cloud send - a couple of seconds combined that the cashier
    // shouldn't have to stare at a still-open modal for. It has its own
    // try/catch (see below) and reports a status message if it fails, same
    // as before - it just no longer blocks the modal from closing.
    void sendCompletedReceiptOnWhatsApp(updated);
    setShowPayment(false);
    setPaymentAmount('');
    setConfirmPending(false);
    setDiscountAmountInput('');
    setDiscountPercentInput('');
    // Local-first (see saveUpdate above) means this can't run the real
    // cross-order dues cascade itself - it shows this order as paid right
    // away, and settles whatever else the customer owes moments later once
    // this syncs (near-instant if actually online, or once back online).
    setStatus(
      isDesktopApp()
        ? { tone: 'success', text: `Order ${updated.id} completed. ${isOnline ? 'Settling any other outstanding dues now...' : 'Will settle any other outstanding dues once back online.'}` }
        : { tone: 'success', text: `Order ${updated.id} completed successfully.` },
    );
  }

  async function sendCompletedReceiptOnWhatsApp(order: SavedOrder) {
    // WhatsApp is online-only by design (same as order placement in
    // POSPage.tsx) - skip both the local PDF creation and the send
    // outright rather than let it fail after a timeout.
    if (isDesktopApp() && !isOnline) return;
    if (!hasCustomerPhone(order)) return;

    const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
    if (!isElectron) {
      console.warn('Customer receipt PDF WhatsApp send requires the Electron app.');
      return;
    }

    try {
      const electronRequire = (window as ElectronWindow).require;
      const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
      if (!ipcRenderer) throw new Error('Electron IPC is unavailable.');

      const printLogo = localStorage.getItem('preferred-print-logo');
      const receiptNumber = orderNumber(order);
      // Same "Previous Dues" figure the cashier saw in the Complete Payment
      // panel when they completed this order - see saveUpdate above.
      // settings must be passed through here too, exactly like the
      // print-cashier/print-kitchen calls above - without it this PDF's
      // ReceiptPdf() has no receiptHeader to read and silently falls back
      // to a hardcoded store name instead of whatever was configured in
      // Settings -> Manage Receipt.
      const result = await ipcRenderer.invoke('create-customer-receipt-pdf-data', { ...order, previousDues: customerDue }, `customer_receipt_${receiptNumber}`, printLogo, settings);
      if (!isReceiptPdfResult(result) || !result.success || !result.fileBase64) {
        throw new Error(isReceiptPdfResult(result) ? result.error || 'Customer receipt PDF was not created.' : 'Invalid receipt PDF response.');
      }

      await sendWhatsappDocument(order.customer.phone, result.fileBase64, `receipt-${receiptNumber}.pdf`);
    } catch (error) {
      console.error('Failed to send completed receipt PDF on WhatsApp:', error);
      setStatus({ tone: 'error', text: 'Order completed, but WhatsApp PDF receipt could not be sent.' });
    }
  }

  function handleOrderCancelled(updated: SavedOrder) {
    localEditVersionRef.current += 1;
    setOrders((previous) => previous.map((order) => (order.id === updated.id ? updated : order)));
    setSelectedOrder(updated);
    setShowCancel(false);
    setStatus({ tone: 'success', text: `Order ${updated.dailyOrderNumber ?? updated.id} cancelled successfully.` });
  }

  async function addItems(items: Array<{ name: string; price: number; quantity: number; variation: string }>) {
    if (items.length === 0) return setStatus({ tone: 'error', text: 'Select at least one item.' });
    const updated = await saveUpdate({ action: 'addItems', items });
    if (!updated) return;
    setShowAddItems(false);
    setStatus(
      isDesktopApp()
        ? { tone: 'success', text: `Added ${items.length} item(s) to ${updated.id}. ${isOnline ? 'Syncing to the cloud...' : 'Will sync once back online.'}` }
        : { tone: 'success', text: `Added ${items.length} item(s) to ${updated.id}.` },
    );
  }

  async function handleSendWhatsAppReciept(order: SavedOrder) {
    if (isDesktopApp() && !isOnline) {
      return setStatus({ tone: 'error', text: 'WhatsApp needs an internet connection - try again once back online.' });
    }
    if (!order.customer.phone || order.customer.phone === '03000000000') {
      return setStatus({ tone: 'error', text: 'No valid phone number for this customer.' });
    }

    setIsSendingWA(true);
    try {
      const lines = [];
      lines.push(`*The Heaven Slice* 🍕`);
      lines.push(`Order No: *${orderNumber(order)}*`);
      lines.push(`Total: *PKR ${order.total}*`);
      lines.push(`--------------------`);
      order.items.forEach((item) => {
        lines.push(`${item.quantity}x ${item.name} @ PKR ${item.price}`);
      });
      lines.push(`--------------------`);
      lines.push(`Thank you for your order!`);

      const message = lines.join('\n');
      const res = await sendWhatsappMessage(order.customer.phone, message);

      if (res?.success) {
        setStatus({ tone: 'success', text: `Receipt sent via WhatsApp to ${order.customer.phone}` });
      } else {
        setStatus({ tone: 'error', text: res?.error || 'Failed to send WhatsApp message. Is it connected?' });
      }
    } catch (err) {
      setStatus({ tone: 'error', text: 'WhatsApp send failed: ' + (err instanceof Error ? err.message : '') });
    } finally {
      setIsSendingWA(false);
    }
  }

  return (
    <div className="space-y-6">
      {status ? <Banner tone={status.tone} text={status.text} /> : null}
      {/* Fixed 4-up grid (not auto-fit) so these always sit in a single
          compact row instead of wrapping to 2 across on narrower windows. */}
      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Pending Orders" value={String(visibleOrders.length)} />
        <StatCard label="Completed" value={String(filteredOrders.filter((order) => order.status === 'completed').length)} />
        <StatCard label="Cancelled" value={String(filteredOrders.filter((order) => order.status === 'cancelled').length)} />
        <StatCard label="Open Value" value={`Rs ${visibleOrders.reduce((sum, order) => sum + order.total, 0)}`} />
      </div>

      {/* Order detail must always sit to the right of the order list, at
          every window size - never stack below - matching the POS
          checkout panel behavior. The list column shrinks instead of
          collapsing to a single stacked column on narrower windows. */}
      <div className="grid grid-cols-[minmax(0,1fr)_260px] gap-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-4 lg:min-h-[calc(100vh-14rem)] lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,26%)] lg:gap-6 lg:items-stretch">
        <section className="min-w-0 space-y-5 lg:flex lg:min-h-0 lg:flex-col">
          <div className="rounded-[24px] bg-white p-3.5 shadow-sm">
            <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-md">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search orders, tables, customers, waiters" className="w-full rounded-full border border-transparent bg-[#F6F7FB] py-2.5 pl-10 pr-4 text-sm outline-none focus:border-[#D6E332]" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="max-w-xs text-[11px] font-bold text-gray-400">
                  {shopSession
                    ? `Showing orders for ${shopSession.status === 'open' ? 'the current open shift' : "this shop's last shift"} - not split by calendar date.`
                    : 'No shift recorded yet. Open the shop to start taking orders.'}
                </p>
                <button type="button" onClick={() => void loadAny()} className="shrink-0 rounded-2xl bg-black px-3 py-2 text-xs font-black text-white"><RefreshCcw size={13} className="mr-1.5 inline" />Refresh</button>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {filters.map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${filter === item ? 'bg-black text-white' : 'bg-[#F6F7FB] text-gray-500'}`}>{item}</button>)}
            </div>
          </div>

          {loading ? <Surface text="Loading orders..." /> : null}
          {!loading && visibleOrders.length === 0 ? <Surface text="No orders matched the current filters." /> : null}
          {!loading && visibleOrders.length > 0 ? (
            // auto-fill/minmax instead of fixed breakpoint columns - order
            // cards resize fluidly with the available width (which now
            // varies since the detail panel is always pinned to the right)
            // instead of ever needing a horizontal scrollbar.
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2.5 lg:min-h-0 lg:flex-1 lg:content-start lg:overflow-y-auto lg:pr-2">
              {pagedOrders.map((order) => (
                <button key={order.id} type="button" onClick={() => selectOrder(order)} className={`min-w-0 overflow-hidden rounded-[18px] border p-2.5 text-left shadow-sm transition hover:-translate-y-0.5 ${selectedOrder?.id === order.id ? 'border-[#D6E332] bg-[#FBFDEB]' : 'border-transparent bg-white'}`}>
                  {/* The order # is the single most important thing on this
                      card - it shares its own full-width line instead of
                      competing with the status badge for space, so it never
                      gets clipped ("Order #0..."), and gets a bit of extra
                      top margin so it reads as clearly separate from the
                      age/status row above it, not squeezed together. */}
                  <div className="flex items-center justify-between gap-1.5">
                    <p className="truncate text-[9px] font-black uppercase tracking-[0.14em] text-gray-400">{age(order.createdAt)}</p>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-black uppercase ${order.status === 'pending' ? 'bg-amber-100 text-amber-700' : order.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{order.status}</span>
                  </div>
                  <h3 className="mt-2 break-words text-sm font-black text-gray-900">{cardHeading(order)}</h3>
                  <p className="mt-0.5 truncate text-[10px] font-semibold text-gray-500">{formatOrderDateTime(order.createdAt)}</p>
                  <div className="mt-2 space-y-0.5 text-[11px] text-gray-600">
                    <Line icon={<UserRound size={11} />} text={label(order)} />
                    <Line icon={<Phone size={11} />} text={phoneLabel(order)} />
                    <Line icon={<ShoppingBag size={11} />} text={`${prettyType(order)} • ${order.itemCount ?? order.items.length} items`} />
                  </div>
                  <div className="mt-2 truncate rounded-[12px] bg-[#F8F9FB] px-2.5 py-1.5 text-xs font-black text-gray-900">Rs {order.total}</div>
                </button>
              ))}
            </div>
          ) : null}
          {!loading && visibleOrders.length > pagedOrders.length ? (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => setVisibleOrderCount((previous) => previous + 10)}
                className="rounded-full bg-white px-6 py-2.5 text-xs font-black text-gray-700 shadow-sm transition hover:bg-gray-50"
              >
                Load More ({visibleOrders.length - pagedOrders.length} more)
              </button>
            </div>
          ) : null}
        </section>

        <aside className="min-w-0 rounded-[32px] bg-white shadow-sm lg:self-start">
          {selectedOrder ? (
            <div className="flex flex-col">
              <div className="shrink-0 border-b border-gray-100 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div><p className="text-xs font-black uppercase tracking-[0.18em] text-gray-400">Order Detail</p><h2 className="mt-2 text-2xl font-black text-gray-900">{cardHeading(selectedOrder)}</h2><p className="mt-2 text-sm text-gray-500">{formatOrderDateTime(selectedOrder.createdAt)}</p>
                    {/* isSelectedOrderHydrated is false only right after
                        picking a card whose data came from the lean
                        list=true endpoint - a background refreshOne is
                        already in flight (see selectOrder) and this
                        clears itself the moment it lands, same fetch a
                        manual tap of the refresh icon below would do. */}
                    {!isSelectedOrderHydrated ? <p className="mt-1 text-xs font-bold text-amber-600">Loading full order details...</p> : null}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {selectedOrder.customer.phone && selectedOrder.customer.phone !== '03000000000' && (
                      <button disabled={isSendingWA || !isSelectedOrderHydrated} type="button" onClick={() => void handleSendWhatsAppReciept(selectedOrder)} className="rounded-2xl bg-emerald-500 px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-white disabled:opacity-50">
                        {isSendingWA ? 'Sending...' : 'WhatsApp'}
                      </button>
                    )}
                    <button disabled={!isSelectedOrderHydrated} type="button" onClick={() => {
                      const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
                      if (isElectron && settings && (settings.kitchenPrinter || settings.counterPrinter)) {
                        try {
                          const electronRequire = (window as ElectronWindow).require;
                          const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
                          if (!ipcRenderer) throw new Error('Electron IPC is unavailable.');
                          const printLogo = localStorage.getItem('preferred-print-logo');
                          const categoryLookup = buildCategoryLookup(products);
                          void dispatchKitchenPrints(
                            selectedOrder.items,
                            categoryLookup,
                            settings,
                            (groupItems, printerName, label) =>
                              reportPrintOutcome(
                                ipcRenderer.invoke('print-kitchen-receipt-data', { ...selectedOrder, items: groupItems }, printerName, printLogo, settings),
                                label,
                                toast,
                              ),
                          );
                        } catch {
                          setPrintReadyUrl(`/dashboard/sales/print/${selectedOrder.id}?auto=true&type=kitchen`);
                        }
                      } else {
                        setPrintReadyUrl(`/dashboard/sales/print/${selectedOrder.id}?auto=true&type=kitchen`);
                      }
                    }} className="rounded-2xl bg-black px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-white disabled:opacity-50">Send to Kitchen</button>
                    <button disabled={!isSelectedOrderHydrated} type="button" onClick={() => printCustomerReceipt(selectedOrder)} className="rounded-2xl bg-[#F6F7FB] px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-gray-700 disabled:opacity-50">Print Receipt</button>
                    <Link to={`/dashboard/sales/print/${selectedOrder.id}`} className="rounded-2xl bg-[#F6F7FB] p-2.5 text-gray-500"><Printer size={16} /></Link>
                    <button type="button" onClick={() => void refreshOne(selectedOrder.id)} className="rounded-2xl bg-[#F6F7FB] p-2.5 text-gray-500"><RefreshCcw size={16} /></button>
                    {selectedOrder.status === 'pending' ? (
                      <Link to={`/dashboard/sales/${selectedOrder.id}/edit`} className="rounded-2xl bg-[#F6F7FB] px-3 py-2.5 text-xs font-black text-gray-600">Edit</Link>
                    ) : (
                      <span className="cursor-not-allowed rounded-2xl bg-[#F6F7FB] px-3 py-2.5 text-xs font-black text-gray-400">Edit Locked</span>
                    )}
                  </div>
                </div>
                {selectedOrder.status === 'pending' ? (
                  <div className="mt-4 grid gap-2">
                    <button disabled={!isSelectedOrderHydrated} type="button" onClick={() => { setDiscountAmountInput(''); setDiscountPercentInput(''); setPaymentAmount(''); setConfirmPending(false); setShowPayment(true); }} className="rounded-2xl bg-[#E2F33C] px-4 py-2 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50">Complete Order</button>
                    {hasPermission('sales.delete') ? (
                      <button
                        disabled={!isSelectedOrderHydrated}
                        type="button"
                        onClick={() => setShowCancel(true)}
                        className="rounded-2xl bg-rose-600 px-4 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Lock size={14} className="mr-1.5 inline" />Cancel Order
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="space-y-5 p-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Box label="Order Number" value={`#${orderNumber(selectedOrder)}`} />
                  <Box label="Created At" value={formatOrderDateTime(selectedOrder.createdAt)} />
                  <Box label="Customer" value={label(selectedOrder)} />
                  <Box label={selectedOrder.orderType === 'DineIn' ? 'Waiter' : 'Phone'} value={phoneLabel(selectedOrder)} />
                  {selectedOrder.orderType === 'DineIn' ? (
                    selectedOrder.status === 'pending' ? (
                      <button
                        disabled={!isSelectedOrderHydrated}
                        type="button"
                        onClick={() => setShowTableEdit(true)}
                        className="min-w-0 rounded-[20px] bg-[#F8F9FB] px-4 py-3 text-left transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Table</p>
                        <p className="mt-1 flex items-center gap-1.5 break-words text-sm font-bold text-gray-900">
                          {selectedOrder.table ? formatTableLabel(selectedOrder.table) : 'Not set'}
                          <Pencil size={12} className="shrink-0 text-gray-400" />
                        </p>
                      </button>
                    ) : (
                      <Box label="Table" value={selectedOrder.table ? formatTableLabel(selectedOrder.table) : 'N/A'} />
                    )
                  ) : null}
                  <Box label="Order Type" value={prettyType(selectedOrder)} />
                  <Box label="Address" value={selectedOrder.address || 'N/A'} />
                  <Box label="Previous Dues" value={`Rs ${customerDue}`} />
                  <Box label="Remaining" value={`Rs ${selectedOrder.remainingAmount ?? 0}`} />
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-black uppercase tracking-[0.18em] text-gray-400">Items</h3>
                    {selectedOrder.status === 'pending' ? (
                      <button disabled={!isSelectedOrderHydrated} type="button" onClick={() => setShowAddItems(true)} className="rounded-full bg-black px-4 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50"><PackagePlus size={14} className="mr-2 inline" />Add Items</button>
                    ) : (
                      <span className="rounded-full bg-[#F3F4F6] px-4 py-2 text-xs font-black text-gray-400">Order Locked</span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {!isSelectedOrderHydrated ? (
                      <p className="text-sm text-gray-400">Loading items...</p>
                    ) : (
                      selectedOrder.items.map((item, index) => <div key={`${item.name}-${index}`} className="rounded-[24px] bg-[#FAFBFC] p-4"><div className="flex items-center justify-between gap-3"><div><p className="font-black text-gray-900">{item.name}</p><p className="text-xs text-gray-400">{item.variation}</p></div><div className="text-right"><p className="text-sm font-black text-gray-900">Rs {item.price * item.quantity}</p><p className="text-xs text-gray-400">Qty {item.quantity}</p></div></div></div>)
                    )}
                  </div>
                </div>
              </div>

              <div className="shrink-0 space-y-4 rounded-b-[32px] bg-[#F8F9FB] p-6">
                <div className="rounded-[24px] bg-white p-4">
                  <Row label="Subtotal" value={`Rs ${selectedOrder.subtotal ?? 0}`} />
                  <Row label="Tax" value={`Rs ${selectedOrder.tax ?? 0}`} />
                  {selectedOrder.discount && selectedOrder.discount.amount > 0 ? (
                    <Row label={`Discount ${selectedOrder.discount.type === 'percent' ? `(${selectedOrder.discount.value}%)` : ''}`} value={`-Rs ${selectedOrder.discount.amount}`} />
                  ) : null}
                  <Row label="Bill Total" value={`Rs ${selectedOrder.total}`} />
                  <Row label="Previous Dues" value={`Rs ${customerDue}`} />
                  <Row label="Paid" value={`Rs ${selectedOrder.paidAmount ?? 0}`} />
                  <Row label="Grand Total" value={`Rs ${selectedOrder.total + customerDue}`} strong />
                </div>
                {selectedOrder.status === 'cancelled' ? (
                  <div className="space-y-1.5 rounded-[24px] bg-rose-50 px-4 py-4 text-sm font-bold text-rose-700">
                    <p>This order was cancelled and kept for record.</p>
                    {selectedOrder.cancelledBy ? <p className="text-xs font-semibold text-rose-500">Cancelled by {selectedOrder.cancelledBy}{selectedOrder.cancelledAt ? ` · ${formatOrderDateTime(selectedOrder.cancelledAt)}` : ''}</p> : null}
                    {selectedOrder.cancelReason ? <p className="text-xs font-semibold text-rose-500">Reason: {selectedOrder.cancelReason}</p> : null}
                  </div>
                ) : selectedOrder.status !== 'pending' ? <div className="rounded-[24px] bg-emerald-50 px-4 py-4 text-sm font-bold text-emerald-700">This order is completed and stored in sales history.</div> : null}
              </div>
            </div>
          ) : <div className="flex min-h-[680px] flex-col items-center justify-center gap-4 p-6 text-center text-gray-400 lg:min-h-0 lg:h-full"><ShoppingBag size={56} strokeWidth={1.4} /><div><p className="font-bold text-gray-500">Select an order</p><p className="text-sm">Choose any order card from the left.</p></div></div>}
        </aside>
      </div>

      {showPayment && selectedOrder ? (
        <Modal title="Complete Payment" onClose={() => { setShowPayment(false); setConfirmPending(false); }}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-sm font-semibold text-gray-700">Discount (PKR)</label>
                <input
                  type="number"
                  min={0}
                  value={discountAmountInput}
                  onChange={(event) => { setDiscountAmountInput(event.target.value); if (event.target.value) setDiscountPercentInput(''); }}
                  placeholder="0"
                  className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-semibold text-gray-700">Discount (%)</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={discountPercentInput}
                  onChange={(event) => setDiscountPercentInput(event.target.value)}
                  disabled={discountAmountValue > 0}
                  placeholder="0"
                  className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-300"
                />
              </div>
            </div>
            <div className="rounded-[24px] bg-[#F8F9FB] p-4 text-sm">
              <Row label="Subtotal" value={`Rs ${orderSubtotal}`} />
              <Row label="Tax" value={`Rs ${orderTax}`} />
              {discountAmount > 0 ? (
                <Row label={`Discount ${discountType === 'percent' ? `(${discountRawValue}%)` : ''}`} value={`-Rs ${discountAmount}`} />
              ) : null}
              <Row label="Bill Total" value={`Rs ${adjustedTotal}`} />
              <Row label="Previous Dues" value={`Rs ${customerDue}`} />
              <Row label="Final Payable" value={`Rs ${payable}`} strong />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-gray-700">Amount Paid</label>
              <input
                value={paymentAmount}
                onChange={(event) => {
                  if (!/^\d*$/.test(event.target.value)) return;
                  setPaymentAmount(event.target.value);
                  // Typing a real amount supersedes the tick below - only
                  // relevant while it's still empty.
                  if (event.target.value) setConfirmPending(false);
                }}
                className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none"
                placeholder={`Up to Rs ${payable}`}
              />
            </div>
            {!paymentAmount ? (
              <label className="flex cursor-pointer items-start gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-xs font-bold text-amber-800">
                <input
                  type="checkbox"
                  checked={confirmPending}
                  onChange={(event) => setConfirmPending(event.target.checked)}
                  className="mt-0.5"
                />
                Put in Pending - confirm with no payment collected right now (this leaves the full ₨{payable} as a due).
              </label>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => void completeOrder(false)} className="rounded-[20px] bg-black px-4 py-3 text-sm font-black text-white">Confirm Payment</button>
              <button type="button" onClick={() => void completeOrder(true)} className="rounded-[20px] bg-[#E2F33C] px-4 py-3 text-sm font-black text-black">Pay Full</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {showCancel && selectedOrder ? <CancelOrderModal order={selectedOrder} onClose={() => setShowCancel(false)} onCancelled={handleOrderCancelled} /> : null}

      {showAddItems && selectedOrder ? <Modal title="Add Items To Order" onClose={() => setShowAddItems(false)} wide><AddItemsManager products={products} onSaveItems={addItems} onProductsChanged={refreshProducts} /></Modal> : null}
      {showTableEdit && selectedOrder ? (
        <TableChangeModal
          order={selectedOrder}
          isOnline={isOnline}
          tables={shopTables}
          onClose={() => setShowTableEdit(false)}
          onSave={async (table) => {
            const previousTable = selectedOrder.table;
            const updated = await saveUpdate({ table });
            if (updated) {
              toast.success(previousTable ? `Table changed from ${previousTable} to ${table}.` : `Table set to ${table}.`);
            }
          }}
        />
      ) : null}
      {printReadyUrl ? <iframe src={printReadyUrl} className="hidden" title="Auto Print Frame" /> : null}
    </div>
  );
}

function label(order: SavedOrder) { return order.orderType === 'DineIn' ? (order.table ? formatTableLabel(order.table) : 'Dine-In Customer') : order.customer.name || 'Walk-in Customer'; }
function phoneLabel(order: SavedOrder) { return order.orderType === 'DineIn' ? (order.waiter ? `Waiter: ${order.waiter}` : 'Dine In') : order.customer.phone || 'No phone'; }
function prettyType(order: SavedOrder) { return order.orderType === 'DineIn' ? 'Dine In' : order.orderType === 'TakeAway' ? 'Take Away' : 'Delivery'; }
function age(createdAt: string) { const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000); return mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} hr ${mins % 60} min ago`; }
function orderNumber(order: SavedOrder) { return String(order.dailyOrderNumber ?? order.id.slice(-4)).padStart(3, '0'); }
// The prominent heading on the order card / order detail panel - a DineIn
// order is far more usefully identified by which table it's sitting at
// than by an arbitrary ticket number (a waiter working the floor thinks
// "Table 5", not "Order #042"). TakeAway/Delivery have no table at all, so
// they keep showing the order number as before. The full order number is
// still always available in the "Order Number" Box further down the detail
// panel either way - this only changes the big headline.
function cardHeading(order: SavedOrder) { return order.orderType === 'DineIn' && order.table ? formatTableLabel(order.table) : `Order #${orderNumber(order)}`; }
function hasCustomerPhone(order: SavedOrder) { return Boolean(order.customer.phone && order.customer.phone !== '03000000000'); }
function formatOrderDateTime(createdAt: string) { return new Date(createdAt).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

function Banner({ tone, text }: { tone: 'success' | 'error' | 'info'; text: string }) { return <div className={`rounded-[28px] border px-5 py-4 text-sm shadow-sm ${tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-sky-200 bg-sky-50 text-sky-700'}`}>{text}</div>; }
function Surface({ text }: { text: string }) { return <div className="rounded-[32px] bg-white p-8 text-sm text-gray-500 shadow-sm">{text}</div>; }
function StatCard({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-[16px] bg-white px-3 py-2.5 shadow-sm"><p className="truncate text-[9px] font-black uppercase tracking-[0.1em] text-gray-400">{label}</p><p className="mt-0.5 truncate text-lg font-black text-gray-900">{value}</p></div>; }
function Line({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="flex min-w-0 items-center gap-2 text-xs text-gray-600"><span className="shrink-0">{icon}</span><span className="truncate">{text}</span></div>; }
function Box({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-[20px] bg-[#F8F9FB] px-4 py-3"><p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">{label}</p><p className="mt-1 break-words text-sm font-bold text-gray-900">{value}</p></div>; }
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <div className={`flex items-center justify-between py-1.5 ${strong ? 'text-lg font-black text-gray-900' : 'text-sm text-gray-500'}`}><span>{label}</span><span>{value}</span></div>; }
function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) { return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm sm:p-6"><div className={`flex w-full max-h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-4rem)] flex-col rounded-[32px] bg-white shadow-2xl transition-all ${wide ? 'max-w-5xl' : 'max-w-xl'}`}><div className="flex shrink-0 items-center justify-between border-b border-gray-100 p-6 sm:px-8 sm:py-6"><h2 className="text-2xl font-black text-gray-900">{title}</h2><button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-3 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"><XCircle size={18} /></button></div><div className="overflow-y-auto p-6 sm:p-8">{children}</div></div></div>; }

// Lets a cashier move a DineIn order to a different table (a customer
// asked to switch seats, or the table was mis-picked at placement) without
// going through the full Edit Order page - just a field patch, same as
// note/waiter (see saveUpdate's plain `{ table }` call, which
// applyOrderPatch/updateQueuedOrder already both support - see
// orderController.js/localOrders.js). The occupied-tables check here is a
// UX aid only, not the real backstop - POSPage.tsx's own occupied-table
// list is what actually prevents a NEW order from double-booking a table;
// this modal just tries to steer the cashier away from an obvious
// collision while picking, using the same unbounded-by-date source (see
// fetchOccupiedDineInTables).
function TableChangeModal({
  order,
  isOnline,
  tables,
  onClose,
  onSave,
}: {
  order: SavedOrder;
  isOnline: boolean;
  // This shop's custom DineIn table labels (Shop.tables) - see
  // src/lib/table-options.ts. Empty means "no custom layout", same
  // default-numbered fallback as POSPage.tsx's own Table Number dropdown.
  tables: string[];
  onClose: () => void;
  onSave: (table: string) => Promise<void>;
}) {
  const [occupiedTables, setOccupiedTables] = useState<Set<string>>(new Set());
  const [loadingOccupied, setLoadingOccupied] = useState(true);
  const [selected, setSelected] = useState(order.table || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Same online/offline split as POSPage.tsx's own loadOccupiedTables
        // - previously this only ever tried the live endpoint, so offline
        // it silently fell back to "nothing greyed out" every time instead
        // of using the same cache this till already keeps warm for exactly
        // this purpose.
        let tables: string[];
        if (isDesktopApp() && isOnline) {
          tables = (await fetchOccupiedDineInTables()) ?? [];
          void pushOccupiedTablesCache(tables).catch(() => {});
        } else if (isDesktopApp()) {
          const [cached, localOrders] = await Promise.all([
            getOccupiedTablesCache().catch(() => ({ updatedAt: null, tables: [] as string[] })),
            loadOrdersFromLocalHub().catch(() => []),
          ]);
          const occupied = new Set(cached.tables);
          localOrders
            .filter((candidate) => candidate.orderType === 'DineIn' && candidate.status === 'pending' && candidate.table)
            .forEach((candidate) => occupied.add(candidate.table));
          tables = Array.from(occupied);
        } else {
          tables = (await fetchOccupiedDineInTables()) ?? [];
        }
        if (!cancelled) setOccupiedTables(new Set(tables));
      } catch {
        // Best-effort - if this fails, nothing shows as greyed out; the
        // save itself still works fine either way (see the header comment
        // above - this is a UX aid, not the real guard).
      } finally {
        if (!cancelled) setLoadingOccupied(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline]);

  async function submit() {
    if (!selected) {
      setError('Select a table.');
      return;
    }
    if (selected === order.table) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onSave(selected);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change table.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Change Table - Order #${orderNumber(order)}`} onClose={onClose}>
      <p className="text-sm text-gray-500">
        Currently {order.table ? <span className="font-bold text-gray-900">{formatTableLabel(order.table)}</span> : 'no table set'}. Pick the new table below.
      </p>
      {loadingOccupied ? <p className="mt-3 text-xs font-bold text-gray-400">Checking which tables are free...</p> : null}
      <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-5">
        {getTableOptions(tables).map((tableNumber) => {
          const isOccupied = occupiedTables.has(tableNumber) && tableNumber !== order.table;
          const isSelected = selected === tableNumber;
          return (
            <button
              key={tableNumber}
              type="button"
              disabled={isOccupied}
              onClick={() => setSelected(tableNumber)}
              title={isOccupied ? `${formatTableLabel(tableNumber)} already has a pending order` : undefined}
              className={`rounded-xl border py-2.5 text-sm font-black transition ${
                isSelected
                  ? 'border-black bg-black text-white'
                  : isOccupied
                    ? 'cursor-not-allowed border-gray-100 bg-gray-50 text-gray-300'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'
              }`}
            >
              {tableNumber}
            </button>
          );
        })}
      </div>
      {error ? <p className="mt-3 text-sm font-bold text-rose-600">{error}</p> : null}
      <button
        type="button"
        disabled={submitting || !selected}
        onClick={() => void submit()}
        className="mt-5 w-full rounded-2xl bg-black py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Saving...' : 'Save New Table'}
      </button>
    </Modal>
  );
}
