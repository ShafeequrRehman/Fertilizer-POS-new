import { useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/i18n';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Download, Edit3, Eye, Printer, Search, Trash2, WifiOff, X } from 'lucide-react';
import { cancelOrder, fetchCustomerOutstanding, fetchOrders, fetchProducts, fetchShopSessionHistory } from '@/lib/pos-api';
import { writeOrderReceiptToWindow } from '@/lib/order-receipt-print';
import { SavedOrder, ShopSession, Product } from '@/lib/pos-types';
import { getStoreSettings } from '@/lib/pos-settings';
import { hasPermission, getAuthUser } from '@/lib/auth';
import { getBusinessWindow, filterOrdersInBusinessWindow, filterOrdersInBusinessWindows, getSessionDateKey, useShopSession } from '@/lib/shop-session';
import { isDesktopApp } from '@/lib/api';
import { useNetworkStatus } from '@/lib/network-status';
import { getLocalHubStartDiagnostics, getReferenceData, pushOrdersCache } from '@/lib/local-hub-api';
import { loadOrdersFromLocalHub, saveOrderCancelOffline } from '@/lib/offline-order-helpers';
import { triggerBackgroundSync } from '@/lib/offline-sync';
import { buildCategoryLookup, dispatchKitchenPrints } from '@/lib/kitchen-print-routing';
import { reportPrintOutcome, ToastLike } from '@/lib/print-notify';
import { useToast } from '@/lib/toast';
import CompleteOrderModal from '@/components/CompleteOrderModal';
import OrderDetailModal, { StatusBadge } from '@/components/OrderDetailModal';
import { downloadExcelWorkbook, ExcelCell, ExcelCellStyle, ExcelSheet } from '@/lib/excel-export';
// NOTE: intentionally NOT a static top-level import - see the matching
// comment in LedgerPage.tsx. @react-pdf/renderer (imported by
// @/lib/pdf-export) crashes the whole app at startup if it's pulled into
// Vite's eager dependency pre-bundle via a static import on a routed page,
// so it's loaded dynamically, only when Download PDF is actually clicked.

type ElectronWindow = Window & typeof globalThis & {
  require?: (moduleName: 'electron') => {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  };
};

// Same direct-IPC-else-fallback-page pattern as SalesPage.tsx's own
// printCustomerReceipt - prints on this till's own counter printer
// immediately if one's configured, otherwise opens the Manual Print
// Center page. A free function (not a hook) since CompleteOrderModal is
// the only place in this file that ever needs it.
// Fallback (non-Electron-counter-printer) path prints straight into a
// plain window instead of navigating to the Manual Print Center page in
// a new tab - that route worked, but a brand new tab means the WHOLE app
// boots from scratch in it first (Redux store, auth, the "Starting POS
// System" splash) before the receipt even shows up, which is not what
// "click Print, get a slip" should feel like. See order-receipt-print.ts's
// own comment - same fix as DuesPage.tsx's own handlePrintOrder.
async function printCustomerReceipt(order: SavedOrder, customerDue: number, toast: ToastLike) {
  const settings = getStoreSettings();
  const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
  if (isElectron && settings && settings.counterPrinter) {
    try {
      const electronRequire = (window as ElectronWindow).require;
      const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
      if (!ipcRenderer) throw new Error('Electron IPC is unavailable.');
      const printLogo = localStorage.getItem('preferred-print-logo');
      const receiptData = { ...order, previousDues: customerDue };
      reportPrintOutcome(
        ipcRenderer.invoke('print-cashier-receipt-data', receiptData, settings.counterPrinter, printLogo, settings),
        'Customer receipt',
        toast,
      );
      return;
    } catch {
      // Falls through to the plain-window path below.
    }
  }
  const printWindow = window.open('', '_blank', 'width=420,height=650');
  if (!printWindow) {
    toast.error('Could not open the print window - check your browser\'s popup blocker.');
    return;
  }
  printWindow.document.write('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">Loading receipt...</body></html>');
  let previousDues = customerDue;
  const phone = order.customer?.phone;
  if (phone && phone !== '03000000000') {
    try {
      const result = await fetchCustomerOutstanding(phone, order.id);
      previousDues = Number(result?.outstanding ?? 0);
    } catch {
      // Not fatal - the receipt still prints, just without a refreshed
      // Arrears figure (falls back to whatever customerDue was passed in).
    }
  }
  if (printWindow.closed) return;
  writeOrderReceiptToWindow(printWindow, order, previousDues);
}

// Same reasoning as CancelOrderModal.tsx's own getCancelCategoryLookup -
// fetched fresh only when a cancellation actually happens, falling back to
// an empty lookup (every item routes to the kitchen printer) if it fails,
// never letting a catalog hiccup block the cancellation itself.
async function getCancelCategoryLookup(useLocalCache: boolean): Promise<Map<string, string>> {
  try {
    if (useLocalCache) {
      const snapshot = await getReferenceData();
      return buildCategoryLookup((snapshot.products || []) as Product[]);
    }
    const result = await fetchProducts();
    return buildCategoryLookup(result.products || []);
  } catch {
    return new Map();
  }
}

// Fires the "stop preparation" kitchen ticket the instant an order is
// cancelled/deleted - same as CancelOrderModal.tsx's own version (the shop
// owner asked to drop that confirm popup entirely for delete, in favor of
// this instant direct-cancel path, so this is duplicated here rather than
// still routing through that modal).
function printKitchenCancelTicket(order: SavedOrder, toast: ToastLike, categoryLookup: Map<string, string>) {
  const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
  if (!isElectron) return;

  try {
    const electronRequire = (window as ElectronWindow).require;
    if (!electronRequire) return;
    const { ipcRenderer } = electronRequire('electron');
    const settings = getStoreSettings();
    const printLogo = localStorage.getItem('preferred-print-logo');

    if (settings.kitchenPrinter || settings.counterPrinter) {
      void dispatchKitchenPrints(
        order.items,
        categoryLookup,
        settings,
        (groupItems, printerName, label) =>
          reportPrintOutcome(
            ipcRenderer.invoke('print-kitchen-cancel-receipt-data', { ...order, items: groupItems }, printerName, printLogo, settings),
            `${label} cancellation`,
            toast,
          ),
      );
    }
  } catch (err) {
    console.error('Electron print error (kitchen cancel ticket):', err);
  }
}

type StatusFilter = 'All' | 'pending' | 'completed' | 'paid' | 'cancelled';
type SearchField = 'all' | 'name' | 'phone' | 'orderId';

// This page's own order fetch used to be fully unbounded (no since/date
// filter at all) purely so the custom Date Range picker/CSV export below
// could reach ANY past shift - but that meant every single normal page
// load pulled this shop's ENTIRE lifetime order history (every field, every
// item, every order ever placed) over the wire, even though the page only
// ever DISPLAYS the current shift by default. On a shop with real history
// that's real seconds of wasted load time on every visit for a feature most
// visits never touch. Bounding the routine load to this window instead, and
// only widening to the full unbounded fetch the one time someone actually
// picks a date outside it (see the effect below), keeps the common case
// fast without removing the ability to look up or export any past date.
const RECENT_ORDERS_WINDOW_DAYS = 14;

const STATUS_TABS: { key: StatusFilter }[] = [
  { key: 'All' },
  { key: 'pending' },
  { key: 'completed' },
  { key: 'paid' },
  { key: 'cancelled' },
];

// Maps a status/tab key to its translation key - 'All' is the one tab that
// isn't itself an order status, so it borrows common.all instead of its own
// record.statusTab.* entry. Kept at module scope (no `t` call here, just the
// dotted path) so it's usable both from the STATUS_TABS render below and
// from StatusBadge, which is its own component with its own useLanguage().
function statusLabelKey(status: StatusFilter): string {
  return status === 'All' ? 'common.all' : `record.statusTab.${status}`;
}

// The "day" here is exactly the current/most recent shop shift - the same
// shared definition used on the Dashboard and Sales page (see
// getBusinessWindow / filterOrdersInBusinessWindow in
// src/lib/shop-session.tsx, the single source of truth for this date-math)
// - not a fixed clock window. While a shift is open the window is
// [openedAt, now] and keeps growing; once closed it freezes at [openedAt,
// closedAt], so this stays "today's record" until the next Open Shop
// starts a new one.
export default function RecordPage() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { isOnline } = useNetworkStatus();
  // The shared, cached shop-open state (see shop-session.tsx) - used as the
  // offline fallback for `shopSession` below, same reasoning as
  // SalesPage.tsx's own cachedShopSession: this page's own
  // fetchShopSessionHistory() call is cloud-only, so without this, the
  // "current shift" window this page defaults to would have nothing to
  // define itself against while offline.
  const { session: cachedShopSession } = useShopSession();
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [shopSession, setShopSession] = useState<ShopSession | null>(null);
  // Full shift history (up to the last 60 shifts, per the backend) - needed
  // so the date-range picker can find EVERY shift that opened on a picked
  // date, not just whatever the current/latest shift happens to be. Cloud-
  // only (see refresh() below) - browsing PAST shifts by calendar date is
  // an online-only enhancement; the default current-shift view (everything
  // else on this page) works fully offline regardless.
  const [sessionHistory, setSessionHistory] = useState<ShopSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [search, setSearch] = useState('');
  const [searchField, setSearchField] = useState<SearchField>('all');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  // Tracks whether the one-time widen-to-full-history fetch below has
  // already run, so picking an old date twice doesn't re-fetch the whole
  // shop's lifetime order history a second time. Mirrored into a ref (kept
  // in sync just below) because loadAny()'s periodic setInterval closure
  // (see its own effect, deliberately only re-created on [isOnline]
  // changes) would otherwise keep seeing whatever this was at mount and
  // silently re-bound the fetch back down 45s after a custom range widened
  // it - the ref always reads the current value instead.
  const [hasFullHistory, setHasFullHistory] = useState(false);
  const hasFullHistoryRef = useRef(hasFullHistory);
  useEffect(() => {
    hasFullHistoryRef.current = hasFullHistory;
  }, [hasFullHistory]);
  // Bumped on every local, optimistic order edit made on this page
  // (complete/cancel) - see SalesPage.tsx's identical ref for the full
  // reasoning. refresh() below is a live cloud round trip that can take
  // several seconds on a slow connection; if a shift is completed/
  // cancelled while an earlier refresh() tick is still in flight, that
  // stale response can land AFTER the optimistic update and blindly
  // overwrite it back to "pending" via its own setOrders(orderData) - a
  // visible flicker. Capturing this value before refresh()'s network call
  // and skipping the overwrite if it changed in the meantime closes that
  // window.
  const localEditVersionRef = useRef(0);
  const [viewOrder, setViewOrder] = useState<SavedOrder | null>(null);
  const [completeOrderTarget, setCompleteOrderTarget] = useState<SavedOrder | null>(null);
  // Guards Delete against a rapid double-click firing two real
  // cancellations for the same order, now that this is a direct one-click
  // action with no confirm popup in between to naturally absorb that.
  const [deletingOrderIds, setDeletingOrderIds] = useState<Set<string>>(new Set());
  // name::variation -> category, used to roll the per-item breakdown up
  // into per-category totals below it. Products rarely change mid-shift,
  // so this is only refetched on mount/manual reload, not on the same
  // 45s poll as orders.
  const [categoryByItem, setCategoryByItem] = useState<Map<string, string>>(new Map());
  // Each of the three tables below (Item Sales, Category Sales, Orders)
  // paginates independently - show 10 rows, "Load More" grows that table's
  // own count by 10. Kept as separate state so loading more of one table
  // never affects the others.
  const [visibleItemSalesCount, setVisibleItemSalesCount] = useState(10);
  const [visibleCategorySalesCount, setVisibleCategorySalesCount] = useState(10);
  const [visibleOrdersCount, setVisibleOrdersCount] = useState(10);

  // Always the FIRST (and, offline, only) thing this page shows - same
  // cache-first pattern as SalesPage.tsx's loadFromCache: the Local Hub's
  // cached cloud snapshot combined with whatever this till still has
  // queued locally (see offline-order-helpers.ts's loadOrdersFromLocalHub),
  // never a live cloud call, so it's instant and connectivity-independent.
  async function loadFromCache() {
    if (cachedShopSession) setShopSession((current) => current ?? cachedShopSession);
    try {
      // Same staleness guard as refresh() - see localEditVersionRef's own
      // comment.
      const versionAtStart = localEditVersionRef.current;
      const merged = await loadOrdersFromLocalHub();
      if (localEditVersionRef.current !== versionAtStart) return;
      setOrders(merged);
      setLoadError('');
    } catch {
      const diagnostics = await getLocalHubStartDiagnostics();
      const reason = diagnostics && !diagnostics.started ? ` (${diagnostics.error || t('record.loadError.failedToStart')})` : '';
      setLoadError(t('record.loadError.localHubUnreachable', { reason }));
    }
  }

  // The live cloud refresh - also the only source for sessionHistory (past-
  // shift browsing, cloud-only, see its own comment above). Bounded to the
  // last RECENT_ORDERS_WINDOW_DAYS by default (see that const's own
  // comment) unless `unbounded` is passed - only the widen-to-full-history
  // effect below ever does that, and only once.
  async function refresh(unbounded = false) {
    try {
      // Captured before the network round trip below - see
      // localEditVersionRef's own comment.
      const versionAtStart = localEditVersionRef.current;
      const since = unbounded ? undefined : new Date(Date.now() - RECENT_ORDERS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const [orderData, history] = await Promise.all([fetchOrders(since ? { since } : undefined), fetchShopSessionHistory()]);
      const isStale = localEditVersionRef.current !== versionAtStart;
      if (orderData && !isStale) {
        setOrders(orderData);
        // Bounded (the common case) or unbounded (once a custom range has
        // widened it) - either way this is still the most complete source
        // this till has right now, so it's still worth pushing into the
        // Local Hub's shared order cache for Sales/POS's offline view.
        // Previously only SalesPage.tsx pushed here, also bounded to 14
        // days - a still-pending order older than that could go
        // offline-invisible everywhere until Sales happened to reload
        // while online; same caveat still applies here now, unchanged from
        // before this page's own fetch was bounded too.
        if (isDesktopApp()) {
          void pushOrdersCache(orderData).catch(() => {});
        }
      }
      // Only ever UPGRADE sessionHistory/shopSession here - never downgrade
      // to empty/null just because this one poll's history fetch came back
      // empty (a transient blip, replica lag, etc). getBusinessWindow treats
      // "no session" as "match nothing", so a wrongful null flashed every
      // shift-scoped stat on this page to 0 a few seconds after they first
      // painted correctly from the cache, even though the shop was
      // genuinely still open (and its shift history still real) the whole
      // time - same reasoning as the orderData/isStale guard just above.
      if (history && history.length > 0) {
        setSessionHistory(history);
        setShopSession(history[0]);
      }
      setLoadError('');
    } catch (error) {
      console.error('Record page load error', error);
    }
  }

  async function loadAny() {
    if (isDesktopApp()) {
      await loadFromCache();
      // Best-effort, not awaited - the cache-first paint above already
      // gave a usable list; this just refreshes it (and sessionHistory) if
      // the cloud is actually reachable right now.
      if (isOnline) void refresh(hasFullHistoryRef.current);
    } else {
      await refresh(hasFullHistoryRef.current);
    }
  }

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        await loadAny();
      } finally {
        setLoading(false);
      }
    }
    void load();
    const intervalId = setInterval(() => void loadAny(), 45000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  useEffect(() => {
    async function loadCategories() {
      try {
        const result = await fetchProducts();
        if (!result) return;
        const map = new Map<string, string>();
        result.products.forEach((product) => {
          map.set(`${product.name}::${product.variation || ''}`, product.category || 'Uncategorized');
          // Fallback key (name only) so an item still resolves a category
          // even if its variation text drifted from the catalog after the
          // order was placed (product edited/renamed since).
          if (!map.has(product.name)) map.set(product.name, product.category || 'Uncategorized');
        });
        setCategoryByItem(map);
      } catch (error) {
        console.error('Record page product/category load error', error);
      }
    }
    void loadCategories();
  }, []);

  const sessionWindow = useMemo(() => getBusinessWindow(shopSession, new Date()), [shopSession]);

  // The one place this page ever pays for its own fetch's default 14-day
  // bound (see RECENT_ORDERS_WINDOW_DAYS above): if someone actually picks
  // a Date Range whose start predates that window, the orders already in
  // memory can't possibly cover it, so widen to a single unbounded fetch to
  // pull in this shop's full history - once, not on every keystroke/every
  // 45s poll after that (hasFullHistory latches it).
  useEffect(() => {
    if (!rangeFrom || hasFullHistory) return;
    const cutoff = new Date(Date.now() - RECENT_ORDERS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const pickedFrom = new Date(`${rangeFrom}T00:00:00.000Z`);
    if (Number.isNaN(pickedFrom.getTime()) || pickedFrom >= cutoff) return;
    setHasFullHistory(true);
    void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeFrom, hasFullHistory]);

  // A picked date range is an explicit, deliberate request to browse PAST
  // days by calendar date - the opposite of "today", which always stays
  // shift-based. Picking From/To here doesn't change what "today" means
  // anywhere else in the app; it only swaps what this page is looking at.
  // Clearing either date snaps straight back to the live current-shift view.
  //
  // Every shift that OPENED on a picked date is matched (there can be more
  // than one on the same day, or several days' worth for a multi-day
  // range), and each one's own full open->close window is used - not a
  // raw midnight-to-midnight slice of the picked date, which would miss or
  // split a shift that ran past midnight (see getSessionDateKey in
  // shop-session.tsx for why "opened on" is the rule, not "stamped with").
  const isCustomRange = Boolean(rangeFrom && rangeTo);

  // en-CA formats as YYYY-MM-DD in the browser's LOCAL time zone (unlike
  // toISOString, which is UTC and can land on the wrong day close to
  // midnight) - matches the `type="date"` input's own value format, so it
  // can be used directly as `max` to block picking any day after today.
  const todayKey = new Date().toLocaleDateString('en-CA');

  const customWindows = useMemo(() => {
    if (!isCustomRange) return [];
    return sessionHistory
      .filter((session) => {
        const key = getSessionDateKey(session);
        return key >= rangeFrom && key <= rangeTo;
      })
      .map((session) => getBusinessWindow(session, new Date()));
  }, [isCustomRange, sessionHistory, rangeFrom, rangeTo]);

  const dayOrders = useMemo(() => {
    if (isCustomRange) return filterOrdersInBusinessWindows(orders, customWindows);
    return filterOrdersInBusinessWindow(orders, sessionWindow);
  }, [isCustomRange, orders, customWindows, sessionWindow]);

  // A pending order is exactly a still-occupied table/tab that was never
  // completed - shift- or date-scoping it the same way as every other tab
  // is what made these "difficult to find" in the first place (see the user
  // request this was built for): once a new shift opens, an old unpaid
  // DineIn bill from a previous day would simply fall out of dayOrders and
  // become unreachable from here without knowing the exact past date to
  // range-pick. Bounded by count instead (there's only ever as many as
  // there are still-open tables/tabs), same reasoning as the backend's
  // getOccupiedDineInTables.
  const allPendingOrders = useMemo(() => orders.filter((order) => order.status === 'pending'), [orders]);

  const filteredOrders = useMemo(() => {
    const base = statusFilter === 'pending' ? allPendingOrders : dayOrders;
    return base
      // 'All' is the default/main view - a cancelled order is already
      // fully reversed (stock restored, dues excluded) the moment it's
      // cancelled, so leaving it visible here by default would make it
      // look like it's still an active order. It isn't lost - the
      // dedicated "Cancelled" tab (still in STATUS_TABS below) keeps the
      // full audit trail one click away, same as the Khata/Ledger pages.
      .filter((order) => (statusFilter === 'All' ? order.status !== 'cancelled' : order.status === statusFilter))
      .filter((order) => {
        const term = search.trim().toLowerCase();
        if (!term) return true;
        if (searchField === 'name') return (order.customer?.name ?? '').toLowerCase().includes(term);
        if (searchField === 'phone') return (order.customer?.phone ?? '').toLowerCase().includes(term);
        if (searchField === 'orderId') return `${order.dailyOrderNumber ?? ''} ${order.id}`.toLowerCase().includes(term);
        const haystack = `${order.dailyOrderNumber ?? ''} ${order.id} ${order.customer?.name ?? ''} ${order.customer?.phone ?? ''} ${order.table ?? ''} ${order.waiter ?? ''}`.toLowerCase();
        return haystack.includes(term);
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [dayOrders, allPendingOrders, statusFilter, search, searchField]);

  // Financial summary cards mirror the reference "Orders List & Analytics"
  // layout - Total Orders counts every row shown, but the money figures
  // exclude cancelled orders (they were never actually charged), matching
  // the same convention already used by totalDiscountToday below and by
  // the backend's own shift-close summary.
  const orderStats = useMemo(() => {
    const charged = dayOrders.filter((order) => order.status !== 'cancelled');
    const totalAmount = charged.reduce((sum, order) => sum + Number(order.total || 0), 0);
    const paidAmount = charged.reduce((sum, order) => sum + Number(order.paidAmount ?? order.total ?? 0), 0);
    const remainingAmount = charged.reduce((sum, order) => sum + Number(order.remainingAmount ?? 0), 0);
    // Cash in Hand vs Bank split of paidAmount above - same
    // "paymentMethod === 'Bank' -> bank, else -> cash" rule
    // reportController.js's getDashboardSummary (saleOnCash/saleOnBank) and
    // this page's own itemSales/categorySales Cash/Bank columns already
    // use, so this stat row always foots against both of those.
    let cashAmount = 0;
    let bankAmount = 0;
    charged.forEach((order) => {
      const paid = Number(order.paidAmount ?? order.total ?? 0);
      if (order.paymentMethod === 'Bank') bankAmount += paid;
      else cashAmount += paid;
    });
    return { totalOrders: dayOrders.length, totalAmount, paidAmount, cashAmount, bankAmount, remainingAmount };
  }, [dayOrders]);

  function clearRange() {
    setRangeFrom('');
    setRangeTo('');
  }

  function exportCsv() {
    const header = [
      t('record.orderIdLabel'),
      t('common.date'),
      t('common.time'),
      t('record.tableHeaders.customer'),
      t('common.phone'),
      t('record.tableHeaders.type'),
      t('common.status'),
      t('common.total'),
      t('record.paid'),
      t('record.remaining'),
    ];
    const rows = filteredOrders.map((order) => {
      const createdAt = new Date(order.createdAt);
      const customerName = order.orderType === 'DineIn' ? (order.table ? t('record.tableLabel', { table: order.table }) : t('record.dineInCustomer')) : order.customer?.name || t('record.walkInCustomer');
      return [
        `#${order.dailyOrderNumber ?? order.id.slice(-4)}`,
        createdAt.toLocaleDateString('en-CA'),
        createdAt.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }),
        customerName,
        order.customer?.phone || '',
        order.orderType,
        order.status,
        order.total,
        order.paidAmount ?? 0,
        order.remainingAmount ?? 0,
      ];
    });
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `orders_${isCustomRange ? `${rangeFrom}_to_${rangeTo}` : 'current-shift'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // "Beautifully designed" Excel workbook: a colour-coded Summary sheet
  // (totals + category rollup), one sheet per product category (Pizza,
  // Drinks, ...) each listing that category's own items, and a full
  // All Orders sheet - all scoped to the exact same window (current shift,
  // or the picked date range) that the rest of this page already uses via
  // dayOrders/filteredOrders. Built on the dependency-free SpreadsheetML
  // exporter in @/lib/excel-export (see that file's header comment for why
  // this doesn't just use a library like exceljs).
  function exportExcel() {
    const rangeLabel = isCustomRange ? t('record.export.dateRangeValue', { from: rangeFrom, to: rangeTo }) : t('record.export.currentShift');
    const MONEY_FORMAT = '"Rs "#,##0';

    const titleStyle: ExcelCellStyle = { bold: true, fontSize: 14 };
    const subtitleStyle: ExcelCellStyle = { color: '6B7280' };
    const headerStyle: ExcelCellStyle = { bold: true, bg: '1F2937', color: 'FFFFFF', align: 'Center' };
    const statLabelStyle: ExcelCellStyle = { bold: true, bg: 'EEF2FF', color: '3730A3' };
    const subtotalStyle: ExcelCellStyle = { bold: true, bg: 'F3F4F6', borderBottom: true };
    const moneyStyle: ExcelCellStyle = { format: MONEY_FORMAT, borderBottom: true };
    const plainStyle: ExcelCellStyle = { borderBottom: true };
    const moneyBoldStyle: ExcelCellStyle = { format: MONEY_FORMAT, bold: true, bg: 'F3F4F6', borderBottom: true };

    const sheets: ExcelSheet[] = [];

    // Group itemSales by their resolved category once, reused below by both
    // the Summary sheet's item-wise section and the per-category sheets.
    // itemSales is already sorted revenue-desc, so each bucket comes out
    // revenue-desc too (filtering a sorted list preserves relative order) -
    // no need to re-sort per category.
    const itemsByCategory = new Map<string, typeof itemSales>();
    itemSales.forEach((item) => {
      const category =
        categoryByItem.get(`${item.name}::${item.variation}`) ||
        categoryByItem.get(item.name) ||
        'Uncategorized';
      if (!itemsByCategory.has(category)) itemsByCategory.set(category, []);
      itemsByCategory.get(category)!.push(item);
    });

    // --- Summary sheet: category-wise sale on top, item-wise sale below ---
    // Category-wise here is a genuine rollup - e.g. "Pizza" is the combined
    // total of every pizza product (Special Pizza, Supreme Pizza, ...), one
    // row, not split apart. The item-wise section underneath is where those
    // individual products are broken out, each tagged with its category so
    // it's clear they all belong to that one combined total above.
    const totalCategoryQty = categorySales.reduce((sum, c) => sum + c.qty, 0);
    const totalCategoryRevenue = categorySales.reduce((sum, c) => sum + c.revenue, 0);
    const totalCategoryCash = categorySales.reduce((sum, c) => sum + c.cashAmount, 0);
    const totalCategoryBank = categorySales.reduce((sum, c) => sum + c.bankAmount, 0);
    const totalCategoryDue = categorySales.reduce((sum, c) => sum + c.dueAmount, 0);
    const summaryRows: ExcelCell[][] = [
      [{ value: t('record.export.salesRecordTitle'), style: titleStyle }],
      [{ value: rangeLabel, style: subtitleStyle }],
      [],
      [
        { value: t('record.stats.totalOrders'), style: statLabelStyle },
        { value: t('record.export.totalSales'), style: statLabelStyle },
        { value: t('record.stats.cashAmount'), style: statLabelStyle },
        { value: t('record.stats.bankAmount'), style: statLabelStyle },
        { value: t('record.remaining'), style: statLabelStyle },
      ],
      [
        { value: orderStats.totalOrders },
        { value: orderStats.totalAmount, style: moneyStyle },
        { value: orderStats.cashAmount, style: moneyStyle },
        { value: orderStats.bankAmount, style: moneyStyle },
        { value: orderStats.remainingAmount, style: moneyStyle },
      ],
      [],
      [{ value: t('record.export.categoryWiseSale'), style: titleStyle }],
      [
        { value: t('common.category'), style: headerStyle },
        { value: t('record.qtySold'), style: headerStyle },
        { value: t('record.revenue'), style: headerStyle },
        { value: t('record.cashAmount'), style: headerStyle },
        { value: t('record.bankAmount'), style: headerStyle },
        { value: t('record.dueAmount'), style: headerStyle },
      ],
      ...categorySales.map((c): ExcelCell[] => [
        { value: c.category, style: plainStyle },
        { value: c.qty, style: plainStyle },
        { value: c.revenue, style: moneyStyle },
        { value: c.cashAmount, style: moneyStyle },
        { value: c.bankAmount, style: moneyStyle },
        { value: c.dueAmount, style: moneyStyle },
      ]),
      [
        { value: t('record.export.grandTotal'), style: subtotalStyle },
        { value: totalCategoryQty, style: subtotalStyle },
        { value: totalCategoryRevenue, style: moneyBoldStyle },
        { value: totalCategoryCash, style: moneyBoldStyle },
        { value: totalCategoryBank, style: moneyBoldStyle },
        { value: totalCategoryDue, style: moneyBoldStyle },
      ],
      [],
      [{ value: t('record.export.itemWiseSale'), style: titleStyle }],
      [
        { value: t('common.category'), style: headerStyle },
        { value: t('record.item'), style: headerStyle },
        { value: t('record.variation'), style: headerStyle },
        { value: t('record.qtySold'), style: headerStyle },
        { value: t('record.revenue'), style: headerStyle },
        { value: t('record.cashAmount'), style: headerStyle },
        { value: t('record.bankAmount'), style: headerStyle },
        { value: t('record.dueAmount'), style: headerStyle },
      ],
      ...categorySales.flatMap((catSummary): ExcelCell[][] =>
        (itemsByCategory.get(catSummary.category) || []).map((item): ExcelCell[] => [
          { value: catSummary.category, style: plainStyle },
          { value: item.name, style: plainStyle },
          { value: item.variation || '-', style: plainStyle },
          { value: item.qty, style: plainStyle },
          { value: item.revenue, style: moneyStyle },
          { value: item.cashAmount, style: moneyStyle },
          { value: item.bankAmount, style: moneyStyle },
          { value: item.dueAmount, style: moneyStyle },
        ]),
      ),
      [
        { value: t('record.export.grandTotal'), style: subtotalStyle },
        { value: '', style: subtotalStyle },
        { value: '', style: subtotalStyle },
        { value: totalCategoryQty, style: subtotalStyle },
        { value: totalCategoryRevenue, style: moneyBoldStyle },
        { value: totalCategoryCash, style: moneyBoldStyle },
        { value: totalCategoryBank, style: moneyBoldStyle },
        { value: totalCategoryDue, style: moneyBoldStyle },
      ],
    ];
    sheets.push({ name: t('record.export.summarySheetName'), columnWidths: [140, 180, 100, 80, 100, 100, 100, 100], rows: summaryRows });

    // --- One sheet per category: the combined category total sits at the
    // top (so it reads as one figure for the whole category, e.g. Pizza),
    // then every item that rolls up into it is listed below.
    categorySales.forEach((catSummary) => {
      const items = itemsByCategory.get(catSummary.category) || [];
      const rows: ExcelCell[][] = [
        [{ value: catSummary.category, style: titleStyle }],
        [],
        [
          { value: t('record.export.totalQtySold'), style: statLabelStyle },
          { value: t('record.export.totalRevenue'), style: statLabelStyle },
          { value: t('record.export.totalCash'), style: statLabelStyle },
          { value: t('record.export.totalBank'), style: statLabelStyle },
          { value: t('record.export.totalDue'), style: statLabelStyle },
        ],
        [
          { value: catSummary.qty, style: moneyBoldStyle },
          { value: catSummary.revenue, style: moneyBoldStyle },
          { value: catSummary.cashAmount, style: moneyBoldStyle },
          { value: catSummary.bankAmount, style: moneyBoldStyle },
          { value: catSummary.dueAmount, style: moneyBoldStyle },
        ],
        [],
        [
          { value: t('record.item'), style: headerStyle },
          { value: t('record.variation'), style: headerStyle },
          { value: t('record.qtySold'), style: headerStyle },
          { value: t('record.revenue'), style: headerStyle },
          { value: t('record.cashAmount'), style: headerStyle },
          { value: t('record.bankAmount'), style: headerStyle },
          { value: t('record.dueAmount'), style: headerStyle },
        ],
        ...items.map((item): ExcelCell[] => [
          { value: item.name, style: plainStyle },
          { value: item.variation || '-', style: plainStyle },
          { value: item.qty, style: plainStyle },
          { value: item.revenue, style: moneyStyle },
          { value: item.cashAmount, style: moneyStyle },
          { value: item.bankAmount, style: moneyStyle },
          { value: item.dueAmount, style: moneyStyle },
        ]),
      ];
      sheets.push({ name: catSummary.category, columnWidths: [180, 120, 90, 100, 100, 100, 100], rows });
    });

    // --- All Orders sheet (mirrors Export CSV's columns) ---
    const orderRows: ExcelCell[][] = [
      [
        t('record.orderIdLabel'), t('common.date'), t('common.time'), t('record.tableHeaders.customer'), t('common.phone'),
        t('record.tableHeaders.type'), t('common.status'), t('common.total'), t('record.paid'), t('record.remaining'),
      ].map((h): ExcelCell => ({ value: h, style: headerStyle })),
      ...filteredOrders.map((order): ExcelCell[] => {
        const createdAt = new Date(order.createdAt);
        const customerName =
          order.orderType === 'DineIn'
            ? order.table
              ? t('record.tableLabel', { table: order.table })
              : t('record.dineInCustomer')
            : order.customer?.name || t('record.walkInCustomer');
        return [
          { value: `#${order.dailyOrderNumber ?? order.id.slice(-4)}`, style: plainStyle },
          { value: createdAt.toLocaleDateString('en-CA'), style: plainStyle },
          { value: createdAt.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }), style: plainStyle },
          { value: customerName, style: plainStyle },
          { value: order.customer?.phone || '', style: plainStyle },
          { value: order.orderType, style: plainStyle },
          { value: order.status, style: plainStyle },
          { value: order.total, style: moneyStyle },
          { value: order.paidAmount ?? 0, style: moneyStyle },
          { value: order.remainingAmount ?? 0, style: moneyStyle },
        ];
      }),
    ];
    sheets.push({
      name: t('record.export.allOrders'),
      columnWidths: [70, 80, 70, 140, 100, 80, 80, 80, 80, 80],
      rows: orderRows,
    });

    downloadExcelWorkbook(sheets, `record_${isCustomRange ? `${rangeFrom}_to_${rangeTo}` : 'current-shift'}.xls`);
  }

  // "Neat, downloadable PDF layout" of the exact same filtered view as
  // Export Excel/CSV above - stat cards, the category-wise and item-wise
  // rollups, then the full order list - built on the shared
  // ReportPdfDocument (see @/lib/pdf-export.tsx) rather than a bespoke
  // layout, since it's the same "title, stats, tables" shape either page
  // needs.
  async function exportPdf() {
    const { ReportPdfDocument, downloadPdfDocument } = await import('@/lib/pdf-export');
    const rangeLabel = isCustomRange ? t('record.export.dateRangeValue', { from: rangeFrom, to: rangeTo }) : t('record.export.currentShift');
    const formatMoney = (value: number) => `Rs ${Math.round(value).toLocaleString()}`;

    const totalCategoryQty = categorySales.reduce((sum, c) => sum + c.qty, 0);
    const totalCategoryRevenue = categorySales.reduce((sum, c) => sum + c.revenue, 0);
    const totalCategoryCash = categorySales.reduce((sum, c) => sum + c.cashAmount, 0);
    const totalCategoryBank = categorySales.reduce((sum, c) => sum + c.bankAmount, 0);
    const totalCategoryDue = categorySales.reduce((sum, c) => sum + c.dueAmount, 0);

    const itemsByCategory = new Map<string, typeof itemSales>();
    itemSales.forEach((item) => {
      const category =
        categoryByItem.get(`${item.name}::${item.variation}`) ||
        categoryByItem.get(item.name) ||
        'Uncategorized';
      if (!itemsByCategory.has(category)) itemsByCategory.set(category, []);
      itemsByCategory.get(category)!.push(item);
    });

    const orderCountText = filteredOrders.length === 1
      ? t('record.export.orderCountSingular', { count: filteredOrders.length })
      : t('record.export.orderCountPlural', { count: filteredOrders.length });
    const doc = (
      <ReportPdfDocument
        title={t('record.export.salesRecordTitle')}
        subtitle={`${rangeLabel} · ${orderCountText}${statusFilter !== 'All' ? ` · ${t(statusLabelKey(statusFilter))}` : ''}`}
        stats={[
          { label: t('record.stats.totalOrders'), value: String(orderStats.totalOrders) },
          { label: t('record.stats.totalAmount'), value: formatMoney(orderStats.totalAmount) },
          { label: t('record.stats.paidAmount'), value: formatMoney(orderStats.paidAmount) },
          { label: t('record.stats.cashAmount'), value: formatMoney(orderStats.cashAmount) },
          { label: t('record.stats.bankAmount'), value: formatMoney(orderStats.bankAmount) },
          { label: t('record.stats.remainingAmount'), value: formatMoney(orderStats.remainingAmount) },
        ]}
        tables={[
          {
            title: t('record.export.categoryWiseSale'),
            columns: [
              { label: t('common.category'), width: 1.4 },
              { label: t('record.qtySold'), width: 0.7, align: 'right' },
              { label: t('record.revenue'), width: 1, align: 'right' },
              { label: t('record.cashAmount'), width: 1, align: 'right' },
              { label: t('record.bankAmount'), width: 1, align: 'right' },
              { label: t('record.dueAmount'), width: 1, align: 'right' },
            ],
            rows: categorySales.map((c) => [c.category, String(c.qty), formatMoney(c.revenue), formatMoney(c.cashAmount), formatMoney(c.bankAmount), formatMoney(c.dueAmount)]),
            footer: [t('record.export.grandTotal'), String(totalCategoryQty), formatMoney(totalCategoryRevenue), formatMoney(totalCategoryCash), formatMoney(totalCategoryBank), formatMoney(totalCategoryDue)],
            emptyMessage: t('record.export.noItemsInSelection'),
          },
          {
            title: t('record.export.itemWiseSale'),
            columns: [
              { label: t('common.category'), width: 1.2 },
              { label: t('record.item'), width: 1.4 },
              { label: t('record.variation'), width: 0.9 },
              { label: t('record.qtySold'), width: 0.7, align: 'right' },
              { label: t('record.revenue'), width: 1, align: 'right' },
              { label: t('record.cashAmount'), width: 1, align: 'right' },
              { label: t('record.bankAmount'), width: 1, align: 'right' },
              { label: t('record.dueAmount'), width: 1, align: 'right' },
            ],
            rows: categorySales.flatMap((catSummary) =>
              (itemsByCategory.get(catSummary.category) || []).map((item) => [
                catSummary.category,
                item.name,
                item.variation || '-',
                String(item.qty),
                formatMoney(item.revenue),
                formatMoney(item.cashAmount),
                formatMoney(item.bankAmount),
                formatMoney(item.dueAmount),
              ]),
            ),
            footer: [t('record.export.grandTotal'), '', '', String(totalCategoryQty), formatMoney(totalCategoryRevenue), formatMoney(totalCategoryCash), formatMoney(totalCategoryBank), formatMoney(totalCategoryDue)],
            emptyMessage: t('record.export.noItemsInSelection'),
          },
          {
            title: t('record.export.allOrders'),
            columns: [
              { label: t('record.orderIdLabel'), width: 1 },
              { label: t('common.date'), width: 1 },
              { label: t('common.time'), width: 0.9 },
              { label: t('record.tableHeaders.customer'), width: 1.8 },
              { label: t('common.phone'), width: 1.3 },
              { label: t('record.tableHeaders.type'), width: 1 },
              { label: t('common.status'), width: 1 },
              { label: t('common.total'), width: 1, align: 'right' },
              { label: t('record.paid'), width: 1, align: 'right' },
              { label: t('record.remaining'), width: 1.1, align: 'right' },
            ],
            rows: filteredOrders.map((order) => {
              const createdAt = new Date(order.createdAt);
              const customerName = order.orderType === 'DineIn'
                ? (order.table ? t('record.tableLabel', { table: order.table }) : t('record.dineInCustomer'))
                : order.customer?.name || t('record.walkInCustomer');
              return [
                `#${order.dailyOrderNumber ?? order.id.slice(-4)}`,
                createdAt.toLocaleDateString('en-CA'),
                createdAt.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }),
                customerName,
                order.customer?.phone || '',
                order.orderType,
                order.status,
                formatMoney(order.total),
                formatMoney(order.paidAmount ?? 0),
                formatMoney(order.remainingAmount ?? 0),
              ];
            }),
            emptyMessage: t('record.export.noOrdersInSelection'),
          },
        ]}
      />
    );

    await downloadPdfDocument(doc, `record_${isCustomRange ? `${rangeFrom}_to_${rangeTo}` : 'current-shift'}.pdf`);
  }

  const counts = useMemo(() => {
    // Pending is intentionally the unbounded, always-current count (see
    // allPendingOrders above) rather than dayOrders' shift-scoped one - so
    // this badge always matches exactly what clicking the Pending tab
    // actually shows, old shifts included.
    const base: Record<StatusFilter, number> = { All: 0, pending: allPendingOrders.length, completed: 0, paid: 0, cancelled: 0 };
    dayOrders.forEach((order) => {
      // Kept in sync with filteredOrders' own 'All' filter above - cancelled
      // orders don't count toward the All badge either.
      if (order.status !== 'cancelled') base.All += 1;
      if (order.status === 'pending') return;
      if (order.status in base) base[order.status as StatusFilter] += 1;
    });
    return base;
  }, [dayOrders, allPendingOrders]);

  // Cancelled orders never actually charged the customer, so they're left
  // out here exactly like backend/controllers/shopSessionController.js's
  // summarizeOrders() leaves them out of totalDiscount - this figure should
  // always match what a shift-close summary would show for the same day.
  const totalDiscountToday = useMemo(() => {
    return dayOrders
      .filter((order) => order.status !== 'cancelled')
      .reduce((sum, order) => sum + Number(order.discount?.amount || 0), 0);
  }, [dayOrders]);

  const discountedOrderCount = useMemo(() => {
    return dayOrders.filter((order) => order.status !== 'cancelled' && Number(order.discount?.amount || 0) > 0).length;
  }, [dayOrders]);

  // Per-item breakdown for the same window RecordPage already scopes
  // everything else to (the current/last shop shift, or the picked date
  // range) - cancelled orders are excluded for the same reason they're
  // excluded from totalDiscountToday/orderStats above: they were never
  // actually charged. Grouped by name+variation so "Fries (Large)" and
  // "Fries (Small)" are tallied separately, same composite key convention
  // used by the backend's computeKitchenIncreaseDelta.
  const itemSales = useMemo(() => {
    const map = new Map<string, { name: string; variation: string; qty: number; revenue: number; cashAmount: number; bankAmount: number; dueAmount: number }>();
    dayOrders
      .filter((order) => order.status !== 'cancelled')
      .forEach((order) => {
        // Payment (paid vs still-due) is only ever recorded at the ORDER
        // level - paidAmount/remainingAmount - never per line item. To show
        // a Cash/Bank/Udhaar split per item and per category, this order's
        // own paid share is prorated down across its items by each item's
        // share of the order total (e.g. an order that's 60% paid splits
        // every one of its items 60% paid / 40% due). Clamped to 0-1 so a
        // rounding edge case (paidAmount slightly over total) can't push a
        // line's paid share past its own revenue. Whether that paid share
        // is Cash or Bank money is decided by the order's own
        // paymentMethod - same "paymentMethod === 'Bank' -> bank, else ->
        // cash" rule reportController.js's getDashboardSummary already
        // uses for saleOnCash/saleOnBank, so this always foots against the
        // Dashboard's own figures.
        const orderTotal = Number(order.total) || 0;
        const orderPaid = Number(order.paidAmount) || 0;
        const paidRatio = orderTotal > 0 ? Math.min(Math.max(orderPaid / orderTotal, 0), 1) : 0;
        const isBankOrder = order.paymentMethod === 'Bank';
        order.items.forEach((item) => {
          const key = `${item.name}::${item.variation || ''}`;
          const entry = map.get(key) || { name: item.name, variation: item.variation || '', qty: 0, revenue: 0, cashAmount: 0, bankAmount: 0, dueAmount: 0 };
          const lineRevenue = (Number(item.price) || 0) * (Number(item.quantity) || 0);
          const paidShare = lineRevenue * paidRatio;
          entry.qty += Number(item.quantity) || 0;
          entry.revenue += lineRevenue;
          if (isBankOrder) entry.bankAmount += paidShare;
          else entry.cashAmount += paidShare;
          entry.dueAmount += lineRevenue * (1 - paidRatio);
          map.set(key, entry);
        });
      });
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [dayOrders]);

  // Rolls itemSales up one more level, by category (Ice Cream, Shwarma,
  // Drinks, ...) - looked up per name+variation via categoryByItem, falling
  // back to name-only, then finally an "Uncategorized" bucket for any item
  // that no longer matches a product in the catalog at all (deleted since).
  const categorySales = useMemo(() => {
    const map = new Map<string, { category: string; qty: number; revenue: number; cashAmount: number; bankAmount: number; dueAmount: number }>();
    itemSales.forEach((item) => {
      const category =
        categoryByItem.get(`${item.name}::${item.variation}`) ||
        categoryByItem.get(item.name) ||
        'Uncategorized';
      const entry = map.get(category) || { category, qty: 0, revenue: 0, cashAmount: 0, bankAmount: 0, dueAmount: 0 };
      entry.qty += item.qty;
      entry.revenue += item.revenue;
      entry.cashAmount += item.cashAmount;
      entry.bankAmount += item.bankAmount;
      entry.dueAmount += item.dueAmount;
      map.set(category, entry);
    });
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [itemSales, categoryByItem]);

  // Whenever the underlying window/filters actually change, each table's
  // own "Load More" progress would otherwise be showing a stale/
  // inconsistent slice of a now-different list - snap all three back to
  // the first 10 rows. Deliberately depends on the FILTER inputs
  // (date range, status, search) rather than on dayOrders/orders
  // themselves: the 45s background poll (see loadAny's setInterval above)
  // calls setOrders() with a brand new array reference on every tick even
  // when the actual order list hasn't changed, which was resetting
  // "Load More" progress back to 10 rows every 45 seconds - the person
  // scrolled down, clicked Load More, and a moment later got yanked back
  // to the top with the button reappearing. Reacting only to the filter
  // identifiers means a poll landing mid-browse no longer disturbs it;
  // reload the page (or actually change a filter) if a fresh count is
  // wanted.
  useEffect(() => {
    setVisibleItemSalesCount(10);
    setVisibleCategorySalesCount(10);
  }, [isCustomRange, rangeFrom, rangeTo, categoryByItem]);

  useEffect(() => {
    setVisibleOrdersCount(10);
  }, [isCustomRange, rangeFrom, rangeTo, statusFilter, search, searchField]);

  const visibleItemSales = itemSales.slice(0, visibleItemSalesCount);
  const visibleCategorySales = categorySales.slice(0, visibleCategorySalesCount);
  const visibleOrders = filteredOrders.slice(0, visibleOrdersCount);

  const canCancel = hasPermission('sales.delete');
  const navigate = useNavigate();
  // Same permission gate as the /dashboard/sales/:id/edit route itself
  // (see EditOrderPage.tsx's own <RequirePermission>) - mirrored here
  // purely for UX so a button that would just get redirected/blocked
  // isn't shown at all; never a substitute for that route guard. This
  // Edit entry point briefly went missing from Record's row/modal actions
  // during an unrelated Table/Type-column cleanup - restored here.
  const canEditOrders = hasPermission('sales.create') || hasPermission('sales.edit');

  function handleEditOrder(order: SavedOrder) {
    navigate(`/dashboard/sales/${order.id}/edit`);
  }

  // Delete = cancel this order directly, no confirm popup and no reason
  // prompt - the shop owner explicitly asked for a one-click delete with
  // just a toast, dropping the CancelOrderModal step entirely for this
  // flow (see backend/controllers/orderController.js's cancelOrderCore,
  // which already restores stock and keeps dues/reports consistent for
  // any order status - this just calls it immediately instead of via that
  // modal). Access control is unchanged: only staff with the sales.delete
  // permission ever see the Delete button that calls this (canCancel
  // below), and the backend enforces that same permission independently.
  async function handleDeleteOrder(order: SavedOrder) {
    if (deletingOrderIds.has(order.id)) return;
    setDeletingOrderIds((previous) => new Set(previous).add(order.id));
    try {
      let updated: SavedOrder;
      if (isDesktopApp()) {
        const actor = { name: getAuthUser()?.name || getAuthUser()?.username };
        updated = await saveOrderCancelOffline(order, '', undefined, actor);
        const categoryLookup = await getCancelCategoryLookup(true);
        printKitchenCancelTicket(updated, toast, categoryLookup);
        triggerBackgroundSync();
      } else {
        updated = await cancelOrder(order.id, {});
        const categoryLookup = await getCancelCategoryLookup(false);
        printKitchenCancelTicket(updated, toast, categoryLookup);
      }
      localEditVersionRef.current += 1;
      setOrders((previous) => previous.map((existing) => (existing.id === updated.id ? updated : existing)));
      setViewOrder((current) => (current && current.id === updated.id ? updated : current));
      toast.success(t('record.toast.orderCancelled'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('record.errors.cancelFailed'));
    } finally {
      setDeletingOrderIds((previous) => {
        const next = new Set(previous);
        next.delete(order.id);
        return next;
      });
    }
  }

  // Closing an order out from here is the whole point of this page's
  // Complete Order action (see the user request it was built for): once
  // this order's status flips off "pending", POSPage's own occupied-table
  // poll (every 15s, plus right after its own saves) will pick this table
  // back up as free the next time it checks - nothing further needed here
  // besides reflecting the change in this page's own list/detail view.
  function handleOrderCompleted(updated: SavedOrder) {
    localEditVersionRef.current += 1;
    setOrders((previous) => previous.map((order) => (order.id === updated.id ? updated : order)));
    setCompleteOrderTarget(null);
    setViewOrder((current) => (current && current.id === updated.id ? updated : current));
  }

  return (
    <div className="space-y-4">
      {loadError ? (
        <div className="flex items-center gap-2 rounded-[16px] bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          <WifiOff size={16} className="shrink-0" /> {loadError}
        </div>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t('record.title')}</h1>
          <p className="text-xs text-gray-400">
            {isCustomRange
              ? t('record.subtitle.customRange', { from: rangeFrom, to: rangeTo })
              : shopSession
                ? t('record.subtitle.shiftOrders', { shift: shopSession.status === 'open' ? t('record.subtitle.currentOpenShift') : t('record.subtitle.lastShift') })
                : t('record.subtitle.noShift')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportExcel}
            disabled={filteredOrders.length === 0}
            className="flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={14} /> {t('record.actions.exportExcel')}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filteredOrders.length === 0}
            className="flex items-center gap-2 rounded-full bg-[#D6E332] px-4 py-2 text-xs font-black text-gray-900 shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={14} /> {t('record.actions.exportCsv')}
          </button>
          <button
            type="button"
            onClick={() => void exportPdf()}
            disabled={filteredOrders.length === 0}
            className="flex items-center gap-2 rounded-full bg-rose-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={14} /> {t('record.actions.downloadPdf')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label={t('record.stats.totalOrders')} value={String(orderStats.totalOrders)} />
        <StatCard label={t('record.stats.totalAmount')} value={`Rs ${orderStats.totalAmount}`} tone="text-sky-600" />
        <StatCard label={t('record.stats.paidAmount')} value={`Rs ${orderStats.paidAmount}`} tone="text-emerald-600" />
        <StatCard label={t('record.stats.cashAmount')} value={`Rs ${orderStats.cashAmount}`} tone="text-teal-600" />
        <StatCard label={t('record.stats.bankAmount')} value={`Rs ${orderStats.bankAmount}`} tone="text-indigo-600" />
        <StatCard label={t('record.stats.remainingAmount')} value={`Rs ${orderStats.remainingAmount}`} tone="text-rose-600" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setStatusFilter(tab.key)}
            className={`rounded-[16px] p-2.5 text-left rtl:text-right transition ${statusFilter === tab.key ? 'glass-dark' : 'glass text-gray-700 hover:bg-white/70'}`}
          >
            <p className={`text-[9px] font-black uppercase tracking-[0.14em] ${statusFilter === tab.key ? 'text-gray-300' : 'text-gray-400'}`}>{t(statusLabelKey(tab.key))}</p>
            <p className="text-lg font-black">{counts[tab.key]}</p>
          </button>
        ))}
      </div>

      <div className="rounded-[16px] bg-rose-50/60 p-3 shadow-inner backdrop-blur-xl sm:flex sm:items-center sm:justify-between">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-rose-500">{t('record.discount.totalToday')}</p>
          <p className="text-lg font-black text-rose-700">Rs {totalDiscountToday}</p>
        </div>
        <p className="mt-1 text-xs font-semibold text-rose-500 sm:mt-0">
          {discountedOrderCount === 1
            ? t('record.discount.orderSingular', { count: discountedOrderCount })
            : t('record.discount.orderPlural', { count: discountedOrderCount })}
        </p>
      </div>

      <div className="glass grid grid-cols-1 gap-3 rounded-[28px] p-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="lg:col-span-2">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="block text-[10px] font-black uppercase tracking-[0.14em] text-gray-400">{t('record.filters.dateRange')}</label>
            {isCustomRange ? (
              <button
                type="button"
                onClick={clearRange}
                className="flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.1em] text-gray-400 transition hover:text-gray-700"
              >
                <X size={11} /> {t('record.filters.backToShift')}
              </button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <input
              type="date"
              value={rangeFrom}
              max={todayKey}
              onChange={(event) => setRangeFrom(event.target.value)}
              className="w-full min-w-0 rounded-full border border-white/60 bg-white/50 px-2.5 py-2 text-xs font-semibold shadow-inner outline-none transition focus:border-[#D6E332]"
            />
            <input
              type="date"
              value={rangeTo}
              max={todayKey}
              onChange={(event) => setRangeTo(event.target.value)}
              className="w-full min-w-0 rounded-full border border-white/60 bg-white/50 px-2.5 py-2 text-xs font-semibold shadow-inner outline-none transition focus:border-[#D6E332]"
            />
          </div>
        </div>

        <div className="lg:col-span-1">
          <label className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.14em] text-gray-400">{t('record.filters.searchBy')}</label>
          <select
            value={searchField}
            onChange={(event) => setSearchField(event.target.value as SearchField)}
            className="w-full rounded-full border border-white/60 bg-white/50 px-3 py-2 text-xs font-semibold shadow-inner outline-none transition focus:border-[#D6E332]"
          >
            <option value="all">{t('record.filters.allFields')}</option>
            <option value="name">{t('record.filters.customerName')}</option>
            <option value="phone">{t('common.phone')}</option>
            <option value="orderId">{t('record.orderIdLabel')}</option>
          </select>
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <label className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.14em] text-gray-400">{t('common.search')}</label>
          <div className="relative">
            <Search className="absolute left-4 rtl:left-auto rtl:right-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('record.filters.searchPlaceholder')}
              className="w-full rounded-full border border-white/60 bg-white/50 py-2 pl-11 pr-4 rtl:pl-4 rtl:pr-11 text-sm shadow-inner outline-none transition focus:border-[#D6E332]"
            />
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[20px] bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-3">
          <h2 className="text-sm font-black text-gray-900">{t('record.categorySales.title')}</h2>
          <p className="text-[11px] font-semibold text-gray-400">
            {t('record.categorySales.description', { scope: isCustomRange ? t('record.scope.selectedRange') : t('record.scope.thisShift') })}
          </p>
        </div>
        {categorySales.length === 0 ? (
          <div className="p-6 text-center text-sm font-bold text-gray-400">{t('record.noItemsSold')}</div>
        ) : (
          <div>
            <div className="hidden grid-cols-[1.2fr_0.5fr_0.7fr_0.7fr_0.7fr_0.7fr] gap-2 border-b border-gray-100 bg-[#FAFBFC] px-5 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-gray-400 sm:grid">
              <span>{t('common.category')}</span>
              <span>{t('record.qtySold')}</span>
              <span>{t('record.revenue')}</span>
              <span>{t('record.cashAmount')}</span>
              <span>{t('record.bankAmount')}</span>
              <span>{t('record.dueAmount')}</span>
            </div>
            <div className="divide-y divide-gray-100">
              {visibleCategorySales.map((entry) => (
                <div
                  key={entry.category}
                  className="grid grid-cols-2 gap-2 px-5 py-3 text-sm sm:grid-cols-[1.2fr_0.5fr_0.7fr_0.7fr_0.7fr_0.7fr] sm:items-center"
                >
                  <span className="font-bold text-gray-800">{entry.category}</span>
                  <span className="font-semibold text-gray-700">{entry.qty}</span>
                  <span className="font-black text-emerald-600">Rs {Math.round(entry.revenue)}</span>
                  <span className="font-black text-sky-600">Rs {Math.round(entry.cashAmount)}</span>
                  <span className="font-black text-indigo-600">Rs {Math.round(entry.bankAmount)}</span>
                  <span className="font-black text-rose-600">Rs {Math.round(entry.dueAmount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {categorySales.length > visibleCategorySales.length ? (
          <div className="flex justify-center border-t border-gray-100 py-3">
            <button
              type="button"
              onClick={() => setVisibleCategorySalesCount((previous) => previous + 10)}
              className="rounded-full bg-[#F6F7FB] px-5 py-2 text-xs font-black text-gray-700 transition hover:bg-gray-100"
            >
              {t('record.loadMore', { count: categorySales.length - visibleCategorySales.length })}
            </button>
          </div>
        ) : null}

        <div className="border-t border-gray-100 px-5 py-3">
          <h2 className="text-sm font-black text-gray-900">{t('record.itemSales.title')}</h2>
          <p className="text-[11px] font-semibold text-gray-400">
            {t('record.itemSales.description', { scope: isCustomRange ? t('record.scope.selectedRange') : t('record.scope.thisShift') })}
          </p>
        </div>
        {itemSales.length === 0 ? (
          <div className="p-6 text-center text-sm font-bold text-gray-400">{t('record.noItemsSold')}</div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <div className="hidden grid-cols-[1.1fr_0.6fr_0.4fr_0.6fr_0.6fr_0.6fr_0.6fr] gap-2 border-b border-gray-100 bg-[#FAFBFC] px-5 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-gray-400 sm:grid">
              <span>{t('record.item')}</span>
              <span>{t('record.variation')}</span>
              <span>{t('record.qtySold')}</span>
              <span>{t('record.revenue')}</span>
              <span>{t('record.cashAmount')}</span>
              <span>{t('record.bankAmount')}</span>
              <span>{t('record.dueAmount')}</span>
            </div>
            <div className="divide-y divide-gray-100">
              {visibleItemSales.map((item) => (
                <div
                  key={`${item.name}::${item.variation}`}
                  className="grid grid-cols-2 gap-2 px-5 py-3 text-sm sm:grid-cols-[1.1fr_0.6fr_0.4fr_0.6fr_0.6fr_0.6fr_0.6fr] sm:items-center"
                >
                  <span className="font-bold text-gray-800">{item.name}</span>
                  <span className="text-xs text-gray-400">{item.variation || '—'}</span>
                  <span className="font-semibold text-gray-700">{item.qty}</span>
                  <span className="font-black text-emerald-600">Rs {Math.round(item.revenue)}</span>
                  <span className="font-black text-sky-600">Rs {Math.round(item.cashAmount)}</span>
                  <span className="font-black text-indigo-600">Rs {Math.round(item.bankAmount)}</span>
                  <span className="font-black text-rose-600">Rs {Math.round(item.dueAmount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {itemSales.length > visibleItemSales.length ? (
          <div className="flex justify-center border-t border-gray-100 py-3">
            <button
              type="button"
              onClick={() => setVisibleItemSalesCount((previous) => previous + 10)}
              className="rounded-full bg-[#F6F7FB] px-5 py-2 text-xs font-black text-gray-700 transition hover:bg-gray-100"
            >
              {t('record.loadMore', { count: itemSales.length - visibleItemSales.length })}
            </button>
          </div>
        ) : null}
      </div>

      <div className="glass overflow-hidden rounded-[28px]">
        <div className="hidden grid-cols-[90px_1.6fr_0.9fr_0.9fr_0.9fr_0.9fr_150px] gap-2 border-b border-white/40 px-6 py-3 text-[10px] font-black uppercase tracking-[0.14em] text-gray-400 lg:grid">
          <span>{t('record.tableHeaders.order')}</span>
          <span>{t('record.tableHeaders.customer')}</span>
          <span>{t('common.total')}</span>
          <span>{t('record.paid')}</span>
          <span>{t('record.remaining')}</span>
          <span>{t('common.status')}</span>
          <span className="text-right rtl:text-left">{t('common.actions')}</span>
        </div>

        {loading ? (
          <div className="p-10 text-center text-sm font-bold text-gray-400">{t('record.loadingRecord')}</div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-10 text-center text-sm font-bold text-gray-400">{t('record.noOrdersFound')}</div>
        ) : (
          <div className="divide-y divide-white/40">
            {visibleOrders.map((order) => (
              <RecordRow
                key={order.id}
                order={order}
                canEdit={canEditOrders}
                onView={() => setViewOrder(order)}
                onComplete={() => setCompleteOrderTarget(order)}
                onEdit={() => handleEditOrder(order)}
                onDelete={() => void handleDeleteOrder(order)}
                deleting={deletingOrderIds.has(order.id)}
                toast={toast}
              />
            ))}
          </div>
        )}
        {filteredOrders.length > visibleOrders.length ? (
          <div className="flex justify-center border-t border-gray-100 py-3">
            <button
              type="button"
              onClick={() => setVisibleOrdersCount((previous) => previous + 10)}
              className="rounded-full bg-[#F6F7FB] px-5 py-2 text-xs font-black text-gray-700 transition hover:bg-gray-100"
            >
              {t('record.loadMore', { count: filteredOrders.length - visibleOrders.length })}
            </button>
          </div>
        ) : null}
      </div>

      {viewOrder ? (
        <OrderDetailModal
          order={viewOrder}
          canCancel={canCancel}
          canEdit={canEditOrders}
          deleting={deletingOrderIds.has(viewOrder.id)}
          onClose={() => setViewOrder(null)}
          onCancelRequested={() => void handleDeleteOrder(viewOrder)}
          onCompleteRequested={() => setCompleteOrderTarget(viewOrder)}
          onEditRequested={() => handleEditOrder(viewOrder)}
        />
      ) : null}

      {completeOrderTarget ? (
        <CompleteOrderModal
          order={completeOrderTarget}
          isOnline={isOnline}
          toast={toast}
          onClose={() => setCompleteOrderTarget(null)}
          onCompleted={handleOrderCompleted}
        />
      ) : null}
    </div>
  );
}

function RecordRow({
  order,
  canEdit,
  onView,
  onComplete,
  onEdit,
  onDelete,
  deleting,
  toast,
}: {
  order: SavedOrder;
  canEdit: boolean;
  onView: () => void;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
  toast: ToastLike;
}) {
  const { t } = useLanguage();
  const time = new Date(order.createdAt).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
  // A shift can run past midnight, so a bare time ("11:42 PM") is ambiguous
  // once a date range spans more than one day - the date underneath makes
  // it unambiguous which day each order actually belongs to.
  const date = new Date(order.createdAt).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' });
  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);
  const customerName = order.orderType === 'DineIn' ? (order.table ? t('record.tableLabel', { table: order.table }) : t('record.dineInCustomer')) : order.customer?.name || t('record.walkInCustomer');

  return (
    <div className="grid grid-cols-2 gap-2 px-6 py-4 text-sm lg:grid-cols-[90px_1.6fr_0.9fr_0.9fr_0.9fr_0.9fr_150px] lg:items-center">
      <div>
        <p className="font-black text-gray-900">#{orderLabel}</p>
        <p className="text-[11px] font-semibold text-gray-400">{time}</p>
        <p className="text-[10px] font-semibold text-gray-400">{date}</p>
      </div>
      {/* Table (for DineIn) and Type were dropped from this main list per
          the shop owner's request - both are still shown in full inside
          the View/Order Detail modal below, just not as their own top-
          level columns here any more. */}
      <div className="truncate">
        <p className="truncate font-bold text-gray-800">{customerName}</p>
        <p className="truncate text-[11px] text-gray-400">{order.customer?.phone || '—'}</p>
      </div>
      <div>
        <span className="font-black text-gray-900">Rs {order.total}</span>
        {order.discount && order.discount.amount > 0 ? (
          <p className="text-[10px] font-bold text-rose-500">{t('record.discount.off', { amount: order.discount.amount })}</p>
        ) : null}
      </div>
      <span className="font-semibold text-emerald-600">Rs {order.paidAmount ?? 0}</span>
      <span className="font-semibold text-rose-500">Rs {order.remainingAmount ?? 0}</span>
      <div>
        <StatusBadge status={order.status} />
      </div>
      <div className="flex justify-end gap-1.5 lg:justify-end">
        {order.status === 'pending' ? (
          <button
            type="button"
            onClick={onComplete}
            title={t('record.actions.completeOrderTitle')}
            className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-2 text-[11px] font-black text-emerald-700 transition hover:bg-emerald-100"
          >
            <CheckCircle2 size={13} />
          </button>
        ) : null}
        {order.status !== 'cancelled' && canEdit ? (
          <button
            type="button"
            onClick={onEdit}
            title={t('record.actions.editOrderTitle')}
            className="flex items-center gap-1.5 rounded-full bg-sky-50 px-3 py-2 text-[11px] font-black text-sky-700 transition hover:bg-sky-100"
          >
            <Edit3 size={13} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onView}
          title={t('record.actions.viewOrderTitle')}
          className="glass-pill flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-black text-gray-700 transition hover:bg-white/70"
        >
          <Eye size={13} />
        </button>
        <button
          type="button"
          // Direct-IPC-else-fallback-page, same as everywhere else - prints
          // immediately on this till's own counter printer instead of
          // always routing through the Manual Print Center page just to
          // print something this till can already print itself. Manual
          // Print Center is still what opens as the fallback when there's
          // no configured printer / this isn't the Electron app.
          onClick={() => void printCustomerReceipt(order, 0, toast)}
          title={t('record.actions.printReceiptTitle')}
          className="flex items-center gap-1.5 rounded-full bg-[#F6F7FB] px-3 py-2 text-[11px] font-black text-gray-700 transition hover:bg-gray-100"
        >
          <Printer size={13} />
        </button>
        {/* Delete = cancel this order (any status except already-cancelled)
            immediately, one click, no confirm popup or reason prompt - the
            shop owner explicitly asked for this instead of the earlier
            Cancel Order Key/reason modal. The backend (cancelOrderCore)
            already restores this order's stock and keeps dues/reports
            consistent whether it was pending or already completed, so this
            button just calls that directly (see handleDeleteOrder above)
            and a toast confirms it. */}
        {order.status !== 'cancelled' ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            title={t('record.actions.deleteOrderTitle')}
            className="flex items-center gap-1.5 rounded-full bg-rose-50 px-3 py-2 text-[11px] font-black text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone = 'text-gray-900' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-[16px] bg-white p-3 shadow-sm">
      <p className="text-[9px] font-black uppercase tracking-[0.14em] text-gray-400">{label}</p>
      <p className={`text-lg font-black ${tone}`}>{value}</p>
    </div>
  );
}

// StatusBadge and OrderDetailModal now live in their own shared file
// (src/components/OrderDetailModal.tsx) so DuesPage.tsx's "View" action on
// its History timeline can show an order in the exact same style, instead
// of re-building a lookalike - see that file's own header comment.

// CompleteOrderModal now lives in its own shared file
// (src/components/CompleteOrderModal.tsx) so POSPage.tsx can show the exact
// same "collect payment" popup right after Save - see that file's own
// header comment for the full reasoning.
