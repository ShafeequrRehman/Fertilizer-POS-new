import { useEffect, useMemo, useRef, useState } from 'react';
import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';
import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Download, Eye, Lock, Printer, Search, WifiOff, X, XCircle } from 'lucide-react';
import { fetchCustomerOutstanding, fetchOrders, fetchProducts, fetchShopSessionHistory, updateOrder } from '@/lib/pos-api';
import { SavedOrder, ShopSession } from '@/lib/pos-types';
import { getStoreSettings } from '@/lib/pos-settings';
import { hasPermission } from '@/lib/auth';
import { getBusinessWindow, filterOrdersInBusinessWindow, filterOrdersInBusinessWindows, getSessionDateKey, useShopSession } from '@/lib/shop-session';
import { isDesktopApp } from '@/lib/api';
import { useNetworkStatus } from '@/lib/network-status';
import { getLocalHubStartDiagnostics, pushOrdersCache } from '@/lib/local-hub-api';
import { loadOrdersFromLocalHub, saveOrderEditOffline } from '@/lib/offline-order-helpers';
import { triggerBackgroundSync } from '@/lib/offline-sync';
import { reportPrintOutcome, ToastLike } from '@/lib/print-notify';
import { useToast } from '@/lib/toast';
import CancelOrderModal from '@/components/CancelOrderModal';
import { resolveProductImage } from '@/lib/food-images';
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
function printCustomerReceipt(order: SavedOrder, customerDue: number, toast: ToastLike, setPrintReadyUrl: (url: string | null) => void) {
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
    } catch {
      setPrintReadyUrl(`/dashboard/sales/print/${order.id}?auto=true&type=cashier`);
    }
  } else {
    setPrintReadyUrl(`/dashboard/sales/print/${order.id}?auto=true&type=cashier`);
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

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'All', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'completed', label: 'Completed' },
  { key: 'paid', label: 'Paid' },
  { key: 'cancelled', label: 'Cancelled' },
];

