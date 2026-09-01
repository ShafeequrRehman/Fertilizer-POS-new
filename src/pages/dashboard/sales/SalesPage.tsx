import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Edit3, Globe, Heart, Lock, MapPin, PackagePlus, Pencil, Phone, Printer, RefreshCcw, Search, ShoppingBag, Table2, UserRound, XCircle } from 'lucide-react';
import { ApiError, claimKitchenUpdatePrint, fetchCustomerOutstanding, fetchOrder, fetchOrders, fetchOrdersList, fetchProducts, fetchShopProfile, fetchShopSessionHistory, fetchTables, fetchWaiters, fetchRiders, assignOrderRider, isAuthenticated, updateOrder, sendWhatsappMessage, sendWhatsappDocument, updateOrderTrackingStatus, respondToOrderChangeRequest, type TrackingStatus, type Rider } from '@/lib/pos-api';
import { Discount, Product, SavedOrder, ShopSession, Table, Waiter } from '@/lib/pos-types';
import { StoreSettings, getStoreSettings } from '@/lib/pos-settings';
import { hasPermission } from '@/lib/auth';
import { getBusinessWindow, filterOrdersInBusinessWindow, useShopSession } from '@/lib/shop-session';
import { isDesktopApp } from '@/lib/api';
import { useNetworkStatus } from '@/lib/network-status';
import { getLocalHubStartDiagnostics, getReferenceData, pushOrdersCache } from '@/lib/local-hub-api';
import { loadOrdersFromLocalHub, saveOrderEditOffline, computeKitchenPrintDelta } from '@/lib/offline-order-helpers';
import { triggerBackgroundSync } from '@/lib/offline-sync';
import { computeDiscountFromInputs, loadDiscountDraft, saveDiscountDraft } from '@/lib/discount-draft';
import { reportPrintOutcome, listenForPrintSentMessages } from '@/lib/print-notify';
import { buildCategoryLookup, dispatchKitchenPrints, isCategoryPrintRoutingEnabled } from '@/lib/kitchen-print-routing';
import { useToast } from '@/lib/toast';
import AddItemsManager from '@/pages/dashboard/sales/components/AddItemsManager';
import CancelOrderModal from '@/components/CancelOrderModal';
import { resolveProductImage, resolveOrderImage } from '@/lib/food-images';

const BASE_FILTERS = ['All', 'Dine In', 'Take Away', 'Delivery'];

// Order card styling, keyed by status - a thin all-around border + a
// matching soft background tint + badge tone, so the card's state reads at
// a glance without needing to parse the text.
const STATUS_BORDER: Record<string, string> = {
  pending: 'border-amber-300/70',
  completed: 'border-emerald-300/70',
  paid: 'border-sky-300/70',
  cancelled: 'border-rose-300/70',
};

// Soft status-tinted wash for the card body (replaces the old flat left
// accent bar) - light enough to still read as glass, tinted enough to tell
// pending/completed/paid/cancelled apart at a glance.
const STATUS_CARD_BG: Record<string, string> = {
  pending: 'from-amber-50/85 to-white/40',
  completed: 'from-emerald-50/85 to-white/40',
  paid: 'from-sky-50/85 to-white/40',
  cancelled: 'from-rose-50/85 to-white/40',
};

// Richer gradient (rather than a flat pale tint) so the status pill reads
// as a glossy, slightly raised badge - matching the gold "PENDING" pill
// look from the card design reference.
const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950',
  completed: 'bg-gradient-to-b from-emerald-300 to-emerald-500 text-emerald-950',
  paid: 'bg-gradient-to-b from-sky-300 to-sky-500 text-sky-950',
  cancelled: 'bg-gradient-to-b from-rose-300 to-rose-500 text-rose-950',
};

