import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Edit3, Globe, Heart, Lock, MapPin, PackagePlus, Phone, Printer, RefreshCcw, Search, ShoppingBag, Star, Table2, UserRound, XCircle } from 'lucide-react';
import { ApiError, claimKitchenUpdatePrint, fetchCustomerOutstanding, fetchOrder, fetchOrders, fetchOrdersList, fetchProducts, fetchShopProfile, fetchShopSessionHistory, fetchWaiters, fetchRiders, assignOrderRider, isAuthenticated, updateOrder, sendWhatsappMessage, sendWhatsappDocument, updateOrderTrackingStatus, respondToOrderChangeRequest, type TrackingStatus, type Rider } from '@/lib/pos-api';
import { Discount, Product, SavedOrder, ShopSession, Waiter } from '@/lib/pos-types';
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
import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';
import { useNotifications } from '@/lib/notifications';
import AddItemsManager from '@/pages/dashboard/sales/components/AddItemsManager';
import CancelOrderModal from '@/components/CancelOrderModal';
import { resolveProductImage, resolveOrderImage } from '@/lib/food-images';
import { useLanguage } from '@/i18n';

// "Dine In" tab intentionally removed from this shop's filter row per
// owner request - this shop doesn't do dine-in orders. Any legacy DineIn
// order (or one placed before this was removed) still shows fine under
// "All"; the byFilter checks below simply have no dedicated pill for it
// anymore.
const BASE_FILTERS = ['All', 'Take Away', 'Delivery'];

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
  const { toast, popup, confirm } = useToast();
  const { notify } = useNotifications();
  const { t } = useLanguage();
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
  // Which status the order grid below is showing - the type/waiter pills
  // above (filter, above) narrow WHAT shows within that status, this
  // decides pending vs already-settled. Defaults to Pending, the workflow
  // this page has always centered on (open tabs/tables needing attention).
  const [statusTab, setStatusTab] = useState<'pending' | 'completed'>('pending');
  const [status, setStatus] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPayment, setShowPayment] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showAddItems, setShowAddItems] = useState(false);
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
  // Set true only inside selectOrder (an actual card click) and consumed
  // (reset false) the moment the scroll effect below runs - this is what
  // stops the very first order the page auto-selects on load/refresh (see
  // loadFromCache/refresh's setSelectedOrder(... ?? scoped[0] ...) fallback)
  // from also triggering an unwanted scroll-to-bottom before the person has
  // clicked anything.
  const userSelectedOrderRef = useRef(false);
  // Bumped on every selectOrder() call, even when the clicked card is the
  // same order that's already selected (e.g. the very first card, which
  // loadFromCache/refresh already auto-selected on page load - see
  // userSelectedOrderRef's own comment). The scroll effect below is keyed
  // on selectedOrder?.id/status, so clicking a card that doesn't change
  // either of those would otherwise skip the effect entirely and silently
  // eat the first click. Including this tick in the dependency array makes
  // "click this same order again" register as a real trigger too.
  const [selectionTick, setSelectionTick] = useState(0);
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
      const reason = diagnostics && !diagnostics.started ? ` (${diagnostics.error || t('sales.failedToStart')})` : '';
      setStatus({ tone: 'error', text: t('sales.localHubUnreachable', { reason }) });
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
    if (!isAuthenticated()) setStatus({ tone: 'info', text: t('sales.loginTokenMissing') });
    void load();
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
    // Only an actual card click (selectOrder) sets this - the page's own
    // auto-select-first-order-on-load never does, so opening/refreshing the
    // Sales screen no longer scrolls anywhere on its own.
    if (!userSelectedOrderRef.current) return;
    userSelectedOrderRef.current = false;
    const frame = requestAnimationFrame(() => {
      completeButtonsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    return () => cancelAnimationFrame(frame);
    // Deliberately NOT depending on the whole selectedOrder object - see
    // comment above. selectionTick IS included so re-clicking the same
    // already-selected card (id/status unchanged) still re-runs this -
    // see selectionTick's own comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrder?.id, selectedOrder?.status, selectionTick]);

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
    const haystack = `${order.id} ${order.dailyOrderNumber ?? ''} ${label(order, t)} ${phoneLabel(order, t)}`.toLowerCase();
    return byFilter && haystack.includes(search.toLowerCase());
  }), [filter, shiftOrders, search, t]);

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
    const haystack = `${order.id} ${order.dailyOrderNumber ?? ''} ${label(order, t)} ${phoneLabel(order, t)}`.toLowerCase();
    return byFilter && haystack.includes(search.toLowerCase());
  }), [filter, allPendingOrders, search, t]);

  // The Completed tab - unlike visibleOrders above, sourced from
  // filteredOrders (shift-scoped) rather than an unbounded fetch, so it
  // matches exactly what the "Completed" StatCard above already counts.
  // A shop's full completed history (beyond the current shift) is what
  // RecordPage.tsx's date range/export is for - this tab is the same
  // "today's shift" scope the rest of this page already uses.
  const completedOrders = useMemo(
    () => filteredOrders.filter((order) => order.status === 'completed'),
    [filteredOrders],
  );

  // Which list the grid below actually renders - toggled by statusTab, the
  // Pending/Completed pill pair above the type filters.
  const activeOrders = statusTab === 'pending' ? visibleOrders : completedOrders;

  // A new filter/search/tab re-derives the whole list, so a stale "load
  // more" position would otherwise leave the grid showing an arbitrary/
  // inconsistent slice - always restart at 10 when they change.
  useEffect(() => {
    setVisibleOrderCount(10);
  }, [filter, search, allPendingOrders, statusTab]);

  const pagedOrders = activeOrders.slice(0, visibleOrderCount);

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
  // Change-Return Calculation: Amount Paid is no longer clamped to payable
  // (see its input's own comment below) - it now represents the real cash
  // the customer physically handed over, which can be MORE than the bill.
  // changeReturn is what's owed back to them the moment that happens (e.g.
  // Bill 1600, Paid 2000 -> Return 400); 0 the rest of the time (nothing
  // typed yet, or a partial/exact amount with nothing extra tendered).
  const enteredPaymentAmount = paymentAmount === '' ? 0 : Number(paymentAmount);
  const changeReturn = Math.max(enteredPaymentAmount - payable, 0);

  // Electricity Bill / Cash orders (see POSPage.tsx's hasElectricityBillItem/
  // hasCashItem) are always paid in full, on the spot, at the counter -
  // there's no realistic "partial payment" case for either one. Pre-filling
  // Amount Paid with the full payable amount the moment the Complete
  // Payment modal opens for one saves the cashier from having to type/
  // calculate it themselves, while still requiring their own Confirm/Pay
  // Full click - this never completes an order on its own.
  const hasSpecialOrderItem = Boolean(selectedOrder?.items?.some((item) => item.specialType));
  useEffect(() => {
    if (showPayment && hasSpecialOrderItem && paymentAmount === '') {
      setPaymentAmount(String(payable));
    }
    // Only ever fires off the modal opening/the order changing - never
    // re-fires just because the cashier edits the field afterward (that
    // would fight their own typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPayment, selectedOrder?.id]);

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
      // BUG FIX: this used to be `setShopSession(latestSession)` unconditionally
      // - including `null` whenever `history` came back empty for any reason
      // (a transient blip, replica lag, or this shop's session simply not
      // having landed in ShopSession history yet). That silently wiped out an
      // already-known-good "shop is open" state a few seconds after the page
      // first painted it correctly from the cache (loadFromCache/
      // useShopSession), and getBusinessWindow/filterOrdersInBusinessWindow
      // treat "no session" as "match nothing" - so every shift-scoped number
      // on this page (Completed, Cancelled, the Completed tab's own list)
      // would flash to 0 the moment this 45-second poll's history fetch came
      // back empty, even though the shop was genuinely still open the whole
      // time. Only ever UPGRADE the persisted shopSession state here; never
      // downgrade it to "we don't know" just because one poll's history
      // array was empty - same "don't wipe good state over a transient
      // hiccup" reasoning as the recentData/isStale guards around setOrders
      // below. `latestSession` (used just below for THIS call's own scoping
      // math) still falls back to whatever this render already knew, so a
      // one-off empty history fetch doesn't wrongly scope this pass's data
      // to "no session" either.
      const latestSession = history && history.length > 0 ? history[0] : shopSession;
      if (history && history.length > 0) {
        setShopSession(history[0]);
      }

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
          toast.error(t('sales.orderNotInLocalCache'));
        }
      } catch {
        toast.error(t('sales.couldNotRefreshOffline'));
      }
      return;
    }
    try {
      const updated = await fetchOrder(id);
      setOrders((previous) => previous.map((order) => order.id === id ? updated : order));
      setSelectedOrder(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sales.couldNotRefreshOrder'));
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
    userSelectedOrderRef.current = true;
    setSelectionTick((tick) => tick + 1);
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

  // Instant Checkout: opens the same Complete Payment modal the "Complete
  // Order" button does, resetting the discount drafts the same way it
  // does - shared by both the search-bar Enter workflow and the
  // click-then-Enter card workflow below, so the two stay identical.
  function openInstantCheckout(order: SavedOrder) {
    selectOrder(order);
    if (order.status !== 'pending') return;
    setDiscountAmountInput('');
    setDiscountPercentInput('');
    setShowPayment(true);
  }

  // Instant Checkout on Enter (search bar): typing an order number and
  // hitting Enter fetches that exact pending order and opens the payment
  // popup immediately, no mouse needed. Prefers an exact order-number match
  // over the loose substring match `visibleOrders` already applies (via the
  // `search` state itself), so typing "7" jumps straight to Order #007
  // instead of whatever happened to match first.
  function handleOrderSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const trimmed = search.trim();
    if (!trimmed) return;
    const query = trimmed.replace(/^#/, '').toLowerCase();
    const exactMatch = visibleOrders.find(
      (order) => orderNumber(order).toLowerCase() === query.padStart(3, '0') || String(order.dailyOrderNumber ?? '').toLowerCase() === query,
    );
    const match = exactMatch ?? visibleOrders[0];
    if (!match) {
      toast.error(t('sales.noPendingOrderFound', { query: trimmed }));
      return;
    }
    setStatusTab('pending');
    openInstantCheckout(match);
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
            ? (isOnline ? t('sales.savedKitchenPrintedSyncing') : t('sales.savedKitchenPrintedOffline'))
            : isOnline ? t('sales.savedSyncingToCloud') : t('sales.savedWillSyncOffline'),
        });
        return updated;
      } catch (err) {
        setStatus({ tone: 'error', text: err instanceof Error ? err.message : t('sales.couldNotSaveChange') });
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
  // on-demand Print Receipt button below and completePayment's own
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
          t('sales.customerReceiptLabel'),
          toast,
        );
      } catch {
        setPrintReadyUrl(`/dashboard/sales/print/${order.id}?auto=true&type=cashier`);
      }
    } else {
      setPrintReadyUrl(`/dashboard/sales/print/${order.id}?auto=true&type=cashier`);
    }
  }

  // Finalizes a sale directly from the Complete Payment modal's own
  // Confirm Payment/Pay Full buttons - no intermediate "Confirm Order
  // Payment" preview step in between anymore (that second popup, and its
  // own Back/Confirm & Complete click, were removed so a valid payment
  // completes in one click). `paid` is the FULL amount actually collected
  // right now - this order's own bill plus whatever of the customer's
  // other outstanding dues (Previous Dues, above) gets collected alongside
  // it. The backend's completeAndSettle action pays down the customer's
  // older dues/pending orders first with it, oldest first, and only
  // applies what's left to this order - see orderController.updateOrder.
  async function completePayment(full: boolean) {
    if (!selectedOrder) return;
    // Change-Return Calculation: Amount Paid is the real cash tendered, not
    // capped at the bill any more (see the input's own comment) - `paid`
    // (what actually gets applied to this order + any other dues, sent to
    // the backend as paidAmount) is always clamped at payable regardless of
    // how much was typed; anything typed beyond that is change owed back,
    // never money applied toward a bill. "Pay Full" with nothing typed
    // still means "tendered exactly the payable amount" (0 change), same
    // as before this feature existed.
    const tendered = paymentAmount === '' ? (full ? payable : 0) : Number(paymentAmount);
    const paid = full ? payable : Math.max(0, Math.min(tendered, payable));
    const changeAmount = Math.max(tendered - payable, 0);
    if (!full && (paid < 0 || paid > payable)) {
      popup({ tone: 'error', title: t('sales.invalidPaymentAmountTitle'), message: t('sales.enterValidPaymentAmount') });
      return;
    }
    // Zero payment (empty field + "Put in Pending" ticked, or a literal
    // "0" typed in) is a distinct case from an ordinary partial payment -
    // it leaves the WHOLE bill as a due with nothing collected at all, so
    // it gets its own gates below: the tick itself, mandatory customer
    // details, and one more explicit Yes/No confirmation - see each check's
    // own comment. "Full Pay" is also disabled outright whenever this is
    // true (see the button's own disabled prop further down) since paying
    // in full makes no sense once the cashier's already indicated zero.
    const isZeroPayment = !full && paid === 0;
    // Nothing typed in Amount Paid is only allowed through with the
    // "Put in Pending" box explicitly ticked - a bare Confirm Payment
    // click with an empty field (a stray click, a misplaced tap) used to
    // silently complete the order with paid=0 and leave the whole bill as
    // an unpaid due with no confirmation at all. Typing any real amount
    // (partial or full via the field) never needs the tick.
    if (isZeroPayment && !confirmPending) {
      popup({ tone: 'error', title: t('sales.paymentAmountRequiredTitle'), message: t('sales.paymentAmountRequiredMessage') });
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
    // to leave anything unpaid. This applies just as strictly to a zero
    // payment (the largest possible due, since nothing at all was
    // collected) as to any smaller partial one - streamlining the payment
    // popups elsewhere never relaxes this particular check. A full payment
    // never leaves a due, so walk-ins can still check out with no customer
    // details exactly as before. A plain toast here (not the blocking OK/X
    // popup) - this is a routine, correctable validation nudge, not
    // something that needs a dedicated dialog the cashier has to dismiss
    // before continuing.
    if (paid < payable) {
      if (!hasCustomerPhone(selectedOrder) || !selectedOrder.customer.name?.trim()) {
        toast.error(
          isZeroPayment
            ? t('sales.zeroPaymentCustomerRequired')
            : t('sales.partialPaymentCustomerRequired'),
        );
        return;
      }
    }
    // One more explicit Yes/No check specifically for zero payment - the
    // "Put in Pending" tick alone is easy to leave checked from a previous
    // order or brush past without reading, and unlike a partial payment
    // (which still collects something), this collects nothing at all and
    // pushes the ENTIRE bill onto the customer's dues. Making the cashier
    // affirmatively confirm that here ensures it's intentional, not a slip.
    if (isZeroPayment) {
      const proceedWithZeroPayment = await confirm(
        t('sales.confirmZeroPaymentMessage', { orderNumber: orderNumber(selectedOrder), payable, customerName: selectedOrder.customer.name ?? '' }),
        { title: t('sales.confirmZeroPaymentTitle'), confirmText: t('common.confirm'), tone: 'danger' },
      );
      if (!proceedWithZeroPayment) return;
    }

    const updated = await saveUpdate({ status: 'completed', action: 'completeAndSettle', paidAmount: paid, cashReceived: tendered, discount: discountForOrder });
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
    setShowPayment(false);
    setPaymentAmount('');
    setConfirmPending(false);
    setDiscountAmountInput('');
    setDiscountPercentInput('');
    // No blocking pop-up here by design - the notification bar/bell (see
    // lib/notifications.tsx) is the sole confirmation surface for a
    // completed order now.
    notify(
      'order_completed',
      changeAmount > 0
        ? t('sales.orderCompletedChange', { orderNumber: orderNumber(updated), paid, change: changeAmount })
        : t('sales.orderCompletedNoChange', { orderNumber: orderNumber(updated), paid }),
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
      setStatus({ tone: 'error', text: t('sales.whatsappReceiptSendFailed') });
    }
  }

  function handleOrderCancelled(updated: SavedOrder) {
    localEditVersionRef.current += 1;
    setOrders((previous) => previous.map((order) => (order.id === updated.id ? updated : order)));
    setSelectedOrder(updated);
    setShowCancel(false);
    setStatus({ tone: 'success', text: t('sales.orderCancelledSuccessfully', { orderId: updated.dailyOrderNumber ?? updated.id }) });
  }

  const [updatingTrackingStatus, setUpdatingTrackingStatus] = useState(false);

  // Advances a customer-qr order's tracking lifecycle (see
  // orderController.exports.updateTrackingStatus) - this is the staff-side
  // half of the QR ordering feature: confirm it into the kitchen queue,
  // mark it preparing/ready, or decline it outright. Firing "confirmed" on
  // a Delivery order also triggers the WhatsApp rider notification
  // server-side - nothing extra to do here for that.
  async function handleTrackingStatusChange(order: SavedOrder, trackingStatus: TrackingStatus) {
    if (trackingStatus === 'cancelled' && !window.confirm(t('sales.declineOnlineOrderConfirm'))) return;
    setUpdatingTrackingStatus(true);
    try {
      const updated = await updateOrderTrackingStatus(order.id, trackingStatus);
      if (updated) {
        localEditVersionRef.current += 1;
        setOrders((previous) => previous.map((o) => (o.id === updated.id ? updated : o)));
        setSelectedOrder(updated);
        toast.success(t('sales.orderMarkedStatus', { orderId: updated.dailyOrderNumber ?? updated.id, status: trackingStepLabel(trackingStatus, t) }));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sales.couldNotUpdateOrder'));
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
            ? t('sales.assignedRiderNotified', { name: rider.name })
            : t('sales.assignedRiderNotNotified', { name: rider.name }),
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sales.couldNotAssignRider'));
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
        toast.success(action === 'approve' ? t('sales.changeRequestApproved') : t('sales.changeRequestDeclined'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sales.couldNotRespondToRequest'));
    } finally {
      setRespondingToChangeRequest(false);
    }
  }

  async function addItems(items: Array<{ name: string; price: number; quantity: number; variation: string; image?: string }>) {
    if (items.length === 0) return setStatus({ tone: 'error', text: t('sales.selectAtLeastOneItem') });
    const updated = await saveUpdate({ action: 'addItems', items });
    if (!updated) return;
    setShowAddItems(false);
    setStatus(
      isDesktopApp()
        ? { tone: 'success', text: isOnline ? t('sales.addedItemsSyncing', { count: items.length, orderId: updated.id }) : t('sales.addedItemsOffline', { count: items.length, orderId: updated.id }) }
        : { tone: 'success', text: t('sales.addedItemsPlain', { count: items.length, orderId: updated.id }) },
    );
  }

  async function handleSendWhatsAppReciept(order: SavedOrder) {
    if (isDesktopApp() && !isOnline) {
      return setStatus({ tone: 'error', text: t('sales.whatsappNeedsInternet') });
    }
    if (!order.customer.phone || order.customer.phone === '03000000000') {
      return setStatus({ tone: 'error', text: t('sales.noValidPhoneNumber') });
    }

    setIsSendingWA(true);
    try {
      const lines = [];
      lines.push(`*The Heaven Slice*`);
      lines.push(t('sales.whatsappOrderNo', { number: orderNumber(order) }));
      lines.push(t('sales.whatsappTotal', { total: order.total }));
      lines.push(`--------------------`);
      order.items.forEach((item) => {
        lines.push(`${item.quantity}x ${item.name} @ PKR ${item.price}`);
      });
      lines.push(`--------------------`);
      lines.push(t('sales.whatsappThankYou'));

      const message = lines.join('\n');
      const res = await sendWhatsappMessage(order.customer.phone, message);

      if (res?.success) {
        setStatus({ tone: 'success', text: t('sales.receiptSentWhatsApp', { phone: order.customer.phone }) });
      } else {
        setStatus({ tone: 'error', text: res?.error || t('sales.whatsappSendFailed') });
      }
    } catch (err) {
      setStatus({ tone: 'error', text: t('sales.whatsappSendFailedPrefix') + (err instanceof Error ? err.message : '') });
    } finally {
      setIsSendingWA(false);
    }
  }

  return (
    <div className="space-y-3 sm:space-y-6">
      {status ? <Banner tone={status.tone} text={status.text} /> : null}
      {/* 2-up on phone widths (a 4-up row left ~85px per card, which
          truncated every currency value down to "Rs 45,2..." - illegible),
          4-up from tablet width (sm, 640px) up where there's actually room. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label={t('sales.stats.pendingOrders')} value={String(visibleOrders.length)} />
        <StatCard label={t('sales.stats.completed')} value={String(filteredOrders.filter((order) => order.status === 'completed').length)} />
        <StatCard label={t('sales.stats.cancelled')} value={String(filteredOrders.filter((order) => order.status === 'cancelled').length)} />
        <StatCard label={t('sales.stats.openValue')} value={`Rs ${visibleOrders.reduce((sum, order) => sum + order.total, 0)}`} />
      </div>

      {/* Order detail sits to the right of the order list from tablet width
          (sm, 640px) up, matching the POS checkout panel. Below that (a
          real phone) a fixed 260px+ sidebar next to a usable order grid
          doesn't fit at all - it stacks to one column instead: order list
          on top, detail panel underneath. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-4 lg:min-h-[calc(100vh-14rem)] lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,26%)] lg:gap-6 lg:items-stretch">
        {/* @container: the order grid below must size its column count off
            THIS element's own pixel width, not the viewport's - the split
            two-pane layout above (order list + detail panel, 74%/26% at lg)
            means this section is routinely much narrower than the viewport,
            so a viewport-based md:/xl: breakpoint was jumping to 4 columns
            in a pane only wide enough to comfortably fit 3. */}
        <section className="min-w-0 space-y-5 lg:flex lg:min-h-0 lg:flex-col @container">
          <div className="glass rounded-[32px] p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-md">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 rtl:left-auto rtl:right-4" size={18} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={handleOrderSearchKeyDown} placeholder={t('sales.searchPlaceholder')} className="w-full rounded-full border border-white/60 bg-white/50 py-4 pl-12 pr-4 shadow-inner outline-none focus:border-[#D6E332] rtl:pl-4 rtl:pr-12" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <p className="max-w-xs text-xs font-bold text-gray-500">
                  {shopSession
                    ? (shopSession.status === 'open' ? t('sales.shiftContext.openShift') : t('sales.shiftContext.lastShift'))
                    : t('sales.shiftContext.noShiftRecorded')}
                </p>
                <button type="button" onClick={() => void loadAny()} className="glass-dark rounded-2xl px-4 py-3 text-sm font-black"><RefreshCcw size={16} className="mr-2 inline rtl:mr-0 rtl:ml-2" />{t('common.refresh')}</button>
              </div>
            </div>
            <div className="mt-4 flex gap-1.5 rounded-full bg-white/40 p-1.5 shadow-inner">
              <button
                type="button"
                onClick={() => setStatusTab('pending')}
                className={`flex-1 rounded-full px-4 py-2.5 text-sm font-black transition ${statusTab === 'pending' ? 'glass-dark' : 'text-gray-500 hover:bg-white/60'}`}
              >
                {t('sales.tabs.pending', { count: visibleOrders.length })}
              </button>
              <button
                type="button"
                onClick={() => setStatusTab('completed')}
                className={`flex-1 rounded-full px-4 py-2.5 text-sm font-black transition ${statusTab === 'completed' ? 'glass-dark' : 'text-gray-500 hover:bg-white/60'}`}
              >
                {t('sales.tabs.completed', { count: completedOrders.length })}
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {filters.map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`rounded-full px-4 py-2 text-sm font-bold transition ${filter === item ? 'glass-dark' : 'bg-white/50 text-gray-600 shadow-inner hover:bg-white/70'}`}>{filterDisplayLabel(item, t)}</button>)}
            </div>
          </div>

          {loading ? <Surface text={t('sales.loadingOrders')} /> : null}
          {!loading && activeOrders.length === 0 ? (
            <Surface text={statusTab === 'pending' ? t('sales.noPendingOrdersFiltered') : t('sales.noCompletedOrdersFiltered')} />
          ) : null}
          {!loading && activeOrders.length > 0 ? (
            // Grid: 1 column on a real phone (this pane is full-width there,
            // and even 2 narrow order cards side by side truncated every
            // currency value), 2 once the container has some breathing room,
            // then a flat 3 from @lg up and never higher - no step-up to
            // 4/5/6 at any wider container width (removed per requirement
            // that Sales always shows exactly 3 cards on desktop).
            <div className="grid grid-cols-1 gap-3 @xs:grid-cols-2 @lg:grid-cols-3 lg:min-h-0 lg:flex-1 lg:content-start lg:overflow-y-auto lg:pr-2">
              {pagedOrders.map((order) => {
                const isSelected = selectedOrder?.id === order.id;
                const heroImage = resolveOrderImage(order.items);
                return (
                <button
                  key={order.id}
                  type="button"
                  onClick={() => selectOrder(order)}
                  onKeyDown={(event) => {
                    // Click-then-Enter Instant Checkout: a mouse click
                    // already focuses this card (native button focus), so
                    // Enter right after - with no extra click - opens the
                    // payment popup for it, exactly like the search-bar
                    // Enter workflow above.
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    openInstantCheckout(order);
                  }}
                  className={`min-w-0 overflow-hidden rounded-[28px] border bg-gradient-to-br backdrop-blur-xl backdrop-saturate-150 text-left transition-all duration-200 ${
                    isSelected
                      ? '-translate-y-1 border-[#D6E332] from-[#FBFDEB]/80 to-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_10px_rgba(214,227,50,0.3)] ring-1 ring-[#E2F33C]/60'
                      : `${STATUS_BORDER[order.status] ?? 'border-gray-200'} ${STATUS_CARD_BG[order.status] ?? 'from-white/60 to-white/25'} shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_10px_rgba(15,23,42,0.14)] hover:-translate-y-1.5 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-5px_12px_rgba(15,23,42,0.2)]`
                  }`}
                >
                  {/* Fixed pixel height (not aspect-ratio) and shrink-0 -
                      this card is a CSS grid item, stretched by the grid's
                      default align-items:stretch to match the tallest card
                      in its row (see the grid wrapper below). An
                      aspect-ratio box can still get squeezed shorter than
                      its own ratio once the row's height is being driven by
                      a taller sibling's extra text content (more Line rows,
                      table/rating badges, etc. below) - a hard height never
                      shrinks with it, so every card's image stays the same
                      size no matter how much detail the card underneath it
                      has. */}
                  <div className="relative h-40 w-full shrink-0 overflow-hidden bg-slate-100">
                    <img src={heroImage} alt={order.items[0]?.name ?? t('sales.orderImageAlt')} loading="lazy" className="h-full w-full object-cover" />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-black/0 to-transparent" />
                    <span className={`absolute right-2 top-2 rounded-full px-3 py-1 text-[11px] font-black uppercase shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-1px_3px_rgba(0,0,0,0.12)] rtl:right-auto rtl:left-2 ${STATUS_BADGE[order.status] ?? 'bg-gray-100 text-gray-600'}`}>{orderStatusLabel(order.status, t)}</span>
                    <span className="absolute bottom-2 left-2 min-w-0 max-w-[85%] truncate rounded-full bg-white/90 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-700 shadow-sm backdrop-blur-sm rtl:left-auto rtl:right-2">
                      {age(order.createdAt, t)} &middot; {formatOrderDateTime(order.createdAt)}
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
                          {order.trackingStatus === 'awaiting_confirmation' ? t('sales.onlineWaitingAcceptance') : t('sales.onlineStatusPrefix', { status: trackingStepLabel(order.trackingStatus, t) })}
                        </span>
                      </div>
                    ) : null}
                    {order.source === 'customer-qr' && order.customerChangeRequest?.status === 'pending' ? (
                      <div className="mb-2 flex animate-pulse items-center gap-1 rounded-lg bg-amber-500 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-white">
                        <Edit3 size={10} className="shrink-0" />
                        <span className="truncate">{t('sales.changeRequestedBadge')}</span>
                      </div>
                    ) : null}
                    <h3 className="truncate text-lg font-black text-gray-900">{t('sales.orderNumberHeading', { number: orderNumber(order) })}</h3>
                    <div className="mt-3 space-y-2 text-sm text-gray-600">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="min-w-0 shrink-0"><Line icon={<UserRound size={15} />} text={label(order, t)} /></div>
                        {order.orderType === 'DineIn' && order.table ? (
                          <>
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100/80 px-2 py-0.5 text-[10px] font-black text-slate-700 shadow-inner">
                              <Table2 size={10} /> {t('sales.tableLabel', { table: order.table })}
                            </span>
                            <TableTypeBadge tableName={order.table} isFamily={undefined} />
                          </>
                        ) : null}
                      </div>
                      <Line icon={<Phone size={15} />} text={phoneLabel(order, t)} />
                      <Line icon={<ShoppingBag size={15} />} text={t('sales.orderTypeItemsCount', { type: prettyType(order, t), count: order.itemCount ?? order.items.length })} />
                    </div>
                    <div className={`mt-4 flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-black ${STATUS_TOTAL_PILL[order.status] ?? 'glass-dark'}`}>
                      <span className="text-[10px] font-bold uppercase tracking-widest text-white/75">{t('common.total')}</span>
                      <span className="text-white/40">|</span>
                      <span className="truncate">Rs {order.total}</span>
                    </div>
                  </div>
                </button>
                );
              })}
            </div>
          ) : null}
          {!loading && activeOrders.length > pagedOrders.length ? (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => setVisibleOrderCount((previous) => previous + 10)}
                className="rounded-full bg-white px-6 py-2.5 text-xs font-black text-gray-700 shadow-sm transition hover:bg-gray-50"
              >
                {t('sales.loadMore', { count: activeOrders.length - pagedOrders.length })}
              </button>
            </div>
          ) : null}
        </section>

        <aside className="glass min-w-0 rounded-[32px] lg:self-start">
          {selectedOrder ? (
            <div className="flex flex-col">
              <div className="shrink-0 border-b border-white/40 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div><p className="text-xs font-black uppercase tracking-[0.18em] text-gray-500">{t('sales.orderDetailLabel')}</p><h2 className="mt-2 text-2xl font-black text-gray-900">{t('sales.orderNumberHeading', { number: orderNumber(selectedOrder) })}</h2><p className="mt-2 text-sm text-gray-500">{formatOrderDateTime(selectedOrder.createdAt)}</p>
                    {/* isSelectedOrderHydrated is false only right after
                        picking a card whose data came from the lean
                        list=true endpoint - a background refreshOne is
                        already in flight (see selectOrder) and this
                        clears itself the moment it lands, same fetch a
                        manual tap of the refresh icon below would do. */}
                    {!isSelectedOrderHydrated ? <p className="mt-1 text-xs font-bold text-amber-600">{t('sales.loadingFullOrderDetails')}</p> : null}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {selectedOrder.customer.phone && selectedOrder.customer.phone !== '03000000000' && (
                      <button disabled={isSendingWA || !isSelectedOrderHydrated} type="button" onClick={() => void handleSendWhatsAppReciept(selectedOrder)} className="rounded-2xl bg-gradient-to-b from-emerald-400 to-emerald-600 px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] disabled:opacity-50">
                        {isSendingWA ? t('sales.sendingEllipsis') : 'WhatsApp'}
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
                    }} className="glass-dark rounded-2xl px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] disabled:opacity-50">{t('sales.sendToKitchen')}</button>
                    <button disabled={!isSelectedOrderHydrated} type="button" onClick={() => printCustomerReceipt(selectedOrder)} className="glass-pill rounded-2xl px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-gray-700 disabled:opacity-50">{t('sales.printReceipt')}</button>
                    <Link to={`/dashboard/sales/print/${selectedOrder.id}`} className="glass-pill rounded-2xl p-2.5 text-gray-500"><Printer size={16} /></Link>
                    <button type="button" onClick={() => void refreshOne(selectedOrder.id)} className="glass-pill rounded-2xl p-2.5 text-gray-500"><RefreshCcw size={16} /></button>
                    {selectedOrder.status === 'pending' ? (
                      <Link to={`/dashboard/sales/${selectedOrder.id}/edit`} className="glass-pill rounded-2xl px-3 py-2.5 text-xs font-black text-gray-600">{t('common.edit')}</Link>
                    ) : (
                      <span className="glass-pill cursor-not-allowed rounded-2xl px-3 py-2.5 text-xs font-black text-gray-400">{t('sales.editLocked')}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-5 p-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Box label={t('sales.boxLabels.orderNumber')} value={`#${orderNumber(selectedOrder)}`} />
                  <Box label={t('sales.boxLabels.createdAt')} value={formatOrderDateTime(selectedOrder.createdAt)} />
                  <Box label={t('sales.boxLabels.customer')} value={label(selectedOrder, t)} />
                  {/* Shows the real "Waiter" label only when there's no real
                      customer phone to show instead (see phoneLabel's own
                      comment) - a Dine-In order placed through the customer
                      QR page always has a real phone and no waiter, a
                      staff-placed Dine-In order usually has the reverse. */}
                  <Box label={selectedOrder.orderType === 'DineIn' && !hasCustomerPhone(selectedOrder) ? t('sales.boxLabels.waiter') : t('common.phone')} value={phoneLabel(selectedOrder, t)} />
                  {/* Dedicated Waiter box - only shown when there IS a real
                      phone number above (so the waiter box above didn't
                      already cover it) and a waiter is actually assigned,
                      e.g. a Dine-In order a customer placed via QR that
                      staff then assigned a waiter to after the fact. */}
                  {selectedOrder.orderType === 'DineIn' && hasCustomerPhone(selectedOrder) && selectedOrder.waiter ? (
                    <Box label={t('sales.boxLabels.waiter')} value={selectedOrder.waiter} />
                  ) : null}
                  {/* Read-only historical display only - Dining Tables (and
                      the ability to reassign one on an existing order) has
                      been removed, so this box is never clickable anymore.
                      Still shown for any pre-existing DineIn order so its
                      table renders correctly. */}
                  {selectedOrder.orderType === 'DineIn' ? (
                    selectedOrder.table ? (
                      <div className="col-span-2 min-w-0 rounded-[20px] bg-white/50 px-4 py-3 shadow-inner">
                        <p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-500">{t('sales.boxLabels.table')}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="whitespace-nowrap text-sm font-black text-gray-900">{t('sales.tableLabel', { table: selectedOrder.table })}</span>
                          <TableTypeBadge tableName={selectedOrder.table} isFamily={undefined} />
                        </div>
                      </div>
                    ) : (
                      <Box label={t('sales.boxLabels.table')} value={t('sales.notApplicable')} />
                    )
                  ) : null}
                  <Box label={t('sales.boxLabels.orderType')} value={prettyType(selectedOrder, t)} />
                  <Box label={t('common.address')} value={selectedOrder.address || t('sales.notApplicable')} />
                  <Box label={t('sales.boxLabels.paymentMethod')} value={selectedOrder.paymentMethod} />
                  {selectedOrder.orderType === 'Delivery' ? (
                    selectedOrder.deliveryLocation?.lat != null && selectedOrder.deliveryLocation?.lng != null ? (
                      <a
                        href={`https://maps.google.com/?q=${selectedOrder.deliveryLocation.lat},${selectedOrder.deliveryLocation.lng}`}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 rounded-[20px] bg-[#F8F9FB] px-4 py-3 transition hover:bg-gray-100"
                      >
                        <p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">{t('sales.boxLabels.deliveryLocation')}</p>
                        <p className="mt-1 flex items-center gap-1.5 text-sm font-bold text-indigo-600">
                          <MapPin size={12} className="shrink-0" /> {t('sales.openInMaps')}
                        </p>
                      </a>
                    ) : (
                      <Box label={t('sales.boxLabels.deliveryLocation')} value={t('sales.notShared')} />
                    )
                  ) : null}
                  <Box label={t('sales.boxLabels.previousDues')} value={`Rs ${customerDue}`} />
                  <Box label={t('sales.boxLabels.remaining')} value={`Rs ${selectedOrder.remainingAmount ?? 0}`} />
                  {selectedOrder.note ? <Box label={t('sales.boxLabels.note')} value={selectedOrder.note} /> : null}
                  {/* Electricity Bill / Cash special-product details - only
                      ever set on an order whose cart had the matching
                      special item in it (see POSPage.tsx's
                      hasElectricityBillItem/hasCashItem). */}
                  {selectedOrder.billTid ? <Box label={t('sales.boxLabels.billTid')} value={selectedOrder.billTid} /> : null}
                  {selectedOrder.billName ? <Box label={t('sales.boxLabels.billName')} value={selectedOrder.billName} /> : null}
                  {selectedOrder.cashRecipientName ? <Box label={t('sales.boxLabels.cashRecipientName')} value={selectedOrder.cashRecipientName} /> : null}
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
                    <h3 className="text-sm font-black uppercase tracking-[0.18em] text-gray-500">{t('sales.items')}</h3>
                    {selectedOrder.status === 'pending' ? (
                      <button disabled={!isSelectedOrderHydrated} type="button" onClick={() => setShowAddItems(true)} className="glass-dark rounded-full px-4 py-2 text-xs font-black disabled:cursor-not-allowed disabled:opacity-50"><PackagePlus size={14} className="mr-2 inline rtl:mr-0 rtl:ml-2" />{t('sales.addItems')}</button>
                    ) : (
                      <span className="glass-pill rounded-full px-4 py-2 text-xs font-black text-gray-500">{t('sales.orderLocked')}</span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {!isSelectedOrderHydrated ? (
                      <p className="text-sm text-gray-400">{t('sales.loadingItems')}</p>
                    ) : (
                      selectedOrder.items.map((item, index) => (
                        <div key={`${item.name}-${index}`} className="flex items-center gap-3 rounded-[24px] bg-white/45 p-3 shadow-inner">
                          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[16px] bg-slate-100 shadow-inner">
                            <img src={resolveProductImage({ image: item.image, name: item.name })} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                          </div>
                          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <div className="min-w-0"><p className="truncate font-black text-gray-900">{item.name}</p><p className="text-xs text-gray-500">{item.variation}</p></div>
                            <div className="shrink-0 text-right"><p className="text-sm font-black text-gray-900">Rs {item.price * item.quantity}</p><p className="text-xs text-gray-500">{t('sales.qty', { quantity: item.quantity })}</p></div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="shrink-0 space-y-4 rounded-b-[32px] border-t border-white/40 bg-white/30 p-6">
                <div className="rounded-[24px] bg-white/50 p-4 shadow-inner">
                  <Row label={t('sales.billSummary.subtotal')} value={`Rs ${orderSubtotal}`} />
                  <Row label={t('sales.billSummary.tax')} value={`Rs ${orderTax}`} />
                  {/* While still pending, this reflects the discount the
                      cashier has typed into the card above but hasn't
                      confirmed yet - a live preview, same figures the
                      Complete Payment modal itself will use. Once the order
                      is actually completed, `discountAmountInput`/
                      `discountPercentInput` are reset (see
                      completePayment), so from that point on this
                      reads the real, persisted selectedOrder.discount
                      instead - both branches now always spell out
                      value-vs-percentage explicitly rather than leaving a
                      blank suffix for a flat-value discount. */}
                  {selectedOrder.status === 'pending' ? (
                    discountAmount > 0 ? (
                      <Row label={discountType === 'percent' ? t('sales.billSummary.discountPercent', { value: discountRawValue }) : t('sales.billSummary.discountFixed')} value={`-Rs ${discountAmount}`} />
                    ) : null
                  ) : selectedOrder.discount && selectedOrder.discount.amount > 0 ? (
                    <Row label={selectedOrder.discount.type === 'percent' ? t('sales.billSummary.discountPercent', { value: selectedOrder.discount.value }) : t('sales.billSummary.discountFixed')} value={`-Rs ${selectedOrder.discount.amount}`} />
                  ) : null}
                  <Row label={t('sales.billSummary.billTotal')} value={`Rs ${selectedOrder.status === 'pending' ? adjustedTotal : selectedOrder.total}`} />
                  <Row label={t('sales.boxLabels.previousDues')} value={`Rs ${customerDue}`} />
                  <Row label={t('sales.billSummary.paid')} value={`Rs ${selectedOrder.paidAmount ?? 0}`} />
                  <Row label={t('sales.billSummary.grandTotal')} value={`Rs ${(selectedOrder.status === 'pending' ? adjustedTotal : selectedOrder.total) + customerDue}`} strong />
                </div>
                {selectedOrder.status === 'pending' ? (
                  <div ref={completeButtonsRef} className="grid gap-2.5">
                    <button
                      disabled={!isSelectedOrderHydrated}
                      type="button"
                      onClick={() => { setDiscountAmountInput(''); setDiscountPercentInput(''); setShowPayment(true); }}
                      className="flex items-center justify-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-emerald-400 to-emerald-600 px-5 py-4 text-lg font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.5),inset_0_-4px_10px_rgba(6,95,70,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <CheckCircle2 size={20} /> {t('sales.completeOrder')}
                    </button>
                    {hasPermission('sales.delete') ? (
                      <button
                        disabled={!isSelectedOrderHydrated}
                        type="button"
                        onClick={() => setShowCancel(true)}
                        className="flex items-center justify-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-rose-500 to-rose-700 px-5 py-4 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-4px_10px_rgba(136,19,55,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Lock size={16} /> {t('sales.cancelOrder')}
                      </button>
                    ) : null}
                  </div>
                ) : selectedOrder.status === 'cancelled' ? (
                  <div className="space-y-1.5 rounded-[24px] bg-rose-50/60 px-4 py-4 text-sm font-bold text-rose-700 shadow-inner">
                    <p>{t('sales.orderCancelledKept')}</p>
                    {selectedOrder.cancelledBy ? <p className="text-xs font-semibold text-rose-500">{t('sales.cancelledBy', { name: selectedOrder.cancelledBy })}{selectedOrder.cancelledAt ? ` · ${formatOrderDateTime(selectedOrder.cancelledAt)}` : ''}</p> : null}
                    {selectedOrder.cancelReason ? <p className="text-xs font-semibold text-rose-500">{t('sales.reasonLabel', { reason: selectedOrder.cancelReason })}</p> : null}
                  </div>
                ) : <div className="rounded-[24px] bg-emerald-50/60 px-4 py-4 text-sm font-bold text-emerald-700 shadow-inner">{t('sales.orderCompletedStored')}</div>}
              </div>
            </div>
          ) : <div className="flex min-h-[680px] flex-col items-center justify-center gap-4 p-6 text-center text-gray-400 lg:min-h-0 lg:h-full"><ShoppingBag size={56} strokeWidth={1.4} /><div><p className="font-bold text-gray-500">{t('sales.selectOrderTitle')}</p><p className="text-sm">{t('sales.selectOrderHint')}</p></div></div>}
        </aside>
      </div>

      {showPayment && selectedOrder ? (
        <Modal title={t('sales.completePaymentTitle')} onClose={() => { setShowPayment(false); setConfirmPending(false); }}>
          <div
            className="space-y-4"
            onKeyDown={(event) => {
              // Instant Checkout: Enter anywhere in this popup (typically
              // right after typing the cash amount) submits it as "Pay
              // Full" - the same button click, just without reaching for
              // the mouse. Respects the exact same disabled condition Pay
              // Full's own button already uses, so a partial/zero amount
              // still can't be silently overridden into a full payment.
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if ((Boolean(paymentAmount) && Number(paymentAmount) < payable) || confirmPending) return;
              void completePayment(true);
            }}
          >
            {/* Discount is set on the order-details card itself now, before
                Complete Order is even clicked (see that button's own
                comment) - this modal just reviews the figures it already
                produces, read-only. */}
            <div className="rounded-[24px] bg-white/50 p-4 text-sm shadow-inner">
              <Row label={t('sales.billSummary.subtotal')} value={`Rs ${orderSubtotal}`} />
              <Row label={t('sales.billSummary.tax')} value={`Rs ${orderTax}`} />
              {discountAmount > 0 ? (
                <Row label={discountType === 'percent' ? t('sales.billSummary.discountPercent', { value: discountRawValue }) : t('sales.billSummary.discountFixed')} value={`-Rs ${discountAmount}`} />
              ) : null}
              <Row label={t('sales.billSummary.billTotal')} value={`Rs ${adjustedTotal}`} />
              <Row label={t('sales.boxLabels.previousDues')} value={`Rs ${customerDue}`} />
              <Row label={t('sales.billSummary.finalPayable')} value={`Rs ${payable}`} strong />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-gray-700">{t('sales.amountPaidLabel')}</label>
              <input
                value={paymentAmount}
                onChange={(event) => {
                  if (!/^\d*$/.test(event.target.value)) return;
                  // Change-Return Calculation: no longer clamped to the
                  // Final Payable figure - a cashier types the REAL cash
                  // the customer handed over here (e.g. Bill 1600, hands
                  // over a 2000 note), which can be more than the bill.
                  // completePayment below still only ever applies up to
                  // `payable` toward the order itself; anything typed
                  // beyond that becomes the Change Return shown below and
                  // printed on the receipt (see ThermalReceipt.tsx).
                  const digitsOnly = event.target.value;
                  setPaymentAmount(digitsOnly);
                  // Typing a real amount supersedes the tick below - only
                  // relevant while it's still empty.
                  if (digitsOnly) setConfirmPending(false);
                }}
                className="w-full rounded-2xl border border-white/60 bg-white/50 px-4 py-3 shadow-inner outline-none"
                placeholder={t('sales.billPlaceholder', { payable })}
              />
            </div>
            {/* Change-Return Calculation: dynamically computed the moment
                the typed amount exceeds the Final Payable figure - large,
                clear font so it reads at a glance across the counter, same
                as a supermarket/fast-food till display. */}
            {changeReturn > 0 ? (
              <div className="rounded-[24px] bg-emerald-50 px-4 py-4 text-center shadow-inner">
                <p className="text-xs font-black uppercase tracking-wide text-emerald-600">{t('sales.changeReturnLabel')}</p>
                <p className="mt-1 text-4xl font-black text-emerald-700">Rs {changeReturn}</p>
              </div>
            ) : null}
            {!paymentAmount ? (
              <label className="flex cursor-pointer items-start gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-xs font-bold text-amber-800">
                <input
                  type="checkbox"
                  checked={confirmPending}
                  onChange={(event) => setConfirmPending(event.target.checked)}
                  className="mt-0.5"
                />
                {t('sales.putInPending', { payable })}
              </label>
            ) : null}
            <div ref={paymentButtonsRef} className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => void completePayment(false)} className="glass-dark rounded-[20px] px-4 py-3 text-sm font-black transition hover:brightness-110">{t('sales.confirmPaymentButton')}</button>
              <button
                type="button"
                onClick={() => void completePayment(true)}
                // Once the cashier has typed a partial amount into Amount
                // Paid (anything less than the Final Payable figure,
                // including a literal "0"), "Pay Full" no longer makes
                // sense as a shortcut - disable it so they can't
                // accidentally override their own partial/zero entry with
                // a full payment in one click. Also disabled the moment
                // "Put in Pending" is ticked (the empty-field zero-payment
                // path) for the same reason. Re-enables the moment the
                // field is cleared (and the tick with it) or filled up to
                // the full amount.
                disabled={(Boolean(paymentAmount) && Number(paymentAmount) < payable) || confirmPending}
                className="rounded-[20px] border-[0.5px] border-white/50 bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] px-4 py-3 text-sm font-black text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-3px_8px_rgba(132,144,10,0.4)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('sales.payFull')}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {showCancel && selectedOrder ? <CancelOrderModal order={selectedOrder} onClose={() => setShowCancel(false)} onCancelled={handleOrderCancelled} /> : null}

      {showAddItems && selectedOrder ? <Modal title={t('sales.addItemsToOrderTitle')} onClose={() => setShowAddItems(false)} wide><AddItemsManager products={products} onSaveItems={addItems} onProductsChanged={refreshProducts} /></Modal> : null}
      {printReadyUrl ? <iframe src={printReadyUrl} className="hidden" title={t('sales.autoPrintFrameTitle')} /> : null}
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
// Shared shape of the `t()` translator handed down from useLanguage() -
// every module-scope helper below that renders its own user-facing text
// takes it as a parameter (rather than calling useLanguage() itself, which
// only works inside a component) since every call site already has it in
// scope from the SalesPage component closure.
type Translate = (key: string, vars?: Record<string, string | number>) => string;

function label(order: SavedOrder, t: Translate) {
  const name = order.customer?.name?.trim();
  if (name) return name;
  return order.orderType === 'DineIn' ? t('sales.customer.dineInCustomer') : t('sales.customer.walkInCustomer');
}
function phoneLabel(order: SavedOrder, t: Translate) {
  if (hasCustomerPhone(order)) return order.customer.phone;
  if (order.orderType === 'DineIn') return order.waiter ? t('sales.customer.waiterPrefix', { name: order.waiter }) : t('sales.filters.dineIn');
  return t('sales.customer.noPhone');
}
function prettyType(order: SavedOrder, t: Translate) { return order.orderType === 'DineIn' ? t('sales.filters.dineIn') : order.orderType === 'TakeAway' ? t('sales.filters.takeAway') : t('sales.filters.delivery'); }
// BASE_FILTERS/order.waiter identifiers themselves are never translated
// (see BASE_FILTERS' own comment) - this only maps a filter pill's
// identifier to its on-screen label; a waiter's name passes through as-is.
function filterDisplayLabel(item: string, t: Translate) {
  if (item === 'All') return t('common.all');
  if (item === 'Dine In') return t('sales.filters.dineIn');
  if (item === 'Take Away') return t('sales.filters.takeAway');
  if (item === 'Delivery') return t('sales.filters.delivery');
  return item;
}
// order.status is one of the fixed pending/completed/paid/cancelled
// literals the backend/state machine uses (see STATUS_BADGE etc. above) -
// this only translates how it's displayed on the card badge, never the
// value itself.
function orderStatusLabel(status: string, t: Translate) {
  const map: Record<string, string> = {
    pending: t('sales.orderStatus.pending'),
    completed: t('sales.orderStatus.completed'),
    paid: t('sales.orderStatus.paid'),
    cancelled: t('sales.orderStatus.cancelled'),
  };
  return map[status] ?? status;
}
// Dynamic Days-Based Order Duration Format: past 24 hours (1440 minutes),
// switch from a growing "hr min" figure (which got unreadable past a day -
// "26 hr 12 min ago", "72 hr 0 min ago") to whole Days - "1 Day ago",
// "3 Days ago" - since once an order's been sitting that long, the exact
// minute no longer matters, only roughly how many days it's been.
function age(createdAt: string, t: Translate) {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
  if (mins < 60) return t('sales.minAgo', { mins });
  if (mins < 1440) return t('sales.hrMinAgo', { hr: Math.floor(mins / 60), min: mins % 60 });
  const days = Math.floor(mins / 1440);
  return days === 1 ? t('sales.dayAgo', { days }) : t('sales.daysAgo', { days });
}
function orderNumber(order: SavedOrder) { return String(order.dailyOrderNumber ?? order.id.slice(-4)).padStart(3, '0'); }
function hasCustomerPhone(order: SavedOrder) { return Boolean(order.customer.phone && order.customer.phone !== '03000000000'); }
function formatOrderDateTime(createdAt: string) { return new Date(createdAt).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

function Banner({ tone, text }: { tone: 'success' | 'error' | 'info'; text: string }) { return <div className={`glass rounded-[28px] px-5 py-4 text-sm ${tone === 'success' ? 'text-emerald-700' : tone === 'error' ? 'text-rose-700' : 'text-sky-700'}`}>{text}</div>; }
function Surface({ text }: { text: string }) { return <div className="glass rounded-[32px] p-8 text-sm text-gray-500">{text}</div>; }
// Was px-5 py-5 with a text-3xl value - a comfortable size on a tall
// desktop window, but on a short one (a small/half window, or a resized
// browser with DevTools eating vertical space) these 4 cards alone could
// push the actual order list below the fold before it even started.
// Noticeably more compact now - still perfectly readable, just not eating
// a third of a short viewport for 4 numbers.
function StatCard({ label, value }: { label: string; value: string }) { return <div className="glass rounded-2xl px-4 py-3"><p className="text-[10px] font-black uppercase tracking-[0.15em] text-gray-500">{label}</p><p className="mt-0.5 text-xl font-black text-gray-900">{value}</p></div>; }
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
  const { t } = useLanguage();
  const familyMode = Boolean(isFamily);
  return (
    <span
      title={t('sales.tableTypeTitle', { table: tableName, type: familyMode ? t('sales.familyTable') : t('sales.simpleTable') })}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[7px] font-black uppercase tracking-wide shadow-inner ${familyMode ? 'bg-pink-100/80 text-pink-700' : 'bg-sky-100/80 text-sky-700'}`}
    >
      {familyMode ? <Heart size={8} fill="currentColor" /> : <Star size={8} fill="currentColor" />}
      {familyMode ? 'F' : 'S'}
    </span>
  );
}
function Box({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-[20px] bg-white/50 px-4 py-3 shadow-inner"><p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-500">{label}</p><p className="mt-1 break-words text-sm font-bold text-gray-900">{value}</p></div>; }
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <div className={`flex items-center justify-between py-1.5 ${strong ? 'text-lg font-black text-gray-900' : 'text-sm text-gray-500'}`}><span>{label}</span><span>{value}</span></div>; }
function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);
  return <div className="glass-overlay fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"><div className={`glass-strong flex w-full max-h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-4rem)] flex-col rounded-[32px] transition-all ${wide ? 'max-w-5xl' : 'max-w-xl'}`}><div className="flex shrink-0 items-center justify-between border-b border-white/40 p-6 sm:px-8 sm:py-6"><h2 className="text-2xl font-black text-gray-900">{title}</h2><button type="button" onClick={onClose} className="glass-pill rounded-full p-3 text-gray-500 transition hover:bg-white/70"><XCircle size={18} /></button></div><div className="overflow-y-auto p-6 sm:p-8">{children}</div></div></div>;
}

function trackingStepLabel(status: string, t: Translate) {
  const map: Record<string, string> = {
    awaiting_confirmation: t('sales.tracking.awaitingConfirmation'),
    confirmed: t('sales.tracking.confirmed'),
    preparing: t('sales.tracking.preparing'),
    ready: t('sales.tracking.ready'),
    cancelled: t('sales.tracking.cancelled'),
  };
  return map[status] ?? status;
}

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
  const { t } = useLanguage();
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
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-indigo-400">{t('sales.online.orderLabel')}</p>
          <p className="mt-1 text-sm font-black text-indigo-900">
            {trackingStepLabel(current, t)}
            {order.paymentStatus ? ` · ${t('sales.online.paymentStatusLabel', { status: order.paymentStatus.replace('_', ' ') })}` : ''}
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
              {t('sales.online.markStatus', { status: trackingStepLabel(step, t) })}
            </button>
          ))}
          <button
            type="button"
            disabled={updating}
            onClick={() => onChange(order, 'cancelled')}
            className="rounded-2xl bg-rose-100 px-4 py-2 text-xs font-black text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('sales.online.decline')}
          </button>
        </div>
      </div>

      {showRiderPicker ? (
        <div className="mt-3 border-t border-indigo-100 pt-3">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-indigo-400">{t('sales.online.deliveryRider')}</p>
          {order.assignedRider?.phone ? (
            <p className="mt-1 text-sm font-bold text-indigo-900">
              {t('sales.online.assignedTo', { name: order.assignedRider.name || order.assignedRider.phone })}
              {order.assignedRider.phone ? ` (${order.assignedRider.phone})` : ''}
            </p>
          ) : (
            <p className="mt-1 text-xs text-indigo-700">{t('sales.online.notAssignedYet')}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={selectedRiderId}
              onChange={(event) => setSelectedRiderId(event.target.value)}
              disabled={assigningRider || riders.length === 0}
              className="rounded-2xl border border-indigo-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">{riders.length === 0 ? t('sales.online.noRidersOnStaff') : t('sales.online.chooseRider')}</option>
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
              {order.assignedRider?.phone ? t('sales.online.reassignNotify') : t('sales.online.assignNotify')}
            </button>
          </div>
        </div>
      ) : null}

      {hasPendingChangeRequest ? (
        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-amber-600">{t('sales.online.customerRequestedChange')}</p>
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
              {t('sales.online.approve')}
            </button>
            <button
              type="button"
              disabled={respondingToChangeRequest}
              onClick={() => onRespondToChangeRequest(order, 'reject')}
              className="rounded-2xl bg-rose-100 px-4 py-2 text-xs font-black text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('sales.online.decline')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