// The "day" here is exactly the current/most recent shop shift - the same
// shared definition used on the Dashboard and Sales page (see
// getBusinessWindow / filterOrdersInBusinessWindow in
// src/lib/shop-session.tsx, the single source of truth for this date-math)
// - not a fixed clock window. While a shift is open the window is
// [openedAt, now] and keeps growing; once closed it freezes at [openedAt,
// closedAt], so this stays "today's record" until the next Open Shop
// starts a new one.
export default function RecordPage() {
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
  // The hidden auto-print iframe for CompleteOrderModal's receipt
  // auto-print - kept up here (not inside the modal) since the modal
  // closes itself the instant completion succeeds, which would tear down
  // the iframe before PrintOrderPage.tsx inside it ever got to actually
  // call window.print() if it lived there instead. Same pattern as
  // SalesPage.tsx's own printReadyUrl.
  const [printReadyUrl, setPrintReadyUrl] = useState<string | null>(null);
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
  const [cancelOrderTarget, setCancelOrderTarget] = useState<SavedOrder | null>(null);
  const [completeOrderTarget, setCompleteOrderTarget] = useState<SavedOrder | null>(null);
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
      const reason = diagnostics && !diagnostics.started ? ` (${diagnostics.error || 'failed to start'})` : '';
      setLoadError(`Couldn't reach this till's own Local Hub${reason} - restart the app to enable offline record history.`);
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
      .filter((order) => statusFilter === 'All' || order.status === statusFilter)
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
    return { totalOrders: dayOrders.length, totalAmount, paidAmount, remainingAmount };
  }, [dayOrders]);

  function clearRange() {
    setRangeFrom('');
    setRangeTo('');
  }

  function exportCsv() {
    const header = ['Order ID', 'Date', 'Time', 'Customer', 'Phone', 'Type', 'Status', 'Total', 'Paid', 'Remaining'];
    const rows = filteredOrders.map((order) => {
      const createdAt = new Date(order.createdAt);
      const customerName = order.orderType === 'DineIn' ? (order.table ? `Table ${order.table}` : 'Dine-In Customer') : order.customer?.name || 'Walk-in Customer';
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
    const rangeLabel = isCustomRange ? `${rangeFrom} to ${rangeTo}` : 'Current Shift';
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
    const summaryRows: ExcelCell[][] = [
      [{ value: 'Sales Record', style: titleStyle }],
      [{ value: rangeLabel, style: subtitleStyle }],
      [],
      [
        { value: 'Total Orders', style: statLabelStyle },
        { value: 'Total Sales', style: statLabelStyle },
        { value: 'Paid', style: statLabelStyle },
        { value: 'Remaining', style: statLabelStyle },
      ],
      [
        { value: orderStats.totalOrders },
        { value: orderStats.totalAmount, style: moneyStyle },
        { value: orderStats.paidAmount, style: moneyStyle },
        { value: orderStats.remainingAmount, style: moneyStyle },
      ],
      [],
      [{ value: 'Category-wise Sale', style: titleStyle }],
      [
        { value: 'Category', style: headerStyle },
        { value: 'Qty Sold', style: headerStyle },
        { value: 'Revenue', style: headerStyle },
      ],
      ...categorySales.map((c): ExcelCell[] => [
        { value: c.category, style: plainStyle },
        { value: c.qty, style: plainStyle },
        { value: c.revenue, style: moneyStyle },
      ]),
      [
        { value: 'Grand Total', style: subtotalStyle },
        { value: totalCategoryQty, style: subtotalStyle },
        { value: totalCategoryRevenue, style: moneyBoldStyle },
      ],
      [],
      [{ value: 'Item-wise Sale', style: titleStyle }],
      [
        { value: 'Category', style: headerStyle },
        { value: 'Item', style: headerStyle },
        { value: 'Variation', style: headerStyle },
        { value: 'Qty Sold', style: headerStyle },
        { value: 'Revenue', style: headerStyle },
      ],
      ...categorySales.flatMap((catSummary): ExcelCell[][] =>
        (itemsByCategory.get(catSummary.category) || []).map((item): ExcelCell[] => [
          { value: catSummary.category, style: plainStyle },
          { value: item.name, style: plainStyle },
          { value: item.variation || '-', style: plainStyle },
          { value: item.qty, style: plainStyle },
          { value: item.revenue, style: moneyStyle },
        ]),
      ),
      [
        { value: 'Grand Total', style: subtotalStyle },
        { value: '', style: subtotalStyle },
        { value: '', style: subtotalStyle },
        { value: totalCategoryQty, style: subtotalStyle },
        { value: totalCategoryRevenue, style: moneyBoldStyle },
      ],
    ];
    sheets.push({ name: 'Summary', columnWidths: [140, 180, 100, 80, 100], rows: summaryRows });

    // --- One sheet per category: the combined category total sits at the
    // top (so it reads as one figure for the whole category, e.g. Pizza),
    // then every item that rolls up into it is listed below.
    categorySales.forEach((catSummary) => {
      const items = itemsByCategory.get(catSummary.category) || [];
      const rows: ExcelCell[][] = [
        [{ value: catSummary.category, style: titleStyle }],
        [],
        [
          { value: 'Total Qty Sold', style: statLabelStyle },
          { value: 'Total Revenue', style: statLabelStyle },
        ],
        [
          { value: catSummary.qty, style: moneyBoldStyle },
          { value: catSummary.revenue, style: moneyBoldStyle },
        ],
        [],
        [
          { value: 'Item', style: headerStyle },
          { value: 'Variation', style: headerStyle },
          { value: 'Qty Sold', style: headerStyle },
          { value: 'Revenue', style: headerStyle },
        ],
        ...items.map((item): ExcelCell[] => [
          { value: item.name, style: plainStyle },
          { value: item.variation || '-', style: plainStyle },
          { value: item.qty, style: plainStyle },
          { value: item.revenue, style: moneyStyle },
        ]),
      ];
      sheets.push({ name: catSummary.category, columnWidths: [180, 120, 90, 100], rows });
    });

    // --- All Orders sheet (mirrors Export CSV's columns) ---
    const orderRows: ExcelCell[][] = [
      ['Order ID', 'Date', 'Time', 'Customer', 'Phone', 'Type', 'Status', 'Total', 'Paid', 'Remaining'].map(
        (h): ExcelCell => ({ value: h, style: headerStyle }),
      ),
      ...filteredOrders.map((order): ExcelCell[] => {
        const createdAt = new Date(order.createdAt);
        const customerName =
          order.orderType === 'DineIn'
            ? order.table
              ? `Table ${order.table}`
              : 'Dine-In Customer'
            : order.customer?.name || 'Walk-in Customer';
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
      name: 'All Orders',
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
    const rangeLabel = isCustomRange ? `${rangeFrom} to ${rangeTo}` : 'Current Shift';
    const formatMoney = (value: number) => `Rs ${Math.round(value).toLocaleString()}`;

    const totalCategoryQty = categorySales.reduce((sum, c) => sum + c.qty, 0);
    const totalCategoryRevenue = categorySales.reduce((sum, c) => sum + c.revenue, 0);

    const itemsByCategory = new Map<string, typeof itemSales>();
    itemSales.forEach((item) => {
      const category =
        categoryByItem.get(`${item.name}::${item.variation}`) ||
        categoryByItem.get(item.name) ||
        'Uncategorized';
      if (!itemsByCategory.has(category)) itemsByCategory.set(category, []);
      itemsByCategory.get(category)!.push(item);
    });

    const doc = (
      <ReportPdfDocument
        title="Sales Record"
        subtitle={`${rangeLabel} · ${filteredOrders.length} order${filteredOrders.length === 1 ? '' : 's'}${statusFilter !== 'All' ? ` · ${statusFilter}` : ''}`}
        stats={[
          { label: 'Total Orders', value: String(orderStats.totalOrders) },
          { label: 'Total Amount', value: formatMoney(orderStats.totalAmount) },
          { label: 'Paid Amount', value: formatMoney(orderStats.paidAmount) },
          { label: 'Remaining Amount', value: formatMoney(orderStats.remainingAmount) },
        ]}
        tables={[
          {
            title: 'Category-wise Sale',
            columns: [
              { label: 'Category', width: 2 },
              { label: 'Qty Sold', width: 1, align: 'right' },
              { label: 'Revenue', width: 1.3, align: 'right' },
            ],
            rows: categorySales.map((c) => [c.category, String(c.qty), formatMoney(c.revenue)]),
            footer: ['Grand Total', String(totalCategoryQty), formatMoney(totalCategoryRevenue)],
            emptyMessage: 'No items sold in this selection.',
          },
          {
            title: 'Item-wise Sale',
            columns: [
              { label: 'Category', width: 1.5 },
              { label: 'Item', width: 2 },
              { label: 'Variation', width: 1.3 },
              { label: 'Qty Sold', width: 1, align: 'right' },
              { label: 'Revenue', width: 1.3, align: 'right' },
            ],
            rows: categorySales.flatMap((catSummary) =>
              (itemsByCategory.get(catSummary.category) || []).map((item) => [
                catSummary.category,
                item.name,
                item.variation || '-',
                String(item.qty),
                formatMoney(item.revenue),
              ]),
            ),
            footer: ['Grand Total', '', '', String(totalCategoryQty), formatMoney(totalCategoryRevenue)],
            emptyMessage: 'No items sold in this selection.',
          },
          {
            title: 'All Orders',
            columns: [
              { label: 'Order ID', width: 1 },
              { label: 'Date', width: 1 },
              { label: 'Time', width: 0.9 },
              { label: 'Customer', width: 1.8 },
              { label: 'Phone', width: 1.3 },
              { label: 'Type', width: 1 },
              { label: 'Status', width: 1 },
              { label: 'Total', width: 1, align: 'right' },
              { label: 'Paid', width: 1, align: 'right' },
              { label: 'Remaining', width: 1.1, align: 'right' },
            ],
            rows: filteredOrders.map((order) => {
              const createdAt = new Date(order.createdAt);
              const customerName = order.orderType === 'DineIn'
                ? (order.table ? `Table ${order.table}` : 'Dine-In Customer')
                : order.customer?.name || 'Walk-in Customer';
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
            emptyMessage: 'No orders match this selection.',
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
    const base: Record<StatusFilter, number> = { All: dayOrders.length, pending: allPendingOrders.length, completed: 0, paid: 0, cancelled: 0 };
    dayOrders.forEach((order) => {
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
    const map = new Map<string, { name: string; variation: string; qty: number; revenue: number }>();
    dayOrders
      .filter((order) => order.status !== 'cancelled')
      .forEach((order) => {
        order.items.forEach((item) => {
          const key = `${item.name}::${item.variation || ''}`;
          const entry = map.get(key) || { name: item.name, variation: item.variation || '', qty: 0, revenue: 0 };
          entry.qty += Number(item.quantity) || 0;
          entry.revenue += (Number(item.price) || 0) * (Number(item.quantity) || 0);
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
    const map = new Map<string, { category: string; qty: number; revenue: number }>();
    itemSales.forEach((item) => {
      const category =
        categoryByItem.get(`${item.name}::${item.variation}`) ||
        categoryByItem.get(item.name) ||
        'Uncategorized';
      const entry = map.get(category) || { category, qty: 0, revenue: 0 };
      entry.qty += item.qty;
      entry.revenue += item.revenue;
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

  function handleOrderCancelled(updated: SavedOrder) {
    localEditVersionRef.current += 1;
    setOrders((previous) => previous.map((order) => (order.id === updated.id ? updated : order)));
    setCancelOrderTarget(null);
    setViewOrder(updated);
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
          <h1 className="text-xl font-bold">Record</h1>
          <p className="text-xs text-gray-400">
            {isCustomRange
              ? `Showing orders from ${rangeFrom} to ${rangeTo}`
              : shopSession
                ? `Every order for ${shopSession.status === 'open' ? 'the current open shift' : "this shop's last shift"} - pending, completed, paid, and cancelled.`
                : 'No shift recorded yet. Open the shop to start today\'s record.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportExcel}
            disabled={filteredOrders.length === 0}
            className="flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={14} /> Export Excel
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filteredOrders.length === 0}
            className="flex items-center gap-2 rounded-full bg-[#D6E332] px-4 py-2 text-xs font-black text-gray-900 shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={14} /> Export CSV
          </button>
          <button
            type="button"
            onClick={() => void exportPdf()}
            disabled={filteredOrders.length === 0}
            className="flex items-center gap-2 rounded-full bg-rose-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={14} /> Download PDF
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard label="Total Orders" value={String(orderStats.totalOrders)} />
        <StatCard label="Total Amount" value={`Rs ${orderStats.totalAmount}`} tone="text-sky-600" />
        <StatCard label="Paid Amount" value={`Rs ${orderStats.paidAmount}`} tone="text-emerald-600" />
        <StatCard label="Remaining Amount" value={`Rs ${orderStats.remainingAmount}`} tone="text-rose-600" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setStatusFilter(tab.key)}
            className={`rounded-[16px] p-2.5 text-left transition ${statusFilter === tab.key ? 'glass-dark' : 'glass text-gray-700 hover:bg-white/70'}`}
          >
            <p className={`text-[9px] font-black uppercase tracking-[0.14em] ${statusFilter === tab.key ? 'text-gray-300' : 'text-gray-400'}`}>{tab.label}</p>
            <p className="text-lg font-black">{counts[tab.key]}</p>
          </button>
        ))}
      </div>

      <div className="rounded-[16px] bg-rose-50/60 p-3 shadow-inner backdrop-blur-xl sm:flex sm:items-center sm:justify-between">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-rose-500">Total Discount Today</p>
          <p className="text-lg font-black text-rose-700">Rs {totalDiscountToday}</p>
        </div>
        <p className="mt-1 text-xs font-semibold text-rose-500 sm:mt-0">{discountedOrderCount} order{discountedOrderCount === 1 ? '' : 's'} discounted this shift</p>
      </div>

      <div className="glass grid grid-cols-1 gap-3 rounded-[28px] p-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="lg:col-span-2">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="block text-[10px] font-black uppercase tracking-[0.14em] text-gray-400">Date Range</label>
            {isCustomRange ? (
              <button
                type="button"
                onClick={clearRange}
                className="flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.1em] text-gray-400 transition hover:text-gray-700"
              >
                <X size={11} /> Back to shift
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
          <label className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.14em] text-gray-400">Search By</label>
          <select
            value={searchField}
            onChange={(event) => setSearchField(event.target.value as SearchField)}
            className="w-full rounded-full border border-white/60 bg-white/50 px-3 py-2 text-xs font-semibold shadow-inner outline-none transition focus:border-[#D6E332]"
          >
            <option value="all">All Fields</option>
            <option value="name">Customer Name</option>
            <option value="phone">Phone</option>
            <option value="orderId">Order ID</option>
          </select>
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <label className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.14em] text-gray-400">Search</label>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search order #, customer, phone, table, waiter"
              className="w-full rounded-full border border-white/60 bg-white/50 py-2 pl-11 pr-4 text-sm shadow-inner outline-none transition focus:border-[#D6E332]"
            />
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[20px] bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-3">
          <h2 className="text-sm font-black text-gray-900">Category Sales</h2>
          <p className="text-[11px] font-semibold text-gray-400">
            Combined quantity and revenue per category (e.g. every Pizza item counted as one Pizza total) for{' '}
            {isCustomRange ? 'the selected range' : 'this shift'}.
          </p>
        </div>
        {categorySales.length === 0 ? (
          <div className="p-6 text-center text-sm font-bold text-gray-400">No items sold yet.</div>
        ) : (
          <div>
            <div className="hidden grid-cols-[1.5fr_0.7fr_0.9fr] gap-2 border-b border-gray-100 bg-[#FAFBFC] px-5 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-gray-400 sm:grid">
              <span>Category</span>
              <span>Qty Sold</span>
              <span>Revenue</span>
            </div>
            <div className="divide-y divide-gray-100">
              {visibleCategorySales.map((entry) => (
                <div
                  key={entry.category}
                  className="grid grid-cols-2 gap-2 px-5 py-3 text-sm sm:grid-cols-[1.5fr_0.7fr_0.9fr] sm:items-center"
                >
                  <span className="font-bold text-gray-800">{entry.category}</span>
                  <span className="font-semibold text-gray-700">{entry.qty}</span>
                  <span className="font-black text-emerald-600">Rs {entry.revenue}</span>
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
              Load More ({categorySales.length - visibleCategorySales.length} more)
            </button>
          </div>
        ) : null}

        <div className="border-t border-gray-100 px-5 py-3">
          <h2 className="text-sm font-black text-gray-900">Item Sales</h2>
          <p className="text-[11px] font-semibold text-gray-400">
            Quantity sold and revenue per item (the breakdown behind each category total above) for{' '}
            {isCustomRange ? 'the selected range' : 'this shift'}.
          </p>
        </div>
        {itemSales.length === 0 ? (
          <div className="p-6 text-center text-sm font-bold text-gray-400">No items sold yet.</div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <div className="hidden grid-cols-[1.5fr_0.8fr_0.7fr_0.9fr] gap-2 border-b border-gray-100 bg-[#FAFBFC] px-5 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-gray-400 sm:grid">
              <span>Item</span>
              <span>Variation</span>
              <span>Qty Sold</span>
              <span>Revenue</span>
            </div>
            <div className="divide-y divide-gray-100">
              {visibleItemSales.map((item) => (
                <div
                  key={`${item.name}::${item.variation}`}
                  className="grid grid-cols-2 gap-2 px-5 py-3 text-sm sm:grid-cols-[1.5fr_0.8fr_0.7fr_0.9fr] sm:items-center"
                >
                  <span className="font-bold text-gray-800">{item.name}</span>
                  <span className="text-xs text-gray-400">{item.variation || '—'}</span>
                  <span className="font-semibold text-gray-700">{item.qty}</span>
                  <span className="font-black text-emerald-600">Rs {item.revenue}</span>
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
              Load More ({itemSales.length - visibleItemSales.length} more)
            </button>
          </div>
        ) : null}
      </div>

      <div className="glass overflow-hidden rounded-[28px]">
        <div className="hidden grid-cols-[90px_70px_1.1fr_0.9fr_0.9fr_0.9fr_0.9fr_0.9fr_110px] gap-2 border-b border-white/40 px-6 py-3 text-[10px] font-black uppercase tracking-[0.14em] text-gray-400 lg:grid">
          <span>Order</span>
          <span>Table</span>
          <span>Customer</span>
          <span>Type</span>
          <span>Total</span>
          <span>Paid</span>
          <span>Remaining</span>
          <span>Status</span>
          <span className="text-right">Actions</span>
        </div>

        {loading ? (
          <div className="p-10 text-center text-sm font-bold text-gray-400">Loading record...</div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-10 text-center text-sm font-bold text-gray-400">No orders found in the selected range.</div>
        ) : (
          <div className="divide-y divide-white/40">
            {visibleOrders.map((order) => (
              <RecordRow
                key={order.id}
                order={order}
                onView={() => setViewOrder(order)}
                onComplete={() => setCompleteOrderTarget(order)}
                toast={toast}
                setPrintReadyUrl={setPrintReadyUrl}
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
              Load More ({filteredOrders.length - visibleOrders.length} more)
            </button>
          </div>
        ) : null}
      </div>

      {viewOrder ? (
        <OrderDetailModal
          order={viewOrder}
          canCancel={canCancel}
          onClose={() => setViewOrder(null)}
          onCancelRequested={() => setCancelOrderTarget(viewOrder)}
          onCompleteRequested={() => setCompleteOrderTarget(viewOrder)}
        />
      ) : null}

      {cancelOrderTarget ? (
        <CancelOrderModal order={cancelOrderTarget} onClose={() => setCancelOrderTarget(null)} onCancelled={handleOrderCancelled} />
      ) : null}

      {completeOrderTarget ? (
        <CompleteOrderModal
          order={completeOrderTarget}
          isOnline={isOnline}
          toast={toast}
          onClose={() => setCompleteOrderTarget(null)}
          onCompleted={handleOrderCompleted}
          setPrintReadyUrl={setPrintReadyUrl}
        />
      ) : null}
      {printReadyUrl ? <iframe src={printReadyUrl} className="hidden" title="Auto Print Frame" /> : null}
    </div>
  );
}

function RecordRow({
  order,
  onView,
  onComplete,
  toast,
  setPrintReadyUrl,
}: {
  order: SavedOrder;
  onView: () => void;
  onComplete: () => void;
  toast: ToastLike;
  setPrintReadyUrl: (url: string | null) => void;
}) {
  const time = new Date(order.createdAt).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
  // A shift can run past midnight, so a bare time ("11:42 PM") is ambiguous
  // once a date range spans more than one day - the date underneath makes
  // it unambiguous which day each order actually belongs to.
  const date = new Date(order.createdAt).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' });
  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);
  const customerName = order.orderType === 'DineIn' ? (order.table ? `Table ${order.table}` : 'Dine-In Customer') : order.customer?.name || 'Walk-in Customer';
  const orderType = order.orderType === 'DineIn' ? 'Dine In' : order.orderType === 'TakeAway' ? 'Take Away' : 'Delivery';

  return (
    <div className="grid grid-cols-2 gap-2 px-6 py-4 text-sm lg:grid-cols-[90px_70px_1.1fr_0.9fr_0.9fr_0.9fr_0.9fr_0.9fr_110px] lg:items-center">
      <div>
        <p className="font-black text-gray-900">#{orderLabel}</p>
        <p className="text-[11px] font-semibold text-gray-400">{time}</p>
        <p className="text-[10px] font-semibold text-gray-400">{date}</p>
      </div>
      {/* Its own dedicated column - separate from the Customer cell below,
          which already falls back to showing "Table N" as the DISPLAY name
          when no customer name was entered, but that's a label, not
          something scannable/searchable at a glance across a long list the
          way a real column is - see the user request this was added for:
          finding a specific table's still-open bill quickly. */}
      <span className="font-black text-gray-900">{order.orderType === 'DineIn' ? (order.table || '—') : '—'}</span>
      <div className="truncate">
        <p className="truncate font-bold text-gray-800">{customerName}</p>
        <p className="truncate text-[11px] text-gray-400">{order.customer?.phone || '—'}</p>
      </div>
      <span className="text-gray-600">{orderType}</span>
      <div>
        <span className="font-black text-gray-900">Rs {order.total}</span>
        {order.discount && order.discount.amount > 0 ? (
          <p className="text-[10px] font-bold text-rose-500">-Rs {order.discount.amount} off</p>
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
            title="Complete order"
            className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-2 text-[11px] font-black text-emerald-700 transition hover:bg-emerald-100"
          >
            <CheckCircle2 size={13} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onView}
          title="View order"
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
          onClick={() => printCustomerReceipt(order, 0, toast, setPrintReadyUrl)}
          title="Print receipt"
          className="flex items-center gap-1.5 rounded-full bg-[#F6F7FB] px-3 py-2 text-[11px] font-black text-gray-700 transition hover:bg-gray-100"
        >
          <Printer size={13} />
        </button>
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

function StatusBadge({ status }: { status: SavedOrder['status'] }) {
  const styles: Record<string, string> = {
    pending: 'bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950',
    completed: 'bg-gradient-to-b from-emerald-400 to-emerald-600 text-white',
    paid: 'bg-gradient-to-b from-sky-400 to-sky-600 text-white',
    cancelled: 'bg-gradient-to-b from-rose-400 to-rose-600 text-white',
  };
  return <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-2px_5px_rgba(0,0,0,0.15)] ${styles[status] || 'bg-gray-100 text-gray-600'}`}>{status}</span>;
}

function OrderDetailModal({
  order,
  canCancel,
  onClose,
  onCancelRequested,
  onCompleteRequested,
}: {
  order: SavedOrder;
  canCancel: boolean;
  onClose: () => void;
  onCancelRequested: () => void;
  onCompleteRequested: () => void;
}) {
  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);
  const customerName = order.orderType === 'DineIn' ? (order.table ? `Table ${order.table}` : 'Dine-In Customer') : order.customer?.name || 'Walk-in Customer';
  const orderType = order.orderType === 'DineIn' ? 'Dine In' : order.orderType === 'TakeAway' ? 'Take Away' : 'Delivery';
  const createdAt = new Date(order.createdAt).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);

  return (
    <div className="glass-overlay fixed inset-0 z-[130] flex items-center justify-center p-4">
      <div className="glass-strong flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col rounded-[32px]">
        <div className="flex shrink-0 items-start justify-between border-b border-white/40 p-6">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-gray-400">Order Detail</p>
            <h2 className="mt-1 text-2xl font-black text-gray-900">Order #{orderLabel}</h2>
            <p className="mt-1 text-sm text-gray-500">{createdAt}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={order.status} />
            <button type="button" onClick={onClose} className="glass-pill rounded-full p-2.5 text-gray-500 transition hover:bg-white/70 hover:text-gray-900">
              <XCircle size={18} />
            </button>
          </div>
        </div>

        <div className="space-y-5 overflow-y-auto p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <DetailBox label="Customer" value={customerName} />
            <DetailBox label={order.orderType === 'DineIn' ? 'Waiter' : 'Phone'} value={order.orderType === 'DineIn' ? (order.waiter || 'Dine In') : (order.customer?.phone || 'No phone')} />
            {order.orderType === 'DineIn' ? <DetailBox label="Table" value={order.table || '—'} /> : null}
            <DetailBox label="Order Type" value={orderType} />
            <DetailBox label="Payment Method" value={order.paymentMethod} />
            <DetailBox label="Paid" value={`Rs ${order.paidAmount ?? 0}`} />
            <DetailBox label="Remaining" value={`Rs ${order.remainingAmount ?? 0}`} />
          </div>

          {order.status === 'cancelled' ? (
            <div className="space-y-1.5 rounded-[20px] bg-rose-50/60 p-4 text-sm font-bold text-rose-700 shadow-inner">
              <div className="flex items-center gap-2">
                <AlertCircle size={16} />
                <span>This order was cancelled.</span>
              </div>
              {order.cancelledBy ? <p className="text-xs font-semibold text-rose-500">Cancelled by {order.cancelledBy}{order.cancelledAt ? ` · ${new Date(order.cancelledAt).toLocaleString('en-PK', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}` : ''}</p> : null}
              {order.cancelReason ? <p className="text-xs font-semibold text-rose-500">Reason: {order.cancelReason}</p> : null}
            </div>
          ) : null}

          <div>
            <h3 className="mb-3 text-sm font-black uppercase tracking-[0.18em] text-gray-400">Items</h3>
            <div className="space-y-2">
              {order.items.map((item, index) => (
                <div key={`${item.name}-${index}`} className="flex items-center gap-3 rounded-[18px] bg-white/45 px-4 py-3 shadow-inner">
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded-[12px] bg-slate-100 shadow-inner">
                    <img src={resolveProductImage({ image: item.image, name: item.name })} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                  </div>
                  <div className="min-w-0 flex-1"><p className="truncate font-bold text-gray-900">{item.name}</p><p className="text-xs text-gray-400">{item.variation}</p></div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-black text-gray-900">Rs {item.price * item.quantity}</p>
                    <p className="text-xs text-gray-400">Qty {item.quantity}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[20px] bg-white/50 p-4 text-sm shadow-inner">
            <DetailRow label="Subtotal" value={`Rs ${order.subtotal}`} />
            <DetailRow label="Tax" value={`Rs ${order.tax}`} />
            {order.discount && order.discount.amount > 0 ? (
              <DetailRow label={`Discount ${order.discount.type === 'percent' ? `(${order.discount.value}%)` : ''}`} value={`-Rs ${order.discount.amount}`} />
            ) : null}
            <DetailRow label="Total" value={`Rs ${order.total}`} strong />
          </div>

          {order.note ? <DetailBox label="Note" value={order.note} /> : null}
        </div>

        {order.status === 'pending' ? (
          <div className="flex shrink-0 gap-2 border-t border-white/40 p-6">
            <button
              type="button"
              onClick={onCompleteRequested}
              className="flex flex-1 items-center justify-center gap-2 rounded-[20px] border-[0.5px] border-white/30 bg-gradient-to-b from-emerald-500 to-emerald-700 px-5 py-3.5 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-4px_10px_rgba(6,78,59,0.45)] transition hover:brightness-105"
            >
              <CheckCircle2 size={16} /> Complete Order
            </button>
            {canCancel ? (
              <button
                type="button"
                onClick={onCancelRequested}
                className="flex flex-1 items-center justify-center gap-2 rounded-[20px] border-[0.5px] border-white/40 bg-gradient-to-b from-rose-500 to-rose-700 px-5 py-3.5 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-4px_10px_rgba(136,19,55,0.45)] transition hover:brightness-105"
              >
                <Lock size={16} /> Cancel Order
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DetailBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] bg-white/50 px-4 py-3 shadow-inner">
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-bold text-gray-900">{value}</p>
    </div>
  );
}

function DetailRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${strong ? 'text-base font-black text-gray-900' : 'text-sm text-gray-500'}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

// The whole point this page's Complete Order action was built for: a
// pending order - however old, from whatever previous shift - is exactly
// what's keeping one of POSPage's DineIn tables marked occupied. Settling
// it here (mirroring SalesPage.tsx's own Complete Payment flow: same
// completeAndSettle action, same claim-before-print invariant online, same
// saveOrderEditOffline split offline) is what frees that table back up.
function CompleteOrderModal({
  order,
  isOnline,
  toast,
  onClose,
  onCompleted,
  setPrintReadyUrl,
}: {
  order: SavedOrder;
  isOnline: boolean;
  toast: ToastLike;
  onClose: () => void;
  onCompleted: (updated: SavedOrder) => void;
  setPrintReadyUrl: (url: string | null) => void;
}) {
  const [paymentAmount, setPaymentAmount] = useState('');
  const [customerDue, setCustomerDue] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Same reasoning as SalesPage.tsx's Complete Payment panel - required
  // before "Confirm Payment" is allowed through with nothing typed, so an
  // accidental click can't silently leave the whole order unpaid.
  const [confirmPending, setConfirmPending] = useState(false);

  // trulyOffline only gates the live "what else does this customer owe"
  // lookup below (a cloud-only read, and only ever useful when it can be
  // trusted right now) - completing the order itself is always local-first
  // (see localFirst / settle() below), independent of actual connectivity.
  const trulyOffline = isDesktopApp() && !isOnline;
  const localFirst = isDesktopApp();

  useEffect(() => {
    async function loadDue() {
      // Same "true outstanding balance" reasoning as SalesPage's own
      // Complete Payment panel - a customer can have more than one order
      // open at once, so this rolls every OTHER unpaid order of theirs in
      // too, not just this one. Cloud-only lookup, so skipped while
      // offline - completing this order still works fine without it, it
      // just won't also collect other unrelated dues in the same payment.
      if (trulyOffline || !order.customer?.phone || order.customer.phone === '03000000000') {
        setCustomerDue(0);
        return;
      }
      try {
        const result = await fetchCustomerOutstanding(order.customer.phone, order.id);
        setCustomerDue(Number(result?.outstanding ?? 0));
      } catch {
        setCustomerDue(0);
      }
    }
    void loadDue();
  }, [order, trulyOffline]);

  const owed = Number(order.remainingAmount ?? order.total ?? 0);
  const payable = owed + customerDue;

  async function settle(full: boolean) {
    const paid = full ? payable : Number(paymentAmount || 0);
    if (!full && (paid < 0 || paid > payable)) {
      setError('Enter a valid payment amount.');
      return;
    }
    // Same reasoning as SalesPage.tsx's completeOrder - nothing typed in
    // Amount Paid is only allowed through with "Put in Pending" explicitly
    // ticked, so a stray Confirm Payment click can't silently complete the
    // order with paid=0. Typing any real amount never needs the tick.
    if (!full && paid === 0 && !confirmPending) {
      setError('Enter a payment amount, or check "Put in Pending" to confirm this order with no payment collected.');
      return;
    }
    // Same reasoning as SalesPage.tsx's completeOrder - a due left on the
    // walk-in placeholder phone (03000000000) can never be found again by
    // Customer Dues/Ledger (both look orders up by customer.phone and
    // explicitly skip that placeholder), so it's a permanently untrackable
    // debt the moment this modal closes. Require a real name + phone
    // before allowing anything less than full payment; a full payment
    // never leaves a due, so that's still unrestricted.
    if (paid < payable && (!order.customer?.phone || order.customer.phone === '03000000000' || !order.customer?.name?.trim())) {
      setError("Add the customer's name and phone number before confirming a partial payment - dues need a real customer to track them against.");
      return;
    }
    setSaving(true);
    setError('');

    const payload: Parameters<typeof updateOrder>[1] = { status: 'completed', action: 'completeAndSettle', paidAmount: paid };

    try {
      if (localFirst) {
        // Always local-first, online or not - queues to the Local Hub and
        // returns instantly instead of waiting on a live cloud round trip
        // (see SalesPage.tsx's saveUpdate for the same pattern). `false` as
        // receiptPrinted below keeps customerReceiptPrintedAt unset so the
        // printer icon still works as an on-demand reprint even after the
        // auto-print just below.
        const updated = await saveOrderEditOffline(order, payload, false, false);
        triggerBackgroundSync();
        // No auto-print here any more, for any order type - see
        // SalesPage.tsx's completeOrder for the full reasoning. Printing a
        // customer receipt is now always a deliberate, on-demand action via
        // the printer icon/button.
        toast.success(`Order completed. ${trulyOffline ? 'Will sync once back online.' : 'Syncing to the cloud...'}`);
        onCompleted(updated);
        return;
      }

      // Only ever reached from a plain browser tab now (no Local Hub to
      // queue into).
      const updated = await updateOrder(order.id, payload);
      toast.success('Order completed.');
      onCompleted(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete this order.');
    } finally {
      setSaving(false);
    }
  }

  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);
  const heading = order.orderType === 'DineIn' && order.table ? `Table ${order.table}` : `Order #${orderLabel}`;

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-[32px] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-gray-400">Complete Order</p>
            <h2 className="mt-1 text-xl font-black text-gray-900">{heading}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>

        {trulyOffline ? (
          <div className="mt-3 flex items-center gap-2 rounded-[14px] bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
            <WifiOff size={14} className="shrink-0" /> Offline - will sync to the cloud once back online.
          </div>
        ) : null}

        <div className="mt-4 rounded-[20px] bg-[#F8F9FB] p-4 text-sm">
          <DetailRow label="Order Total" value={`Rs ${order.total}`} />
          <DetailRow label="Already Paid" value={`Rs ${order.paidAmount ?? 0}`} />
          {customerDue > 0 ? <DetailRow label="Other Outstanding Dues" value={`Rs ${customerDue}`} /> : null}
          <DetailRow label="Payable Now" value={`Rs ${payable}`} strong />
        </div>

        <div className="mt-4">
          <label className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Partial Payment Amount</label>
          <input
            value={paymentAmount}
            onChange={(event) => {
              if (!/^\d*$/.test(event.target.value)) return;
              // Clamped to Payable Now as they type - same fix as
              // SalesPage.tsx's Complete Payment modal, so this field can
              // never hold an amount above what's actually owed.
              const digitsOnly = event.target.value;
              const clamped = digitsOnly === '' ? '' : String(Math.min(Number(digitsOnly), payable));
              setPaymentAmount(clamped);
              if (clamped) setConfirmPending(false);
            }}
            placeholder={`Up to Rs ${payable}`}
            className="mt-1 w-full rounded-[16px] border border-gray-200 px-4 py-3 text-sm font-bold outline-none focus:border-gray-400"
          />
        </div>

        {!paymentAmount ? (
          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-[16px] bg-amber-50 px-4 py-3 text-xs font-bold text-amber-800">
            <input
              type="checkbox"
              checked={confirmPending}
              onChange={(event) => setConfirmPending(event.target.checked)}
              className="mt-0.5"
            />
            Put in Pending - confirm with no payment collected right now (this leaves the full Rs {payable} as a due).
          </label>
        ) : null}

        {error ? <p className="mt-2 text-xs font-bold text-rose-600">{error}</p> : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => void settle(false)}
            className="rounded-[20px] bg-black px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Confirm Payment
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void settle(true)}
            className="rounded-[20px] bg-[#E2F33C] px-4 py-3 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            Pay Full
          </button>
        </div>
      </div>
    </div>
  );
}