// The "TOTAL | Rs X" pill now carries the same status color as the badge
// above it (rather than always being a flat dark pill), so pending and
// completed orders are colored consistently across the whole card.
const STATUS_TOTAL_PILL: Record<string, string> = {
  pending: 'bg-gradient-to-b from-amber-400 to-amber-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(120,53,15,0.4)]',
  completed: 'bg-gradient-to-b from-emerald-400 to-emerald-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(6,78,59,0.4)]',
  paid: 'bg-gradient-to-b from-sky-400 to-sky-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(12,74,110,0.4)]',
  cancelled: 'bg-gradient-to-b from-rose-400 to-rose-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(136,19,55,0.4)]',
};

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
  const { toast, popup } = useToast();
  // The hidden auto-print iframe (see printReadyUrl further down) loads
  // PrintOrderPage.tsx in its own separate React tree - a toast shown from
  // inside it would render invisibly in that hidden iframe. It posts a
  // message up here instead once it's actually called window.print(); this
  // is what shows the popup for real, on screen. See print-notify.ts.
  useEffect(() => listenForPrintSentMessages(toast), [toast]);
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  // Every dine-in table's Family/Simple category, loaded once so each order
  // card and the detail panel can look up "is table 7 a Family Table?"
  // by name without re-fetching per order - see Table model / isFamily in
  // TableManagementSection.tsx, the same source used on the POS table grid.
  const [tables, setTables] = useState<Table[]>([]);
  // Real, DB-backed waiters (previously this filter row had hardcoded
  // placeholder names - "Fariha"/"Ahsan Raza"/etc - that never matched any
  // real order and made the filter buttons silently do nothing when
  // clicked) - see BASE_FILTERS above and the filters memo below.
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  // Staff with designation "Delivery Rider" (see waiterController.getRiders)
  // - the picker OnlineOrderControls shows for assigning a Delivery order.
  const [riders, setRiders] = useState<Rider[]>([]);
  // Per-order-type "print the customer receipt automatically the instant
  // this order is completed & settled" - a Shop Owner setting (see
  // SettingsPage.tsx's ReceiptAutoPrintSection / models/Shop.js's
  // receiptAutoPrint), not a per-device one, so it's the same across every
  // till. Read only by completeOrder below - never affects the always-
  // available manual Print Receipt button/printer icon.
  const [receiptAutoPrint, setReceiptAutoPrint] = useState({ dineIn: false, takeAway: false, delivery: false });
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
  // Discount now lives on the order-details card (above the Complete Order
  // button), not the Confirm Payment modal - the cashier sets it while
  // reviewing the order, before ever opening that modal, using either a
  // flat PKR amount or a percent of the subtotal (Amount wins if both are
  // filled). Backed by sessionStorage per order id (see
  // loadDiscountDraft/saveDiscountDraft above the component) - switching to
  // a different order's card loads THAT order's own draft instead of
  // clearing (see selectOrder), and navigating away entirely (e.g. to the
  // Manual Print Center to check the receipt) and back still finds it, since
  // this component itself gets fully unmounted by that route change and
  // plain useState alone can't survive that. NOT cleared when the Complete
  // Payment modal opens/closes, since that would erase the very discount
  // the cashier just set.
  const [discountAmountInput, setDiscountAmountInput] = useState('');
  const [discountPercentInput, setDiscountPercentInput] = useState('');

  // Covers every OTHER way selectedOrder's id can change besides an
  // explicit selectOrder() click - the initial load, a background refresh
  // tick, and (the case this exists for) coming back from a route change
  // like the Manual Print Center, where this whole component just
  // remounted and selectedOrder is being set fresh from the cache. Keyed on
  // the id specifically (not the object) so it does NOT re-fire - and
  // wipe out whatever the cashier is mid-typing - every time a periodic
  // background refresh hands back a new object for the SAME order.
  useEffect(() => {
    if (!selectedOrder?.id) return;
    const draft = loadDiscountDraft(selectedOrder.id);
    setDiscountAmountInput(draft.amount);
    setDiscountPercentInput(draft.percent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrder?.id]);

  // The other half of the persistence - saves on every keystroke so a
  // navigate-away-and-back (or even a full app restart's worth of typing
  // history, since this fires continuously, not just on blur) always has
  // the latest value to restore. Empty-both is treated as "cleared" inside
  // saveDiscountDraft itself, which is what makes actually deleting the
  // typed value the one thing that stops it from persisting.
  useEffect(() => {
    if (!selectedOrder?.id) return;
    saveDiscountDraft(selectedOrder.id, discountAmountInput, discountPercentInput);
  }, [selectedOrder?.id, discountAmountInput, discountPercentInput]);

  const [customerDue, setCustomerDue] = useState(0);
  const [printReadyUrl, setPrintReadyUrl] = useState<string | null>(null);
  const [isSendingWA, setIsSendingWA] = useState(false);
  // Set once the cashier clicks Confirm Payment/Pay Full in the Complete
  // Payment modal - opens a second "Order Details Preview" popup (Technical
  // Requirements for Dynamic Popups #2) showing the full item list and
  // totals one more time before anything is actually charged/saved. The
  // real completeAndSettle call only happens from that preview's own
  // Confirm button (see confirmCompletePayment).
  const [paymentPreview, setPaymentPreview] = useState<{ full: boolean; paid: number } | null>(null);
  // Scrolled into view the instant the Complete Payment modal opens, so
  // the Confirm Payment/Pay Full buttons are visible without the cashier
  // needing to manually scroll down past the discount fields and bill
  // breakdown first (Technical Requirements #2 - Auto-Scroll Feature).
  const paymentButtonsRef = useRef<HTMLDivElement>(null);
  // Scrolled into view whenever a pending order is selected from the list,
  // so the Complete Order/Cancel Order buttons at the bottom of the detail
  // panel are visible immediately - no manual scrolling needed to find
  // them, matching the same auto-scroll pattern as the payment modal above.
  const completeButtonsRef = useRef<HTMLDivElement>(null);
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
    void fetchTables().then((result) => setTables(result ?? [])).catch(() => setTables([]));
    // Shop status can change (someone closes the shop) while this page is
    // sitting open, so the shift window is kept in sync the same way
    // RecordPage.tsx and the Dashboard do.
    const intervalId = setInterval(() => void loadAny(), 45000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // Auto-scroll to the Confirm Payment/Pay Full buttons as soon as the
  // Complete Payment modal opens - the modal's own content (discount
  // fields + bill breakdown) can push them below the fold on shorter
  // screens, and this makes finalizing the sale possible without any
  // manual scrolling. Runs on the next paint (rAF) so the modal has
  // actually mounted first.
  useEffect(() => {
    if (!showPayment) return;
    const frame = requestAnimationFrame(() => {
      paymentButtonsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    return () => cancelAnimationFrame(frame);
  }, [showPayment]);

  // Same idea, one level up: clicking a pending order card in the list
  // selects it and the detail panel appears to the right, but on a shorter
  // window the Complete Order/Cancel Order buttons at the very bottom of
  // that panel can sit below the fold. Scroll straight to them the moment
  // a pending order is selected - keyed on id/status (not the whole
  // selectedOrder object) so the background 45s refresh doesn't re-trigger
  // this every time it swaps in a fresh object for the same order.
  useEffect(() => {
    if (!selectedOrder || selectedOrder.status !== 'pending') return;
    const frame = requestAnimationFrame(() => {
      completeButtonsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    return () => cancelAnimationFrame(frame);
    // Deliberately NOT depending on the whole selectedOrder object - see
    // comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrder?.id, selectedOrder?.status]);

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

  // table name -> isFamily, so any order's `table` field (just a plain
  // string like "7") can be resolved to its Family/Simple category without
  // re-fetching per card. See Table model / TableManagementSection.tsx.
  const familyTableNames = useMemo(() => {
    const map: Record<string, boolean> = {};
    tables.forEach((t) => { map[t.name] = t.isFamily; });
    return map;
  }, [tables]);

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
  // Shared with PrintOrderPage.tsx's Manual Print Center preview - see
  // discount-draft.ts's own comment for why this math lives in one place
  // instead of two copies that could quietly drift apart.
  const discountForOrder = computeDiscountFromInputs(discountAmountInput, discountPercentInput, orderSubtotal);
  const discountAmount = discountForOrder?.amount ?? 0;
  const discountType: Discount['type'] = discountForOrder?.type ?? 'percent';
  const discountRawValue = discountForOrder?.value ?? 0;
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
        const riderData = await fetchRiders();
        if (riderData) setRiders(riderData.filter((rider) => rider.isActive));
      } catch {
        // Best-effort - the rider picker just shows no options until this
        // succeeds; doesn't block anything else on the page.
      }

      try {
        const shopProfile = await fetchShopProfile();
        if (shopProfile?.receiptAutoPrint) {
          setReceiptAutoPrint({
            dineIn: Boolean(shopProfile.receiptAutoPrint.dineIn),
            takeAway: Boolean(shopProfile.receiptAutoPrint.takeAway),
            delivery: Boolean(shopProfile.receiptAutoPrint.delivery),
          });
        }
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
    // Discount now lives on the order-details card itself (see the
    // Complete Order button's own comment below), not the payment modal -
    // loading (rather than blindly clearing) here is what makes a discount
    // typed for THIS order still be there on switching back to it, while a
    // different order's card still starts from whatever ITS OWN saved
    // draft is (usually none) - see loadDiscountDraft's own comment for why
    // this can't just be plain component state.
    const draft = loadDiscountDraft(order.id);
    setDiscountAmountInput(draft.amount);
    setDiscountPercentInput(draft.percent);
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
  // on-demand Print Receipt button below and confirmCompletePayment's own
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
        //
        // This button is only ever called with `selectedOrder` (see its
        // one call site below), so for a still-pending order,
        // discountForOrder/adjustedTotal are exactly the same typed-but-
        // not-yet-saved discount preview PrintOrderPage.tsx's Manual Print
        // Center shows - order.discount itself is still null/unset until
        // Confirm & Complete actually runs, so without this override,
        // printing straight to a configured counter printer from this
        // button would silently drop the discount even though the cashier
        // can see it applied on screen.
        const receiptData = order.status === 'pending'
          ? { ...order, discount: discountForOrder, total: adjustedTotal, previousDues: customerDue }
          : { ...order, previousDues: customerDue };
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

  // Step 1 of finalizing a sale: validates the amount and opens the Order
  // Details Preview popup (Technical Requirements #2) instead of charging
  // anything immediately - the actual completeAndSettle call only happens
  // from that preview's own Confirm button, see confirmCompletePayment.
  function openPaymentPreview(full: boolean) {
    if (!selectedOrder) return;
    const paid = full ? payable : Number(paymentAmount || 0);
    if (!full && (paid < 0 || paid > payable)) {
      popup({ tone: 'error', title: 'Invalid Payment Amount', message: 'Enter a valid payment amount.' });
      return;
    }
    // Nothing typed in Amount Paid is only allowed through with the
    // "Put in Pending" box explicitly ticked - a bare Confirm Payment
    // click with an empty field (a stray click, a misplaced tap) used to
    // silently complete the order with paid=0 and leave the whole bill as
    // an unpaid due with no confirmation at all. Typing any real amount
    // (partial or full via the field) never needs the tick.
    if (!full && paid === 0 && !confirmPending) {
      popup({ tone: 'error', title: 'Payment Amount Required', message: 'Enter a payment amount, or check "Put in Pending" to confirm this order with no payment collected.' });
      return;
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
        popup({ tone: 'error', title: 'Customer Details Required', message: "Add the customer's name and phone number before confirming a partial payment - dues need a real customer to track them against. Edit the order first, or pay in full instead." });
        return;
      }
    }
    // Swap to the preview instead of stacking it on top of this modal.
    setShowPayment(false);
    setPaymentPreview({ full, paid });
  }

  // Step 2: the cashier reviewed the preview and confirmed it. `paid` here
  // is the FULL amount actually collected right now - this order's own
  // bill plus whatever of the customer's other outstanding dues (Previous
  // Dues, above) the cashier chose to collect alongside it. The backend's
  // completeAndSettle action pays down the customer's older dues/pending
  // orders first with it, oldest first, and only applies what's left to
  // this order - see orderController.updateOrder.
  async function confirmCompletePayment() {
    if (!selectedOrder || !paymentPreview) return;
    const { paid } = paymentPreview;
    const updated = await saveUpdate({ status: 'completed', action: 'completeAndSettle', paidAmount: paid, discount: discountForOrder });
    if (!updated) return;
    // Auto-print is opt-in per order type (Settings > Hardware/POS - see
    // receiptAutoPrint above) - a Shop Owner explicitly turns this back on
    // for whichever type(s) they want. Off by default for every shop, so
    // nothing changes here unless they've saved that preference. The
    // manual Print Receipt button/printer icon stay available regardless.
    const shouldAutoPrint =
      (updated.orderType === 'DineIn' && receiptAutoPrint.dineIn) ||
      (updated.orderType === 'TakeAway' && receiptAutoPrint.takeAway) ||
      (updated.orderType === 'Delivery' && receiptAutoPrint.delivery);
    if (shouldAutoPrint) printCustomerReceipt(updated);
    await sendCompletedReceiptOnWhatsApp(updated);
    setPaymentPreview(null);
    setShowPayment(false);
    setPaymentAmount('');
    setConfirmPending(false);
    setDiscountAmountInput('');
    setDiscountPercentInput('');
    // Technical Requirements for Dynamic Popups #2 - Post-Payment Success
    // Popup: compact, responsive, and states the outcome plainly.
    popup({ tone: 'success', title: 'Order Completed Successfully', message: `Order #${orderNumber(updated)} - Rs ${paid} collected.` });
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

  const [updatingTrackingStatus, setUpdatingTrackingStatus] = useState(false);

  // Advances a customer-qr order's tracking lifecycle (see
  // orderController.exports.updateTrackingStatus) - this is the staff-side
  // half of the QR ordering feature: confirm it into the kitchen queue,
  // mark it preparing/ready, or decline it outright. Firing "confirmed" on
  // a Delivery order also triggers the WhatsApp rider notification
  // server-side - nothing extra to do here for that.
  async function handleTrackingStatusChange(order: SavedOrder, trackingStatus: TrackingStatus) {
    if (trackingStatus === 'cancelled' && !window.confirm('Decline/cancel this online order?')) return;
    setUpdatingTrackingStatus(true);
    try {
      const updated = await updateOrderTrackingStatus(order.id, trackingStatus);
      if (updated) {
        localEditVersionRef.current += 1;
        setOrders((previous) => previous.map((o) => (o.id === updated.id ? updated : o)));
        setSelectedOrder(updated);
        toast.success(`Order #${updated.dailyOrderNumber ?? updated.id} marked ${trackingStatus.replace('_', ' ')}.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update this order.');
    } finally {
      setUpdatingTrackingStatus(false);
    }
  }

  const [assigningRider, setAssigningRider] = useState(false);

  // Hands a confirmed/accepted Delivery order to a specific staff member
  // with designation "Delivery Rider" (see waiterController.getRiders) and
  // fires the targeted WhatsApp notification server-side (orderController.
  // assignRider -> riderNotificationService.notifyAssignedRider) with the
  // customer's order details and captured delivery location.
  async function handleAssignRider(order: SavedOrder, rider: Rider) {
    setAssigningRider(true);
    try {
      const result = await assignOrderRider(order.id, { id: rider.id, name: rider.name, phone: rider.phone });
      if (result?.order) {
        localEditVersionRef.current += 1;
        setOrders((previous) => previous.map((o) => (o.id === result.order.id ? result.order : o)));
        setSelectedOrder(result.order);
        toast.success(
          result.riderNotified
            ? `Assigned to ${rider.name} - WhatsApp sent.`
            : `Assigned to ${rider.name}, but the WhatsApp message could not be sent.`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not assign this rider.');
    } finally {
      setAssigningRider(false);
    }
  }

  const [respondingToChangeRequest, setRespondingToChangeRequest] = useState(false);

  // Staff-side approve/reject for a customer's own request to add/remove
  // items on an order they already placed (see orderController.
  // respondToChangeRequest). Approving is irreversible - it edits
  // order.items for real server-side (see OnlineOrderControls below for
  // the confirm prompt), same as any other order edit.
  async function handleRespondToChangeRequest(order: SavedOrder, action: 'approve' | 'reject') {
    setRespondingToChangeRequest(true);
    try {
      const updated = await respondToOrderChangeRequest(order.id, action);
      if (updated) {
        localEditVersionRef.current += 1;
        setOrders((previous) => previous.map((o) => (o.id === updated.id ? updated : o)));
        setSelectedOrder(updated);
        toast.success(action === 'approve' ? 'Change request approved - order updated.' : 'Change request declined.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not respond to this request.');
    } finally {
      setRespondingToChangeRequest(false);
    }
  }

  async function addItems(items: Array<{ name: string; price: number; quantity: number; variation: string; image?: string }>) {
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
      lines.push(`*The Heaven Slice*`);
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
      {/* 2-up on phone widths (a 4-up row left ~85px per card, which
          truncated every currency value down to "Rs 45,2..." - illegible),
          4-up from tablet width (sm, 640px) up where there's actually room. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="Pending Orders" value={String(visibleOrders.length)} />
        <StatCard label="Completed" value={String(filteredOrders.filter((order) => order.status === 'completed').length)} />
        <StatCard label="Cancelled" value={String(filteredOrders.filter((order) => order.status === 'cancelled').length)} />
        <StatCard label="Open Value" value={`Rs ${visibleOrders.reduce((sum, order) => sum + order.total, 0)}`} />
      </div>

      {/* Order detail sits to the right of the order list from tablet width
          (sm, 640px) up, matching the POS checkout panel. Below that (a
          real phone) a fixed 260px+ sidebar next to a usable order grid
          doesn't fit at all - it stacks to one column instead: order list
          on top, detail panel underneath. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-4 lg:min-h-[calc(100vh-14rem)] lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,26%)] lg:gap-6 lg:items-stretch">
        <section className="min-w-0 space-y-5 lg:flex lg:min-h-0 lg:flex-col">
          <div className="glass rounded-[32px] p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-md">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search orders, tables, customers, waiters" className="w-full rounded-full border border-white/60 bg-white/50 py-4 pl-12 pr-4 shadow-inner outline-none focus:border-[#D6E332]" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <p className="max-w-xs text-xs font-bold text-gray-500">
                  {shopSession
                    ? `Showing orders for ${shopSession.status === 'open' ? 'the current open shift' : "this shop's last shift"} - not split by calendar date.`
                    : 'No shift recorded yet. Open the shop to start taking orders.'}
                </p>
                <button type="button" onClick={() => void loadAny()} className="glass-dark rounded-2xl px-4 py-3 text-sm font-black"><RefreshCcw size={16} className="mr-2 inline" />Refresh</button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {filters.map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`rounded-full px-4 py-2 text-sm font-bold transition ${filter === item ? 'glass-dark' : 'bg-white/50 text-gray-600 shadow-inner hover:bg-white/70'}`}>{item}</button>)}
            </div>
          </div>

          {loading ? <Surface text="Loading orders..." /> : null}
          {!loading && visibleOrders.length === 0 ? <Surface text="No orders matched the current filters." /> : null}
          {!loading && visibleOrders.length > 0 ? (
            // auto-fill/minmax instead of fixed breakpoint columns - order
            // cards resize fluidly with the available width (which now
            // varies since the detail panel is always pinned to the right)
            // instead of ever needing a horizontal scrollbar.
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-3 md:grid-cols-3 lg:min-h-0 lg:flex-1 lg:content-start lg:grid-cols-3 lg:overflow-y-auto lg:pr-2 xl:grid-cols-4">
              {pagedOrders.map((order) => {
                const isSelected = selectedOrder?.id === order.id;
                const heroImage = resolveOrderImage(order.items);
                return (
                <button
                  key={order.id}
                  type="button"
                  onClick={() => selectOrder(order)}
                  className={`min-w-0 overflow-hidden rounded-[28px] border bg-gradient-to-br backdrop-blur-xl backdrop-saturate-150 text-left transition-all duration-200 ${
                    isSelected
                      ? '-translate-y-1 border-[#D6E332] from-[#FBFDEB]/80 to-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_10px_rgba(214,227,50,0.3)] ring-1 ring-[#E2F33C]/60'
                      : `${STATUS_BORDER[order.status] ?? 'border-gray-200'} ${STATUS_CARD_BG[order.status] ?? 'from-white/60 to-white/25'} shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_10px_rgba(15,23,42,0.14)] hover:-translate-y-1.5 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-5px_12px_rgba(15,23,42,0.2)]`
                  }`}
                >
                  <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
                    <img src={heroImage} alt={order.items[0]?.name ?? 'Order'} loading="lazy" className="h-full w-full object-cover" />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-black/0 to-transparent" />
                    <span className={`absolute right-2 top-2 rounded-full px-3 py-1 text-[11px] font-black uppercase shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-1px_3px_rgba(0,0,0,0.12)] ${STATUS_BADGE[order.status] ?? 'bg-gray-100 text-gray-600'}`}>{order.status}</span>
                    <span className="absolute bottom-2 left-2 min-w-0 max-w-[85%] truncate rounded-full bg-white/90 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-700 shadow-sm backdrop-blur-sm">
                      {age(order.createdAt)} &middot; {formatOrderDateTime(order.createdAt)}
                    </span>
                  </div>
                  <div className="p-4">
                    {/* A customer placed this straight from the QR ordering
                        page (see publicOrderController.js) - staff need to
                        see "this needs to be accepted" right on the card
                        itself, not only after clicking in to Order Detail
                        (see OnlineOrderControls there for the actual
                        accept/decline actions). Pulses while still
                        unconfirmed so a new online order is hard to miss in
                        a busy grid of cards. */}
                    {order.source === 'customer-qr' && order.trackingStatus && order.trackingStatus !== 'cancelled' ? (
                      <div
                        className={`mb-2 flex items-center gap-1 rounded-lg px-2 py-1 text-[9px] font-black uppercase tracking-wide ${
                          order.trackingStatus === 'awaiting_confirmation' ? 'animate-pulse bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-700'
                        }`}
                      >
                        <Globe size={10} className="shrink-0" />
                        <span className="truncate">
                          {order.trackingStatus === 'awaiting_confirmation' ? 'Online - Waiting Acceptance' : `Online - ${TRACKING_STEP_LABEL[order.trackingStatus] || order.trackingStatus}`}
                        </span>
                      </div>
                    ) : null}
                    {order.source === 'customer-qr' && order.customerChangeRequest?.status === 'pending' ? (
                      <div className="mb-2 flex animate-pulse items-center gap-1 rounded-lg bg-amber-500 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-white">
                        <Edit3 size={10} className="shrink-0" />
                        <span className="truncate">Change Requested</span>
                      </div>
                    ) : null}
                    <h3 className="truncate text-lg font-black text-gray-900">Order #{orderNumber(order)}</h3>
                    <div className="mt-3 space-y-2 text-sm text-gray-600">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="min-w-0 shrink-0"><Line icon={<UserRound size={15} />} text={label(order)} /></div>
                        {order.orderType === 'DineIn' && order.table ? (
                          <TableTypeBadge tableName={order.table} isFamily={familyTableNames[order.table]} />
                        ) : null}
                      </div>
                      <Line icon={<Phone size={15} />} text={phoneLabel(order)} />
                      <Line icon={<ShoppingBag size={15} />} text={`${prettyType(order)} • ${order.itemCount ?? order.items.length} items`} />
                    </div>
                    <div className={`mt-4 flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-black ${STATUS_TOTAL_PILL[order.status] ?? 'glass-dark'}`}>
                      <span className="text-[10px] font-bold uppercase tracking-widest text-white/75">Total</span>
                      <span className="text-white/40">|</span>
                      <span className="truncate">Rs {order.total}</span>
                    </div>
                  </div>
                </button>
                );
              })}
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

        <aside className="glass min-w-0 rounded-[32px] lg:self-start">
          {selectedOrder ? (
            <div className="flex flex-col">
              <div className="shrink-0 border-b border-white/40 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div><p className="text-xs font-black uppercase tracking-[0.18em] text-gray-500">Order Detail</p><h2 className="mt-2 text-2xl font-black text-gray-900">Order #{orderNumber(selectedOrder)}</h2><p className="mt-2 text-sm text-gray-500">{formatOrderDateTime(selectedOrder.createdAt)}</p>
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
                      <button disabled={isSendingWA || !isSelectedOrderHydrated} type="button" onClick={() => void handleSendWhatsAppReciept(selectedOrder)} className="rounded-2xl bg-gradient-to-b from-emerald-400 to-emerald-600 px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] disabled:opacity-50">
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
                    }} className="glass-dark rounded-2xl px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] disabled:opacity-50">Send to Kitchen</button>
                    <button disabled={!isSelectedOrderHydrated} type="button" onClick={() => printCustomerReceipt(selectedOrder)} className="glass-pill rounded-2xl px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-gray-700 disabled:opacity-50">Print Receipt</button>
                    <Link to={`/dashboard/sales/print/${selectedOrder.id}`} className="glass-pill rounded-2xl p-2.5 text-gray-500"><Printer size={16} /></Link>
                    <button type="button" onClick={() => void refreshOne(selectedOrder.id)} className="glass-pill rounded-2xl p-2.5 text-gray-500"><RefreshCcw size={16} /></button>
                    {selectedOrder.status === 'pending' ? (
                      <Link to={`/dashboard/sales/${selectedOrder.id}/edit`} className="glass-pill rounded-2xl px-3 py-2.5 text-xs font-black text-gray-600">Edit</Link>
                    ) : (
                      <span className="glass-pill cursor-not-allowed rounded-2xl px-3 py-2.5 text-xs font-black text-gray-400">Edit Locked</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-5 p-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Box label="Order Number" value={`#${orderNumber(selectedOrder)}`} />
                  <Box label="Created At" value={formatOrderDateTime(selectedOrder.createdAt)} />
                  <Box label="Customer" value={label(selectedOrder)} />
                  {/* Shows the real "Waiter" label only when there's no real
                      customer phone to show instead (see phoneLabel's own
                      comment) - a Dine-In order placed through the customer
                      QR page always has a real phone and no waiter, a
                      staff-placed Dine-In order usually has the reverse. */}
                  <Box label={selectedOrder.orderType === 'DineIn' && !hasCustomerPhone(selectedOrder) ? 'Waiter' : 'Phone'} value={phoneLabel(selectedOrder)} />
                  {/* Dedicated Waiter box - only shown when there IS a real
                      phone number above (so the waiter box above didn't
                      already cover it) and a waiter is actually assigned,
                      e.g. a Dine-In order a customer placed via QR that
                      staff then assigned a waiter to after the fact. */}
                  {selectedOrder.orderType === 'DineIn' && hasCustomerPhone(selectedOrder) && selectedOrder.waiter ? (
                    <Box label="Waiter" value={selectedOrder.waiter} />
                  ) : null}
                  {selectedOrder.orderType === 'DineIn' ? (
                    selectedOrder.status === 'pending' ? (
                      <button
                        disabled={!isSelectedOrderHydrated}
                        type="button"
                        onClick={() => setShowTableEdit(true)}
                        className="min-w-0 rounded-[20px] bg-white/50 px-4 py-3 text-left shadow-inner transition hover:bg-white/70 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-500">Table Category</p>
                        <div className="mt-1.5 flex items-center gap-1.5">
                          {selectedOrder.table ? <TableTypeBadge tableName={selectedOrder.table} isFamily={familyTableNames[selectedOrder.table]} /> : <span className="text-sm font-bold text-gray-900">Not set</span>}
                          <Pencil size={12} className="shrink-0 text-gray-400" />
                        </div>
                      </button>
                    ) : selectedOrder.table ? (
                      <div className="min-w-0 rounded-[20px] bg-white/50 px-4 py-3 shadow-inner">
                        <p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-500">Table Category</p>
                        <div className="mt-1.5"><TableTypeBadge tableName={selectedOrder.table} isFamily={familyTableNames[selectedOrder.table]} /></div>
                      </div>
                    ) : (
                      <Box label="Table" value="N/A" />
                    )
                  ) : null}
                  <Box label="Order Type" value={prettyType(selectedOrder)} />
                  <Box label="Address" value={selectedOrder.address || 'N/A'} />
                  <Box label="Payment Method" value={selectedOrder.paymentMethod} />
                  {selectedOrder.orderType === 'Delivery' ? (
                    selectedOrder.deliveryLocation?.lat != null && selectedOrder.deliveryLocation?.lng != null ? (
                      <a
                        href={`https://maps.google.com/?q=${selectedOrder.deliveryLocation.lat},${selectedOrder.deliveryLocation.lng}`}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 rounded-[20px] bg-[#F8F9FB] px-4 py-3 transition hover:bg-gray-100"
                      >
                        <p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Delivery Location</p>
                        <p className="mt-1 flex items-center gap-1.5 text-sm font-bold text-indigo-600">
                          <MapPin size={12} className="shrink-0" /> Open in Maps
                        </p>
                      </a>
                    ) : (
                      <Box label="Delivery Location" value="Not shared" />
                    )
                  ) : null}
                  <Box label="Previous Dues" value={`Rs ${customerDue}`} />
                  <Box label="Remaining" value={`Rs ${selectedOrder.remainingAmount ?? 0}`} />
                  {selectedOrder.note ? <Box label="Note" value={selectedOrder.note} /> : null}
                </div>

                {selectedOrder.source === 'customer-qr' ? (
                  <OnlineOrderControls
                    order={selectedOrder}
                    updating={updatingTrackingStatus}
                    onChange={handleTrackingStatusChange}
                    riders={riders}
                    assigningRider={assigningRider}
                    onAssignRider={handleAssignRider}
                    respondingToChangeRequest={respondingToChangeRequest}
                    onRespondToChangeRequest={handleRespondToChangeRequest}
                  />
                ) : null}

                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-black uppercase tracking-[0.18em] text-gray-500">Items</h3>
                    {selectedOrder.status === 'pending' ? (
                      <button disabled={!isSelectedOrderHydrated} type="button" onClick={() => setShowAddItems(true)} className="glass-dark rounded-full px-4 py-2 text-xs font-black disabled:cursor-not-allowed disabled:opacity-50"><PackagePlus size={14} className="mr-2 inline" />Add Items</button>
                    ) : (
                      <span className="glass-pill rounded-full px-4 py-2 text-xs font-black text-gray-500">Order Locked</span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {!isSelectedOrderHydrated ? (
                      <p className="text-sm text-gray-400">Loading items...</p>
                    ) : (
                      selectedOrder.items.map((item, index) => (
                        <div key={`${item.name}-${index}`} className="flex items-center gap-3 rounded-[24px] bg-white/45 p-3 shadow-inner">
                          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[16px] bg-slate-100 shadow-inner">
                            <img src={resolveProductImage({ image: item.image, name: item.name })} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                          </div>
                          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <div className="min-w-0"><p className="truncate font-black text-gray-900">{item.name}</p><p className="text-xs text-gray-500">{item.variation}</p></div>
                            <div className="shrink-0 text-right"><p className="text-sm font-black text-gray-900">Rs {item.price * item.quantity}</p><p className="text-xs text-gray-500">Qty {item.quantity}</p></div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="shrink-0 space-y-4 rounded-b-[32px] border-t border-white/40 bg-white/30 p-6">
                <div className="rounded-[24px] bg-white/50 p-4 shadow-inner">
                  <Row label="Subtotal" value={`Rs ${orderSubtotal}`} />
                  <Row label="Tax" value={`Rs ${orderTax}`} />
                  {/* While still pending, this reflects the discount the
                      cashier has typed into the card above but hasn't
                      confirmed yet - a live preview, same figures the
                      Complete Payment modal itself will use. Once the order
                      is actually completed, `discountAmountInput`/
                      `discountPercentInput` are reset (see
                      confirmCompletePayment), so from that point on this
                      reads the real, persisted selectedOrder.discount
                      instead - both branches now always spell out
                      value-vs-percentage explicitly rather than leaving a
                      blank suffix for a flat-value discount. */}
                  {selectedOrder.status === 'pending' ? (
                    discountAmount > 0 ? (
                      <Row label={`Discount (${discountType === 'percent' ? `${discountRawValue}% - Percentage` : 'Fixed Value'})`} value={`-Rs ${discountAmount}`} />
                    ) : null
                  ) : selectedOrder.discount && selectedOrder.discount.amount > 0 ? (
                    <Row label={`Discount (${selectedOrder.discount.type === 'percent' ? `${selectedOrder.discount.value}% - Percentage` : 'Fixed Value'})`} value={`-Rs ${selectedOrder.discount.amount}`} />
                  ) : null}
                  <Row label="Bill Total" value={`Rs ${selectedOrder.status === 'pending' ? adjustedTotal : selectedOrder.total}`} />
                  <Row label="Previous Dues" value={`Rs ${customerDue}`} />
                  <Row label="Paid" value={`Rs ${selectedOrder.paidAmount ?? 0}`} />
                  <Row label="Grand Total" value={`Rs ${(selectedOrder.status === 'pending' ? adjustedTotal : selectedOrder.total) + customerDue}`} strong />
                </div>
                {selectedOrder.status === 'pending' ? (
                  <div ref={completeButtonsRef} className="grid gap-2.5">
                    <button
                      disabled={!isSelectedOrderHydrated}
                      type="button"
                      onClick={() => { setDiscountAmountInput(''); setDiscountPercentInput(''); setShowPayment(true); }}
                      className="flex items-center justify-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-emerald-400 to-emerald-600 px-5 py-4 text-lg font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.5),inset_0_-4px_10px_rgba(6,95,70,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <CheckCircle2 size={20} /> Complete Order
                    </button>
                    {hasPermission('sales.delete') ? (
                      <button
                        disabled={!isSelectedOrderHydrated}
                        type="button"
                        onClick={() => setShowCancel(true)}
                        className="flex items-center justify-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-rose-500 to-rose-700 px-5 py-4 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-4px_10px_rgba(136,19,55,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Lock size={16} /> Cancel Order
                      </button>
                    ) : null}
                  </div>
                ) : selectedOrder.status === 'cancelled' ? (
                  <div className="space-y-1.5 rounded-[24px] bg-rose-50/60 px-4 py-4 text-sm font-bold text-rose-700 shadow-inner">
                    <p>This order was cancelled and kept for record.</p>
                    {selectedOrder.cancelledBy ? <p className="text-xs font-semibold text-rose-500">Cancelled by {selectedOrder.cancelledBy}{selectedOrder.cancelledAt ? ` · ${formatOrderDateTime(selectedOrder.cancelledAt)}` : ''}</p> : null}
                    {selectedOrder.cancelReason ? <p className="text-xs font-semibold text-rose-500">Reason: {selectedOrder.cancelReason}</p> : null}
                  </div>
                ) : <div className="rounded-[24px] bg-emerald-50/60 px-4 py-4 text-sm font-bold text-emerald-700 shadow-inner">This order is completed and stored in sales history.</div>}
              </div>
            </div>
          ) : <div className="flex min-h-[680px] flex-col items-center justify-center gap-4 p-6 text-center text-gray-400 lg:min-h-0 lg:h-full"><ShoppingBag size={56} strokeWidth={1.4} /><div><p className="font-bold text-gray-500">Select an order</p><p className="text-sm">Choose any order card from the left.</p></div></div>}
        </aside>
      </div>

      {showPayment && selectedOrder ? (
        <Modal title="Complete Payment" onClose={() => { setShowPayment(false); setConfirmPending(false); }}>
          <div className="space-y-4">
            {/* Discount is set on the order-details card itself now, before
                Complete Order is even clicked (see that button's own
                comment) - this modal just reviews the figures it already
                produces, read-only. */}
            <div className="rounded-[24px] bg-white/50 p-4 text-sm shadow-inner">
              <Row label="Subtotal" value={`Rs ${orderSubtotal}`} />
              <Row label="Tax" value={`Rs ${orderTax}`} />
              {discountAmount > 0 ? (
                <Row label={`Discount (${discountType === 'percent' ? `${discountRawValue}% - Percentage` : 'Fixed Value'})`} value={`-Rs ${discountAmount}`} />
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
                  // Clamped to the Final Payable figure as they type -
                  // can't overpay an order (previously this only caught an
                  // over-typed amount at Confirm Payment click time, via
                  // openPaymentPreview's own `paid > payable` check below,
                  // which let something like "100000" sit in the field
                  // looking valid until submit).
                  const digitsOnly = event.target.value;
                  const clamped = digitsOnly === '' ? '' : String(Math.min(Number(digitsOnly), payable));
                  setPaymentAmount(clamped);
                  // Typing a real amount supersedes the tick below - only
                  // relevant while it's still empty.
                  if (clamped) setConfirmPending(false);
                }}
                className="w-full rounded-2xl border border-white/60 bg-white/50 px-4 py-3 shadow-inner outline-none"
                placeholder={`Up to Rs ${payable}`}
              />
            </div>
            <div ref={paymentButtonsRef} className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => openPaymentPreview(false)} className="glass-dark rounded-[20px] px-4 py-3 text-sm font-black transition hover:brightness-110">Confirm Payment</button>
              <button type="button" onClick={() => openPaymentPreview(true)} className="rounded-[20px] border-[0.5px] border-white/50 bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] px-4 py-3 text-sm font-black text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-3px_8px_rgba(132,144,10,0.4)] transition hover:brightness-105">Pay Full</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {paymentPreview && selectedOrder ? (
        <Modal title="Confirm Order Payment" onClose={() => { setPaymentPreview(null); setShowPayment(true); }}>
          <div className="space-y-4">
            <div className="rounded-[24px] bg-white/50 p-4 shadow-inner">
              <p className="mb-3 text-xs font-black uppercase tracking-[0.16em] text-gray-400">
                Order #{orderNumber(selectedOrder)} &middot; {label(selectedOrder)}
              </p>
              <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                {selectedOrder.items.map((item, index) => (
                  <div key={`${item.name}-${index}`} className="flex items-center gap-2.5 text-sm">
                    <div className="h-8 w-8 shrink-0 overflow-hidden rounded-[10px] bg-slate-100 shadow-inner">
                      <img src={resolveProductImage({ image: item.image, name: item.name })} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                    </div>
                    <span className="min-w-0 flex-1 truncate text-gray-600">{item.name}{item.variation ? ` (${item.variation})` : ''} &times; {item.quantity}</span>
                    <span className="shrink-0 font-black text-gray-900">Rs {item.price * item.quantity}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-[24px] bg-white/50 p-4 text-sm shadow-inner">
              <Row label="Subtotal" value={`Rs ${orderSubtotal}`} />
              <Row label="Tax" value={`Rs ${orderTax}`} />
              {discountAmount > 0 ? (
                <Row label={`Discount ${discountType === 'percent' ? `(${discountRawValue}%)` : ''}`} value={`-Rs ${discountAmount}`} />
              ) : null}
              <Row label="Bill Total" value={`Rs ${adjustedTotal}`} />
              <Row label="Previous Dues" value={`Rs ${customerDue}`} />
              <Row label="Collecting Now" value={`Rs ${paymentPreview.paid}`} strong />
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
              <button type="button" onClick={() => { setPaymentPreview(null); setShowPayment(true); }} className="glass-pill rounded-[20px] px-4 py-3 text-sm font-black text-gray-700 transition hover:bg-white/70">Back</button>
              <button type="button" onClick={() => void confirmCompletePayment()} className="rounded-[20px] border-[0.5px] border-white/50 bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] px-4 py-3 text-sm font-black text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-3px_8px_rgba(132,144,10,0.4)] transition hover:brightness-105">Confirm &amp; Complete</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {showCancel && selectedOrder ? <CancelOrderModal order={selectedOrder} onClose={() => setShowCancel(false)} onCancelled={handleOrderCancelled} /> : null}

      {showAddItems && selectedOrder ? <Modal title="Add Items To Order" onClose={() => setShowAddItems(false)} wide><AddItemsManager products={products} onSaveItems={addItems} onProductsChanged={refreshProducts} /></Modal> : null}
      {showTableEdit && selectedOrder ? (
        <TableChangeModal
          order={selectedOrder}
          tables={tables}
          familyTableNames={familyTableNames}
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

// Used to always ignore whatever was actually typed into customer.name/
// customer.phone for a DineIn order and show the table/waiter instead - on
// the assumption that a Dine-In order never has real customer details.
// That's true for a STAFF-placed Dine-In order (POSPage doesn't require a
// name/phone for Dine-In), but it's never true for a Dine-In order placed
// through the customer QR page (CustomerOrderPage.tsx always collects a
// real name + phone, for every order type including Dine-In - see its own
// canSubmit check) - those were silently hidden here even though the data
// was saved correctly server-side (see publicOrderController.createOrder's
// `customer: {name, phone, address}`, never conditioned on orderType).
// Now: show the real name/phone whenever one was actually provided, for
// every order type: the table (via TableTypeBadge) and waiter are still
// shown elsewhere for Dine-In (see the dedicated Waiter Box below), so
// nothing is lost for a walk-in table order that only ever had a waiter
// assigned.
function label(order: SavedOrder) {
  const name = order.customer?.name?.trim();
  if (name) return name;
  return order.orderType === 'DineIn' ? 'Dine-In Customer' : 'Walk-in Customer';
}
function phoneLabel(order: SavedOrder) {
  if (hasCustomerPhone(order)) return order.customer.phone;
  if (order.orderType === 'DineIn') return order.waiter ? `Waiter: ${order.waiter}` : 'Dine In';
  return 'No phone';
}
function prettyType(order: SavedOrder) { return order.orderType === 'DineIn' ? 'Dine In' : order.orderType === 'TakeAway' ? 'Take Away' : 'Delivery'; }
function age(createdAt: string) { const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000); return mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} hr ${mins % 60} min ago`; }
function orderNumber(order: SavedOrder) { return String(order.dailyOrderNumber ?? order.id.slice(-4)).padStart(3, '0'); }
function hasCustomerPhone(order: SavedOrder) { return Boolean(order.customer.phone && order.customer.phone !== '03000000000'); }
function formatOrderDateTime(createdAt: string) { return new Date(createdAt).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

function Banner({ tone, text }: { tone: 'success' | 'error' | 'info'; text: string }) { return <div className={`glass rounded-[28px] px-5 py-4 text-sm ${tone === 'success' ? 'text-emerald-700' : tone === 'error' ? 'text-rose-700' : 'text-sky-700'}`}>{text}</div>; }
function Surface({ text }: { text: string }) { return <div className="glass rounded-[32px] p-8 text-sm text-gray-500">{text}</div>; }
function StatCard({ label, value }: { label: string; value: string }) { return <div className="glass rounded-[28px] px-5 py-5"><p className="text-[11px] font-black uppercase tracking-[0.18em] text-gray-500">{label}</p><p className="mt-2 text-3xl font-black text-gray-900">{value}</p></div>; }
function Line({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="flex min-w-0 items-center gap-2.5 text-sm text-gray-600"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/60 text-gray-500 shadow-inner">{icon}</span><span className="truncate">{text}</span></div>; }

// A dine-in table is either a Family Table or a plain/Simple table (see
// Table model's `isFamily` + TableManagementSection.tsx) - this makes that
// category impossible to miss anywhere a table number shows up, e.g. table
// 7 vs table 11 can be two different categories and staff need to see
// which is which at a glance, not just the number. `isFamily` is
// `undefined` only if the table was deleted/renamed since this list last
// loaded - falls back to the neutral "Simple" look rather than rendering
// nothing.
function TableTypeBadge({ tableName, isFamily }: { tableName: string; isFamily: boolean | undefined }) {
  const familyMode = Boolean(isFamily);
  return (
    <span
      title={`Table ${tableName} - ${familyMode ? 'Family Table' : 'Simple Table'}`}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[7px] font-black uppercase tracking-wide shadow-inner ${familyMode ? 'bg-pink-100/80 text-pink-700' : 'bg-sky-100/80 text-sky-700'}`}
    >
      {familyMode ? <Heart size={8} fill="currentColor" /> : <Table2 size={8} />}
      {familyMode ? 'Family' : 'Simple'}
    </span>
  );
}
function Box({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-[20px] bg-white/50 px-4 py-3 shadow-inner"><p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-500">{label}</p><p className="mt-1 break-words text-sm font-bold text-gray-900">{value}</p></div>; }
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <div className={`flex items-center justify-between py-1.5 ${strong ? 'text-lg font-black text-gray-900' : 'text-sm text-gray-500'}`}><span>{label}</span><span>{value}</span></div>; }
function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) { return <div className="glass-overlay fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"><div className={`glass-strong flex w-full max-h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-4rem)] flex-col rounded-[32px] transition-all ${wide ? 'max-w-5xl' : 'max-w-xl'}`}><div className="flex shrink-0 items-center justify-between border-b border-white/40 p-6 sm:px-8 sm:py-6"><h2 className="text-2xl font-black text-gray-900">{title}</h2><button type="button" onClick={onClose} className="glass-pill rounded-full p-3 text-gray-500 transition hover:bg-white/70"><XCircle size={18} /></button></div><div className="overflow-y-auto p-6 sm:p-8">{children}</div></div></div>; }

const TRACKING_STEP_LABEL: Record<string, string> = {
  awaiting_confirmation: 'Waiting for confirmation',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  ready: 'Ready',
  cancelled: 'Cancelled',
};

// The staff-side half of the QR ordering feature (see
// orderController.exports.updateTrackingStatus and
// CustomerOrderPage.tsx's own tracking view on the customer's side) -
// only ever rendered for an order with source === "customer-qr" (a
// staff-placed order never has a trackingStatus that means anything).
// Buttons offer the next logical step(s) from wherever the order
// currently is, plus Decline/Cancel unless it's already cancelled.
function OnlineOrderControls({
  order,
  updating,
  onChange,
  riders,
  assigningRider,
  onAssignRider,
  respondingToChangeRequest,
  onRespondToChangeRequest,
}: {
  order: SavedOrder;
  updating: boolean;
  onChange: (order: SavedOrder, next: TrackingStatus) => void;
  riders: Rider[];
  assigningRider: boolean;
  onAssignRider: (order: SavedOrder, rider: Rider) => void;
  respondingToChangeRequest: boolean;
  onRespondToChangeRequest: (order: SavedOrder, action: 'approve' | 'reject') => void;
}) {
  const current = order.trackingStatus || 'awaiting_confirmation';
  const [selectedRiderId, setSelectedRiderId] = useState('');
  const changeRequest = order.customerChangeRequest;
  const hasPendingChangeRequest = changeRequest?.status === 'pending';

  if (current === 'cancelled') return null;

  const nextSteps: TrackingStatus[] =
    current === 'awaiting_confirmation' ? ['confirmed'] : current === 'confirmed' ? ['preparing'] : current === 'preparing' ? ['ready'] : [];

  // Rider assignment only makes sense for Delivery orders, and only once
  // staff has actually accepted the order (past awaiting_confirmation) -
  // per the user's own request: "after accepting the order add option to
  // assign rider to send him the location and order details of customer".
  const showRiderPicker = order.orderType === 'Delivery' && current !== 'awaiting_confirmation';

  return (
    <div className="rounded-[20px] border border-indigo-100 bg-indigo-50/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-indigo-400">Online Order</p>
          <p className="mt-1 text-sm font-black text-indigo-900">
            {TRACKING_STEP_LABEL[current] || current}
            {order.paymentStatus ? ` · Payment: ${order.paymentStatus.replace('_', ' ')}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {nextSteps.map((step) => (
            <button
              key={step}
              type="button"
              disabled={updating}
              onClick={() => onChange(order, step)}
              className="rounded-2xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Mark {TRACKING_STEP_LABEL[step]}
            </button>
          ))}
          <button
            type="button"
            disabled={updating}
            onClick={() => onChange(order, 'cancelled')}
            className="rounded-2xl bg-rose-100 px-4 py-2 text-xs font-black text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Decline
          </button>
        </div>
      </div>

      {showRiderPicker ? (
        <div className="mt-3 border-t border-indigo-100 pt-3">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-indigo-400">Delivery Rider</p>
          {order.assignedRider?.phone ? (
            <p className="mt-1 text-sm font-bold text-indigo-900">
              Assigned to {order.assignedRider.name || order.assignedRider.phone}
              {order.assignedRider.phone ? ` (${order.assignedRider.phone})` : ''}
            </p>
          ) : (
            <p className="mt-1 text-xs text-indigo-700">Not assigned yet.</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={selectedRiderId}
              onChange={(event) => setSelectedRiderId(event.target.value)}
              disabled={assigningRider || riders.length === 0}
              className="rounded-2xl border border-indigo-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">{riders.length === 0 ? 'No riders on staff' : 'Choose a rider…'}</option>
              {riders.map((rider) => (
                <option key={rider.id} value={rider.id}>
                  {rider.name}
                  {rider.phone ? ` - ${rider.phone}` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={assigningRider || !selectedRiderId}
              onClick={() => {
                const rider = riders.find((r) => r.id === selectedRiderId);
                if (rider) onAssignRider(order, rider);
              }}
              className="rounded-2xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {order.assignedRider?.phone ? 'Reassign & Notify' : 'Assign & Notify'}
            </button>
          </div>
        </div>
      ) : null}

      {hasPendingChangeRequest ? (
        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-amber-600">Customer Requested a Change</p>
          <ul className="mt-1.5 space-y-0.5 text-xs font-bold text-amber-900">
            {changeRequest!.addItems.map((item, index) => (
              <li key={`add-${index}`}>+ {item.quantity}x {item.name}{item.variation ? ` (${item.variation})` : ''} · Rs {item.price * item.quantity}</li>
            ))}
            {changeRequest!.removeItems.map((item, index) => (
              <li key={`remove-${index}`}>− {item.quantity}x {item.name}{item.variation ? ` (${item.variation})` : ''}</li>
            ))}
          </ul>
          {changeRequest!.note ? <p className="mt-1.5 text-xs italic text-amber-800">"{changeRequest!.note}"</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={respondingToChangeRequest}
              onClick={() => onRespondToChangeRequest(order, 'approve')}
              className="rounded-2xl bg-emerald-600 px-4 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={respondingToChangeRequest}
              onClick={() => onRespondToChangeRequest(order, 'reject')}
              className="rounded-2xl bg-rose-100 px-4 py-2 text-xs font-black text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
// Lets a cashier move a DineIn order to a different table (a customer
// asked to switch seats, or the table was mis-picked at placement) without
// going through the full Edit Order page - just a field patch, same as
// note/waiter (see saveUpdate's plain `{ table }` call, which
// applyOrderPatch/updateQueuedOrder already both support - see
// orderController.js/localOrders.js). Uses the same real Table model (with
// isFamily) as POSPage.tsx's own table grid, rather than the older
// Shop.tables/occupied-set system - table-timer locking already lives on
// the POS/Sales table grid elsewhere, so this is just a quick reassignment,
// not a second copy of that occupancy check.
function TableChangeModal({
  order,
  tables,
  familyTableNames,
  onClose,
  onSave,
}: {
  order: SavedOrder;
  tables: Table[];
  familyTableNames: Record<string, boolean>;
  onClose: () => void;
  onSave: (table: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState(order.table || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

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
        Currently {order.table ? <span className="font-bold text-gray-900">Table {order.table}</span> : 'no table set'}. Pick the new table below.
      </p>
      {tables.length === 0 ? <p className="mt-3 text-xs font-bold text-gray-400">No tables configured yet.</p> : null}
      <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-5">
        {tables.map((table) => {
          const isSelected = selected === table.name;
          return (
            <button
              key={table.id}
              type="button"
              onClick={() => setSelected(table.name)}
              className={`flex flex-col items-center gap-1 rounded-xl border py-2.5 text-sm font-black transition ${
                isSelected ? 'border-black bg-black text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'
              }`}
            >
              <span>{table.name}</span>
              <TableTypeBadge tableName={table.name} isFamily={familyTableNames[table.name]} />
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
