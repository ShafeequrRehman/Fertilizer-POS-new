
import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip,
  AreaChart, Area
} from 'recharts';
import {
  Target, Users, CheckCircle2, Clock,
  RotateCcw, XCircle, Wallet, Landmark, Package, Truck,
  ShoppingBag, Receipt, HandCoins, PiggyBank, Pencil, History as HistoryIcon, List,
} from 'lucide-react';
import { adjustCash, adjustDashboardTile, fetchCashSummary, fetchDashboardAdjustmentHistory, fetchDashboardSummary, fetchOrdersSummary, fetchProducts, fetchRecoveryHistory, fetchShopSessionHistory, type OrderSummary } from '@/lib/pos-api';
import { CashTransaction, DashboardAdjustmentHistoryEntry, DashboardAdjustmentKey, DashboardSummary, Product, RecoveryHistoryRow, SavedOrder, ShopSession } from '@/lib/pos-types';
import { getBusinessWindow, filterOrdersInBusinessWindow, useShopSession, type BusinessWindow as SessionBusinessWindow } from '@/lib/shop-session';
import { isDesktopApp } from '@/lib/api';
import { useNetworkStatus } from '@/lib/network-status';
import { loadOrdersFromLocalHub } from '@/lib/offline-order-helpers';
import { getIsDashboardHidden, hasPermission } from '@/lib/auth';
import { getFirstAccessiblePage } from '@/lib/dashboard-pages';
import { useToast } from '@/lib/toast';
import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';

type EmployeeStat = { name: string; sales: number; count: number };
type InventoryItem = { id: string | number; name: string; stock: number };
// Extends the shared window (src/lib/shop-session.ts - the single source
// of truth for the actual date-math, shared with Record/Sales) with the
// display label this page renders in the header, which is presentation
// detail specific to this page rather than something other pages need.
type BusinessWindow = SessionBusinessWindow & { label: string };
type ServiceStats = {
  totalRevenue: number;
  totalOrders: number;
  businessSales: number;
  avgValue: number;
  completed: number;
  pending: number;
  cancelled: number;
  uniqueCustomers: number;
};

// Dashboard Permission Gate: an employee whose Role has "Hide Dashboard"
// checked, OR whose resolved permissions don't include 'view.dashboard'
// (the role never granted it, or a Shop Owner explicitly revoked it for
// just this one employee via the Manage Staff override modal - see
// config/permissions.js's own comment on why these are two independent
// gates), must not be able to reach this page even by direct navigation
// (typing/bookmarking the '/dashboard' URL) - the sidebar link and every
// automatic post-login redirect already steer them elsewhere (see
// DashboardShell.tsx's nav filter and lib/dashboard-pages.ts's
// getFirstAccessiblePage), but this is the actual enforcement point for
// this one route. A thin wrapper around the real page component rather
// than an early return inside it, so the redirect decision is made BEFORE
// any of the real component's hooks/effects (data fetching, timers) ever
// run - never violates the Rules of Hooks, and never fires a network
// request for a page about to be redirected away from anyway.
export default function DashboardPageClient() {
  if (getIsDashboardHidden() || !hasPermission('view.dashboard')) {
    return <Navigate to={getFirstAccessiblePage()} replace />;
  }
  return <DashboardPageClientInner />;
}

function DashboardPageClientInner() {
  const { popup } = useToast();
  // SavedOrder from the Local Hub cache-first paint, or the narrower
  // OrderSummary shape from the live cloud poll below - stats/chart code in
  // this file only ever reads the fields both shapes have in common
  // (status/total/createdAt/customer.phone/waiter), so either is fine here.
  const [orders, setOrders] = useState<(SavedOrder | OrderSummary)[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [chartsReady, setChartsReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [shopSession, setShopSession] = useState<ShopSession | null>(null);
  const { isOnline } = useNetworkStatus();
  // The shared, cached shop-open state (see shop-session.tsx) - gives this
  // page something correct to show instantly, before its own (more
  // complete, but cloud-only) session-history fetch below has a chance to
  // land.
  const { session: cachedShopSession } = useShopSession();

  useEffect(() => {
    // Two animation frames, not a plain "run once after mount" - this page
    // can be reached mid route-transition, so on the very first paint its
    // own chart containers can still be mid-layout (computed width/height
    // briefly 0), which is exactly what produces Recharts' "width(-1)
    // height(-1)" console warning below. One rAF lands right after the
    // first real paint; the second guards against that same paint still
    // being mid-layout on slower machines.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setChartsReady(true));
    });

    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearInterval(timer);
    };
  }, []);

  // "Today's" numbers on this dashboard are defined purely by the Open
  // Shop -> Close Shop cycle (see ShopStatusControl in DashboardShell and
  // backend/controllers/shopSessionController.js) - not a fixed clock
  // window. While a shift is open, the window is [openedAt, now) and
  // ticks live; once closed, it freezes at [openedAt, closedAt) so the
  // final count for that shift stays visible until the next shift opens.
  useEffect(() => {
    if (cachedShopSession) setShopSession((current) => current ?? cachedShopSession);

    async function loadSession() {
      try {
        const history = await fetchShopSessionHistory();
        // Only ever UPGRADE to a real session here - never downgrade to null
        // just because this one poll's history array came back empty (a
        // transient blip, replica lag, etc). getBusinessWindow treats "no
        // session" as "match nothing", so a wrongful null here flashed every
        // shift-scoped stat on this dashboard to 0 a few seconds after they
        // first painted correctly from the cache, even though the shop was
        // genuinely still open the whole time.
        if (history && history.length > 0) setShopSession(history[0]);
      } catch (error) {
        console.error('Dashboard shop session fetch error', error);
      }
    }

    void loadSession();
    const intervalId = setInterval(() => void loadSession(), 45000);
    return () => clearInterval(intervalId);
  }, [cachedShopSession]);

  // Fetch products once on mount for the low-stock widget; only orders
  // (which genuinely need to feel "live" for today's sales numbers) get
  // their own interval.
  useEffect(() => {
    fetchProducts()
      .then((productsRes) => {
        if (productsRes?.products) setProducts(productsRes.products);
      })
      .catch((error) => console.error('Dashboard products fetch error', error));
  }, []);

  // Accounting Overview widgets (Total Sale, Customer Udhar/Advance, Cash
  // in Hand, Balance on Bank, Stock Value, Vendor Balance, Total Purchase/
  // Expenses/Recovery today, Sale on Cash/Bank/Credit) - one summary
  // endpoint (reportController.getDashboardSummary), refreshed on the same
  // 45s cadence as orders/session above so it stays live through a shift.
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [showAdjustCash, setShowAdjustCash] = useState(false);
  // Task 2: clicking the Cash in Hand tile opens its own history, same
  // style as Bank's. Task 1: every OTHER tile gets its own manual
  // correction (adjustTileKey) - see DashboardAdjustment.js. Task 3/1's
  // "Details" button reuses the same history modal for those tiles too
  // (historyTileKey; 'cash' is the one special case that hits /cash
  // instead of /dashboard-adjustments/:key). Task 4's Customer Advance
  // Details is its own simple list, not a khata-style history.
  const [showCashHistory, setShowCashHistory] = useState(false);
  const [adjustTileKey, setAdjustTileKey] = useState<DashboardAdjustmentKey | null>(null);
  const [historyTileKey, setHistoryTileKey] = useState<DashboardAdjustmentKey | null>(null);
  const [showCustomerAdvances, setShowCustomerAdvances] = useState(false);
  const [showRecoveryHistory, setShowRecoveryHistory] = useState(false);

  async function loadSummary() {
    try {
      const data = await fetchDashboardSummary();
      if (data) setSummary(data);
    } catch (error) {
      console.error('Dashboard accounting summary fetch error', error);
    }
  }

  useEffect(() => {
    void loadSummary();
    const intervalId = setInterval(() => void loadSummary(), 45000);
    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    // Always paints instantly from the Local Hub's cache first (see
    // offline-order-helpers.ts's loadOrdersFromLocalHub) - never a live
    // cloud call up front, so this never depends on connectivity or the
    // (laggy - see network-status.ts) isOnline flag being accurate at this
    // exact moment. The real cloud fetch below still runs whenever online,
    // in the background, refining this with up-to-date numbers and
    // refreshing the cache for next time.
    async function loadOrders() {
      if (isDesktopApp()) {
        try {
          setOrders(await loadOrdersFromLocalHub());
        } catch (error) {
          console.error('Dashboard orders cache read error', error);
        }
        if (!isOnline) return;
      }

      try {
        // This page only ever shows "today's" (current/last shift) numbers
        // via the business-window filtering below - bounding the fetch to
        // the last 14 days (a generous margin over any realistic gap
        // between shifts) keeps this 45-second poll fast regardless of how
        // much order history this shop has accumulated overall. See
        // getOrders' `since` handling in orderController.js.
        //
        // fetchOrdersSummary (not fetchOrders) - on a shop with real order
        // history, "fast regardless of history size" turned out to still
        // mean 10+ seconds once you're transferring hundreds of FULL order
        // documents (complete items array, full customer object, etc.)
        // every 45 seconds, measured via debug timing on a live shop. This
        // page only ever reads status/total/createdAt/customer.phone/waiter
        // (see the stats/businessWindowData/topEmployees useMemos below),
        // so asking the server for just those fields cuts the actual data
        // transferred by roughly the same ratio full documents were bigger
        // than that. Deliberately NOT pushed into the shared Local Hub
        // order cache (pushOrdersCache) the way it used to be - that cache
        // is what Sales/Kitchen/Record's own offline fallbacks depend on
        // having full order data in, and this summary shape would silently
        // strip that down for everyone. offline-sync.ts's own periodic
        // pushCurrentOrdersCache() (full documents, no summary flag)
        // already keeps that cache fresh independently of this page.
        const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const ordersData = await fetchOrdersSummary({ since });
        if (ordersData) {
          setOrders(ordersData);
        }
      } catch (error) {
        console.error('Dashboard orders fetch error', error);
      }
    }

    void loadOrders();

    const intervalId = setInterval(() => {
      void loadOrders();
    }, 45000);

    return () => clearInterval(intervalId);
  }, [isOnline]);

  const businessWindow = useMemo<BusinessWindow>(() => buildDashboardWindow(shopSession, currentTime), [shopSession, currentTime]);
  const businessOrders = useMemo(
    () => filterOrdersInBusinessWindow(orders, businessWindow),
    [orders, businessWindow],
  );

  const stats = useMemo<ServiceStats>(() => {
    let revenue = 0;
    let ordCount = 0;
    let comp = 0;
    let pend = 0;
    let canc = 0;
    const phones = new Set<string>();

    businessOrders.forEach((order) => {
      ordCount += 1;
      if (order.customer?.phone) phones.add(order.customer.phone);

      if (order.status === 'completed') {
        revenue += order.total;
        comp += 1;
      } else if (order.status === 'pending') {
        pend += 1;
      } else if (order.status === 'cancelled') {
        canc += 1;
      }
    });

    return {
      totalRevenue: revenue,
      totalOrders: ordCount,
      businessSales: revenue,
      avgValue: comp > 0 ? revenue / comp : 0,
      completed: comp,
      pending: pend,
      cancelled: canc,
      uniqueCustomers: phones.size,
    };
  }, [businessOrders]);

  const businessWindowData = useMemo(() => {
    if (!businessWindow.hasSession) return [];
    const data = createBusinessHourBuckets(businessWindow.start, businessWindow.end);

    businessOrders.forEach((order) => {
      if (!order.createdAt) return;
      const date = new Date(order.createdAt);
      const bucketIndex = data.findIndex((bucket) => date >= bucket.start && date < bucket.end);
      if (bucketIndex !== -1) {
        data[bucketIndex].orders += 1;
        if (order.status === 'completed') data[bucketIndex].profit += order.total * 0.4;
      }
    });

    return data.map(({ start: _start, end: _end, ...bucket }) => bucket);
  }, [businessOrders, businessWindow]);

  const topEmployees = useMemo<EmployeeStat[]>(() => {
    const map = new Map<string, EmployeeStat>();

    businessOrders.forEach((order) => {
      if (order.status !== 'completed' || !order.waiter) return;
      const employee = map.get(order.waiter) || { name: order.waiter, sales: 0, count: 0 };
      employee.sales += order.total;
      employee.count += 1;
      map.set(order.waiter, employee);
    });

    const parsed = Array.from(map.values()).sort((left, right) => right.sales - left.sales).slice(0, 3);
    return parsed.length > 0
      ? parsed
      : [
          { name: 'Fariha', sales: 0, count: 0 },
          { name: 'Ahsan Raza', sales: 0, count: 0 },
          { name: 'Rehman', sales: 0, count: 0 },
        ];
  }, [businessOrders]);

  const lowStockProducts = useMemo<InventoryItem[]>(() => {
    const sorted = [...products].sort((left, right) => left.stock - right.stock).slice(0, 3);
    return sorted.length > 0 ? sorted : [{ id: 'loading', name: 'Loading', stock: 0 }];
  }, [products]);

  const formatter = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          Dashboard <span className="text-xl">+</span>
        </h1>
        <p className="text-xs text-gray-400">Live business indicators generated from your POS transactions.</p>
        <p className={`text-xs font-bold uppercase tracking-[0.14em] ${businessWindow.isOpen ? 'text-emerald-600' : 'text-gray-500'}`}>{businessWindow.label}</p>
      </div>

      <AccountingOverview
        summary={summary}
        formatter={formatter}
        canAdjustCash={hasPermission('dues.manage')}
        onAdjustCash={() => setShowAdjustCash(true)}
        onOpenCashHistory={() => setShowCashHistory(true)}
        onAdjustTile={(key) => setAdjustTileKey(key)}
        onOpenTileHistory={(key) => setHistoryTileKey(key)}
        onOpenCustomerAdvances={() => setShowCustomerAdvances(true)}
        onOpenRecoveryHistory={() => setShowRecoveryHistory(true)}
      />

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 min-w-0 space-y-6 lg:col-span-7">
          <div className="rounded-[32px] bg-white p-6 shadow-sm">
            <h3 className="mb-6 font-bold text-gray-800">Sales Overview</h3>
            {/* Stacked on phone - a half-width card here (icon + truncated
                text) had no room left for a real revenue figure like
                "Rs 1,245,690", so it just showed "Rs 1,245..." with no way
                to see the rest. Side-by-side again from tablet width up. */}
            <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <StatCard title={`Rs ${formatter.format(stats.totalRevenue)}`} subtitle="Total Revenue" trend="Live" color="bg-orange-50 text-orange-400" icon={<Target size={20} />} />
              <StatCard title={formatter.format(stats.totalOrders)} subtitle="Total Orders" trend="Live" color="bg-purple-50 text-purple-400" icon={<Users size={20} />} />
            </div>

            <div className="relative min-w-0 overflow-hidden rounded-3xl border border-gray-50 bg-white p-4 h-48">
              <div className="relative z-10 flex items-start justify-between">
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-100 text-purple-500">
                      <Users size={16} />
                    </div>
                    <span className="text-2xl font-bold">{stats.uniqueCustomers}</span>
                  </div>
                  <p className="text-[10px] font-bold uppercase text-gray-400">Stored Database Customers</p>
                </div>
                <div className="text-right">
                  <span className="text-xl font-bold">Rs {formatter.format(stats.businessSales)}</span>
                  <p className="text-[10px] font-bold uppercase text-gray-400">Active Business Day</p>
                </div>
              </div>
              <div className="absolute inset-x-0 bottom-0 top-[72px] min-w-0">
                {chartsReady ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={businessWindowData} margin={{ top: 30, right: 0, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorYellow" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#FBBF24" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#FBBF24" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <Area type="monotone" dataKey="orders" stroke="#FBBF24" strokeWidth={3} fill="url(#colorYellow)" dot={false} />
                      <Tooltip />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : null}
              </div>
            </div>

            {/* Same reasoning as the StatCard row above - 3-across left
                almost no width per figure on a phone. */}
            <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
              <MiniStat label="Business Day Sales" value={`Rs ${formatter.format(stats.businessSales)}`} />
              <MiniStat label="Transactions" value={formatter.format(stats.totalOrders)} />
              <MiniStat label="Avg. Order" value={`Rs ${formatter.format(stats.avgValue)}`} valueColor="text-green-500" />
            </div>
          </div>

          <EmployeePerformance employees={topEmployees} formatter={formatter} />
        </div>

        <div className="col-span-12 min-w-0 space-y-6 lg:col-span-5">
          <div className="rounded-[32px] bg-white p-6 shadow-sm">
            <div className="mb-8 flex items-center justify-between">
              <h3 className="font-bold">Orders Overview</h3>
              <div className="flex gap-4 text-[10px] font-bold uppercase text-gray-400">
                <span className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-full bg-orange-400" /> Orders
                </span>
                <span className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-full bg-purple-500" /> Est Profit
                </span>
              </div>
            </div>
            <div className="h-64 min-w-0">
              {chartsReady ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={businessWindowData}>
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#9CA3AF', fontSize: 10 }} />
                    <YAxis hide />
                    <Tooltip />
                    <Line type="monotone" dataKey="orders" stroke="#FBBF24" strokeWidth={4} dot={false} />
                    <Line type="monotone" dataKey="profit" stroke="#8B5CF6" strokeWidth={4} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <StatusRing stats={stats} />
            <div className="space-y-4 rounded-[32px] bg-white p-5 shadow-sm">
              <h3 className="text-sm font-bold">Service Stats</h3>
              <ServiceRow label="Completed" value={stats.completed} percent={stats.totalOrders ? `${Math.round((stats.completed / stats.totalOrders) * 100)}%` : '0%'} color="text-green-500" icon={<CheckCircle2 size={14} />} />
              <ServiceRow label="Pending" value={stats.pending} percent={stats.totalOrders ? `${Math.round((stats.pending / stats.totalOrders) * 100)}%` : '0%'} color="text-orange-400" icon={<Clock size={14} />} />
              <ServiceRow label="Refunded" value={0} percent="0%" color="text-blue-400" icon={<RotateCcw size={14} />} />
              <ServiceRow label="Cancelled" value={stats.cancelled} percent={stats.totalOrders ? `${Math.round((stats.cancelled / stats.totalOrders) * 100)}%` : '0%'} color="text-red-400" icon={<XCircle size={14} />} />
            </div>
          </div>

          <InventoryCard products={lowStockProducts} />
        </div>
      </div>

      {showAdjustCash ? (
        <AdjustCashModal
          onClose={() => setShowAdjustCash(false)}
          onSubmit={async (amount, direction, note) => {
            try {
              const updated = await adjustCash(amount, direction, note);
              if (updated) {
                setSummary((prev: DashboardSummary | null) => (prev ? { ...prev, cashInHand: updated.balance } : prev));
                setShowAdjustCash(false);
                popup({ tone: 'success', title: 'Cash in Hand updated', message: `New balance: Rs ${updated.balance.toLocaleString()}` });
              }
            } catch (error) {
              popup({ tone: 'error', title: "Couldn't update Cash in Hand", message: error instanceof Error ? error.message : 'Failed to save.' });
            }
          }}
        />
      ) : null}

      {showCashHistory ? <CashHistoryModal onClose={() => setShowCashHistory(false)} /> : null}

      {adjustTileKey ? (
        <TileAdjustModal
          tileKey={adjustTileKey}
          onClose={() => setAdjustTileKey(null)}
          onSubmit={async (amount, direction, note) => {
            try {
              const result = await adjustDashboardTile(adjustTileKey, amount, direction, note);
              if (result) {
                setSummary((prev: DashboardSummary | null) => (prev ? { ...prev, [adjustTileKey]: result.total } : prev));
                setAdjustTileKey(null);
                popup({ tone: 'success', title: 'Updated', message: `New value: Rs ${result.total.toLocaleString()}` });
              }
            } catch (error) {
              popup({ tone: 'error', title: "Couldn't save correction", message: error instanceof Error ? error.message : 'Failed to save.' });
            }
          }}
        />
      ) : null}

      {historyTileKey ? <TileHistoryModal tileKey={historyTileKey} onClose={() => setHistoryTileKey(null)} /> : null}

      {showCustomerAdvances ? (
        <CustomerAdvancesModal advances={summary?.customerAdvances || []} onClose={() => setShowCustomerAdvances(false)} />
      ) : null}

      {showRecoveryHistory ? <RecoveryHistoryModal onClose={() => setShowRecoveryHistory(false)} /> : null}
    </div>
  );
}

// Accounting Overview - the AccCountry-style summary row the shop owner
// asked for (Total Sale, Customer Udhar/Advance, Cash in Hand, Balance on
// Bank, Stock Value, Vendor Balance, Total Purchase/Expenses/Recovery
// today, Sale on Cash/Bank/Credit). Cash in Hand is the one figure with no
// other place to fix a mistake (unlike Bank/Dues, which are already
// editable from their own pages), so it alone gets a Pencil/Adjust button
// here - gated the same way Bank/Dues actions are (dues.manage).
function AccountingOverview({
  summary,
  formatter,
  canAdjustCash,
  onAdjustCash,
  onOpenCashHistory,
  onAdjustTile,
  onOpenTileHistory,
  onOpenCustomerAdvances,
  onOpenRecoveryHistory,
}: {
  summary: DashboardSummary | null;
  formatter: Intl.NumberFormat;
  canAdjustCash: boolean;
  onAdjustCash: () => void;
  onOpenCashHistory: () => void;
  onAdjustTile: (key: DashboardAdjustmentKey) => void;
  onOpenTileHistory: (key: DashboardAdjustmentKey) => void;
  onOpenCustomerAdvances: () => void;
  onOpenRecoveryHistory: () => void;
}) {
  const money = (value: number | undefined) => `Rs ${formatter.format(value ?? 0)}`;
  // Task 1: every tile below (besides Cash in Hand, which owns its own
  // Adjust+History pair, and Balance on Bank, which is corrected from the
  // Bank page itself) gets the same Pencil (correct it) + History (see
  // past corrections) actions, wired to one shared DashboardAdjustment key.
  const actionsFor = (key: DashboardAdjustmentKey) =>
    canAdjustCash
      ? [
          { icon: <Pencil size={12} />, onClick: () => onAdjustTile(key), label: 'Adjust' },
          { icon: <HistoryIcon size={12} />, onClick: () => onOpenTileHistory(key), label: 'History' },
        ]
      : [{ icon: <HistoryIcon size={12} />, onClick: () => onOpenTileHistory(key), label: 'History' }];
  // Customer Advance / Total Recovery already have their own dedicated
  // "Details" icon (the real customer-level breakdown - onOpenCustomerAdvances/
  // onOpenRecoveryHistory) - a second, separate correction-History icon
  // there just crowded the tile with two near-identical grey circular
  // buttons for what the owner sees as the same "show me more" action, so
  // only Adjust is added here on top of Details for these two.
  const adjustOnlyFor = (key: DashboardAdjustmentKey) =>
    canAdjustCash ? [{ icon: <Pencil size={12} />, onClick: () => onAdjustTile(key), label: 'Adjust' }] : [];
  return (
    <div className="rounded-[32px] bg-white p-6 shadow-sm">
      <div className="mb-6 flex items-center justify-between">
        <h3 className="font-bold text-gray-800">Accounting Overview</h3>
        <span className="text-[10px] font-bold uppercase text-gray-400">{summary?.date || '...'}</span>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <OverviewTile icon={<Target size={18} />} color="bg-orange-50 text-orange-500" label="Total Sale (Today)" value={money(summary?.totalSaleToday)} actions={actionsFor('totalSaleToday')} />
        <OverviewTile icon={<HandCoins size={18} />} color="bg-rose-50 text-rose-500" label="Customer Udhar" value={money(summary?.customerUdharTotal)} valueColor="text-rose-600" actions={actionsFor('customerUdharTotal')} />
        <OverviewTile
          icon={<PiggyBank size={18} />}
          color="bg-emerald-50 text-emerald-500"
          label="Customer Advance"
          value={money(summary?.customerAdvanceTotal)}
          valueColor="text-emerald-600"
          actions={[
            { icon: <List size={12} />, onClick: onOpenCustomerAdvances, label: 'Details' },
            ...adjustOnlyFor('customerAdvanceTotal'),
          ]}
        />
        <OverviewTile
          icon={<Wallet size={18} />}
          color="bg-blue-50 text-blue-500"
          label="Cash in Hand"
          value={money(summary?.cashInHand)}
          onTileClick={onOpenCashHistory}
          actions={[
            { icon: <HistoryIcon size={12} />, onClick: onOpenCashHistory, label: 'History' },
            ...(canAdjustCash ? [{ icon: <Pencil size={12} />, onClick: onAdjustCash, label: 'Adjust' }] : []),
          ]}
        />
        <OverviewTile icon={<Landmark size={18} />} color="bg-indigo-50 text-indigo-500" label="Balance on Bank" value={money(summary?.balanceOnBank)} />
        <OverviewTile icon={<Package size={18} />} color="bg-violet-50 text-violet-500" label="Stock Value" value={money(summary?.stockValue)} actions={actionsFor('stockValue')} />
        <OverviewTile icon={<Truck size={18} />} color="bg-amber-50 text-amber-600" label="Vendor Balance" value={money(summary?.vendorBalance)} valueColor="text-amber-700" actions={actionsFor('vendorBalance')} />
        <OverviewTile icon={<ShoppingBag size={18} />} color="bg-slate-100 text-slate-500" label="Total Purchase (Today)" value={money(summary?.totalPurchaseToday)} actions={actionsFor('totalPurchaseToday')} />
        <OverviewTile icon={<Receipt size={18} />} color="bg-slate-100 text-slate-500" label="Total Expenses (Today)" value={money(summary?.totalExpensesToday)} actions={actionsFor('totalExpensesToday')} />
        <OverviewTile icon={<Wallet size={18} />} color="bg-blue-50 text-blue-500" label="Sale on Cash" value={money(summary?.saleOnCash)} actions={actionsFor('saleOnCash')} />
        <OverviewTile icon={<Landmark size={18} />} color="bg-indigo-50 text-indigo-500" label="Sale on Bank" value={money(summary?.saleOnBank)} actions={actionsFor('saleOnBank')} />
        <OverviewTile icon={<HandCoins size={18} />} color="bg-rose-50 text-rose-500" label="Sale on Udhar (Credit)" value={money(summary?.saleOnCredit)} valueColor="text-rose-600" actions={actionsFor('saleOnCredit')} />
        <OverviewTile
          icon={<CheckCircle2 size={18} />}
          color="bg-emerald-50 text-emerald-500"
          label="Total Recovery (Today)"
          value={money(summary?.totalRecoveryToday)}
          valueColor="text-emerald-600"
          actions={[{ icon: <List size={12} />, onClick: onOpenRecoveryHistory, label: 'Details' }, ...adjustOnlyFor('totalRecoveryToday')]}
        />
      </div>
    </div>
  );
}

function OverviewTile({
  icon,
  color,
  label,
  value,
  valueColor = 'text-gray-900',
  actions,
  onTileClick,
}: {
  icon: React.ReactNode;
  color: string;
  label: string;
  value: string;
  valueColor?: string;
  actions?: { icon: React.ReactNode; onClick: () => void; label: string }[];
  onTileClick?: () => void;
}) {
  return (
    <div
      className={`relative rounded-2xl border border-gray-50 bg-[#F8F9FB] p-4 ${onTileClick ? 'cursor-pointer transition hover:border-gray-200' : ''}`}
      onClick={onTileClick}
      role={onTileClick ? 'button' : undefined}
    >
      <div className="flex items-center justify-between">
        <div className={`rounded-full p-2 ${color}`}>{icon}</div>
        {actions && actions.length > 0 ? (
          <div className="flex gap-1">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  action.onClick();
                }}
                title={action.label}
                className="rounded-full bg-white p-1.5 text-gray-400 shadow-sm transition hover:bg-gray-100 hover:text-gray-700"
              >
                {action.icon}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <h4 className={`mt-3 truncate text-lg font-black xl:text-xl ${valueColor}`}>{value}</h4>
      <p className="truncate text-[10px] font-bold uppercase tracking-wider text-gray-400">{label}</p>
    </div>
  );
}

// Manual Cash-in-Hand correction - the owner's own explicit ask: every
// payment figure on the Dashboard must be editable so a mistake can be
// fixed. Same in/out direction idea as Bank's own addTransaction popup.
function AdjustCashModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (amount: number, direction: 'in' | 'out', note: string) => void;
}) {
  useBackspaceToClose(onClose);
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    const value = Number(amount);
    if (!value || value <= 0) return;
    setSaving(true);
    try {
      await onSubmit(value, direction, note.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-[32px] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-black text-gray-900">Adjust Cash in Hand</h2>
          <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-400">Use this only to correct a mistake in the till's cash figure.</p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDirection('in')}
            className={`rounded-[14px] py-2.5 text-xs font-black uppercase tracking-wide transition ${direction === 'in' ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-500'}`}
          >
            Add (+)
          </button>
          <button
            type="button"
            onClick={() => setDirection('out')}
            className={`rounded-[14px] py-2.5 text-xs font-black uppercase tracking-wide transition ${direction === 'out' ? 'bg-rose-500 text-white' : 'bg-gray-100 text-gray-500'}`}
          >
            Remove (-)
          </button>
        </div>

        <div className="mt-4">
          <label className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Amount</label>
          <input
            value={amount}
            onChange={(event) => {
              if (!/^\d*$/.test(event.target.value)) return;
              setAmount(event.target.value);
            }}
            placeholder="0"
            className="mt-1 w-full rounded-[16px] border border-gray-200 px-4 py-3 text-sm font-bold outline-none focus:border-gray-400"
          />
        </div>

        <div className="mt-4">
          <label className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Note (optional)</label>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why is this being corrected?"
            className="mt-1 w-full rounded-[16px] border border-gray-200 px-4 py-3 text-sm font-bold outline-none focus:border-gray-400"
          />
        </div>

        <button
          type="button"
          disabled={saving || !amount}
          onClick={() => void submit()}
          className="mt-5 w-full rounded-[20px] bg-black py-3.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Correction'}
        </button>
      </div>
    </div>
  );
}

type HistoryRangeMode = 'all' | 'today' | 'month' | 'custom';

// Shared shell for the history-style modals below (Cash in Hand / a
// generic tile's corrections) - same in/out, dated, with-note list look as
// BankPage.tsx's own transaction history, just fed from whichever endpoint
// the caller already fetched. `pdfTitle`/`pdfFilename` turn on the same
// All/Today/This Month/Custom date-range pills BankPage.tsx's own history
// uses, plus a PDF download of whatever range is currently picked - the
// owner's own ask ("download pdf ho today month aur date custom vise").
// Purely a client-side filter/render concern - the real rows and their
// balanceAfter/totalAfter are never touched, same rule every other range
// filter in this app already follows.
function HistoryModalShell({
  title,
  subtitle,
  onClose,
  loading,
  rows,
  pdfTitle,
  pdfFilename,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  loading: boolean;
  rows: { direction: 'in' | 'out'; amount: number; note: string; createdBy: string; createdAt: string; balanceAfter?: number }[];
  pdfTitle?: string;
  pdfFilename?: string;
}) {
  useBackspaceToClose(onClose);
  const enableFilterAndPdf = Boolean(pdfTitle);
  const [rangeMode, setRangeMode] = useState<HistoryRangeMode>('all');
  const [customFrom, setCustomFrom] = useState(todayDateInputValue());
  const [customTo, setCustomTo] = useState(todayDateInputValue());
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);

  const filteredRows = useMemo(() => {
    if (!enableFilterAndPdf || rangeMode === 'all') return rows;
    if (rangeMode === 'today') {
      const todayStr = todayDateInputValue();
      return rows.filter((row) => {
        const d = new Date(row.createdAt);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
    }
    if (rangeMode === 'month') {
      const now = new Date();
      return rows.filter((row) => {
        const d = new Date(row.createdAt);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      });
    }
    if (!customFrom || !customTo) return rows;
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59.999`);
    return rows.filter((row) => {
      const d = new Date(row.createdAt);
      return d >= from && d <= to;
    });
  }, [rows, enableFilterAndPdf, rangeMode, customFrom, customTo]);

  const rangeLabel =
    rangeMode === 'today' ? 'Today'
    : rangeMode === 'month' ? 'This Month'
    : rangeMode === 'custom' ? `${customFrom} to ${customTo}`
    : 'All Time';

  async function handleDownloadPdf() {
    setIsDownloadingPdf(true);
    try {
      const { ReportPdfDocument, downloadPdfDocument } = await import('@/lib/pdf-export');
      const totalIn = filteredRows.filter((r) => r.direction === 'in').reduce((sum, r) => sum + r.amount, 0);
      const totalOut = filteredRows.filter((r) => r.direction === 'out').reduce((sum, r) => sum + r.amount, 0);
      const doc = (
        <ReportPdfDocument
          title={pdfTitle || title}
          subtitle={rangeLabel}
          stats={[
            { label: 'Total In', value: `Rs ${totalIn.toLocaleString()}` },
            { label: 'Total Out', value: `Rs ${totalOut.toLocaleString()}` },
            { label: 'Net', value: `Rs ${(totalIn - totalOut).toLocaleString()}` },
          ]}
          tables={[
            {
              title: 'History',
              columns: [
                { label: 'Date', width: 1.3 },
                { label: 'Type', width: 0.8 },
                { label: 'Note', width: 1.8 },
                { label: 'By', width: 0.9 },
                { label: 'In', width: 0.9, align: 'right' },
                { label: 'Out', width: 0.9, align: 'right' },
                { label: 'Balance', width: 1, align: 'right' },
              ],
              // Balance (right-most, next to In/Out) - the owner's own ask:
              // every In/Out PDF should show the running total alongside
              // each entry, same as BankPage.tsx's own statement PDF
              // already does. This is each entry's real balanceAfter/
              // totalAfter as it was stored the moment it happened
              // (CashRegister.js / DashboardAdjustment.js) - never
              // recomputed/replayed here, so it stays correct however the
              // list is filtered or sorted.
              rows: filteredRows.map((row) => [
                new Date(row.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
                row.direction === 'in' ? 'In' : 'Out',
                row.note || '—',
                row.createdBy || '—',
                row.direction === 'in' ? `Rs ${row.amount.toLocaleString()}` : '—',
                row.direction === 'out' ? `Rs ${row.amount.toLocaleString()}` : '—',
                row.balanceAfter === undefined ? '—' : `Rs ${row.balanceAfter.toLocaleString()}`,
              ]),
              footer: ['', '', '', 'Total', `Rs ${totalIn.toLocaleString()}`, `Rs ${totalOut.toLocaleString()}`, ''],
              emptyMessage: 'No transactions in this range.',
            },
          ]}
        />
      );
      await downloadPdfDocument(doc, `${(pdfFilename || title).replace(/\s+/g, '_')}.pdf`);
    } finally {
      setIsDownloadingPdf(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-[32px] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-black text-gray-900">{title}</h2>
            <p className="mt-1 text-xs text-gray-400">{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>

        {enableFilterAndPdf ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(['all', 'today', 'month', 'custom'] as HistoryRangeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setRangeMode(mode)}
                className={`rounded-full px-3 py-1.5 text-[11px] font-black uppercase tracking-wide transition ${rangeMode === mode ? 'bg-black text-white' : 'bg-gray-100 text-gray-500'}`}
              >
                {mode === 'all' ? 'All' : mode === 'today' ? 'Today' : mode === 'month' ? 'This Month' : 'Custom'}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void handleDownloadPdf()}
              disabled={isDownloadingPdf || filteredRows.length === 0}
              className="ml-auto flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-emerald-600 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isDownloadingPdf ? 'Preparing...' : 'PDF'}
            </button>
          </div>
        ) : null}

        {enableFilterAndPdf && rangeMode === 'custom' ? (
          <div className="mt-2 flex items-center gap-2">
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold" />
            <span className="text-xs text-gray-400">to</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold" />
          </div>
        ) : null}

        <div className="mt-4 flex-1 space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <p className="py-8 text-center text-xs font-bold text-gray-400">Loading...</p>
          ) : filteredRows.length === 0 ? (
            <p className="py-8 text-center text-xs font-bold text-gray-400">No history yet.</p>
          ) : (
            filteredRows.map((row, index) => (
              <div key={index} className="flex items-center justify-between rounded-2xl bg-[#F8F9FB] p-3">
                <div className="min-w-0">
                  <p className={`text-sm font-black ${row.direction === 'in' ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {row.direction === 'in' ? '+' : '-'}Rs {row.amount.toLocaleString()}
                  </p>
                  {row.note ? <p className="truncate text-[11px] text-gray-500">{row.note}</p> : null}
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    {new Date(row.createdAt).toLocaleString()}
                    {row.createdBy ? ` · ${row.createdBy}` : ''}
                  </p>
                  {row.balanceAfter !== undefined ? (
                    <p className="text-[10px] font-bold text-gray-300">Balance after: Rs {row.balanceAfter.toLocaleString()}</p>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Task 2: clicking the Cash in Hand tile - GET /api/cash's own history[],
// same data the "Adjust" pencil's balance already comes from.
function CashHistoryModal({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<CashTransaction[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await fetchCashSummary();
      if (!cancelled && data) setHistory(data.history || []);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <HistoryModalShell
      title="Cash in Hand History"
      subtitle="Every sale, due recovery, purchase, advance and refund that moved the till."
      onClose={onClose}
      loading={loading}
      pdfTitle="Cash in Hand History"
      pdfFilename="cash_in_hand_history"
      rows={history.map((entry) => ({
        direction: entry.direction,
        amount: entry.amount,
        note: entry.note || entry.type,
        createdBy: entry.createdBy || '',
        createdAt: entry.createdAt,
        balanceAfter: entry.balanceAfter,
      }))}
    />
  );
}

// Task 1/3: history of manual corrections made to any other Accounting
// Overview tile - GET /api/dashboard-adjustments/:key/history.
function TileHistoryModal({ tileKey, onClose }: { tileKey: DashboardAdjustmentKey; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<DashboardAdjustmentHistoryEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await fetchDashboardAdjustmentHistory(tileKey);
      if (!cancelled && data) setHistory(data.history || []);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tileKey]);

  return (
    <HistoryModalShell
      title="Correction History"
      subtitle="Manual corrections made to this figure - the real transactions behind it are never changed."
      onClose={onClose}
      loading={loading}
      pdfTitle="Correction History"
      pdfFilename={`${tileKey}_correction_history`}
      rows={history.map((entry) => ({ ...entry, balanceAfter: entry.totalAfter }))}
    />
  );
}

// Task 1: the same manual +/- correction AdjustCashModal already does for
// Cash in Hand, generalized to any other tile via one shared endpoint.
function TileAdjustModal({
  tileKey,
  onClose,
  onSubmit,
}: {
  tileKey: DashboardAdjustmentKey;
  onClose: () => void;
  onSubmit: (amount: number, direction: 'in' | 'out', note: string) => void;
}) {
  useBackspaceToClose(onClose);
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    const value = Number(amount);
    if (!value || value <= 0) return;
    setSaving(true);
    try {
      await onSubmit(value, direction, note.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-[32px] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-black text-gray-900">Correct This Figure</h2>
          <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-400">This only adjusts the number shown on the Dashboard - it never touches the real orders/purchases/ledger behind it.</p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDirection('in')}
            className={`rounded-[14px] py-2.5 text-xs font-black uppercase tracking-wide transition ${direction === 'in' ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-500'}`}
          >
            Add (+)
          </button>
          <button
            type="button"
            onClick={() => setDirection('out')}
            className={`rounded-[14px] py-2.5 text-xs font-black uppercase tracking-wide transition ${direction === 'out' ? 'bg-rose-500 text-white' : 'bg-gray-100 text-gray-500'}`}
          >
            Remove (-)
          </button>
        </div>

        <div className="mt-4">
          <label className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Amount</label>
          <input
            value={amount}
            onChange={(event) => {
              if (!/^\d*$/.test(event.target.value)) return;
              setAmount(event.target.value);
            }}
            placeholder="0"
            className="mt-1 w-full rounded-[16px] border border-gray-200 px-4 py-3 text-sm font-bold outline-none focus:border-gray-400"
          />
        </div>

        <div className="mt-4">
          <label className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Note (optional)</label>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why is this being corrected?"
            className="mt-1 w-full rounded-[16px] border border-gray-200 px-4 py-3 text-sm font-bold outline-none focus:border-gray-400"
          />
        </div>

        <button
          type="button"
          disabled={saving || !amount}
          onClick={() => void submit()}
          className="mt-5 w-full rounded-[20px] bg-black py-3.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Correction'}
        </button>
      </div>
    </div>
  );
}

// Task 4: "just the customer name + their advance amount, nothing else".
function CustomerAdvancesModal({
  advances,
  onClose,
}: {
  advances: { name: string; phone: string; amount: number }[];
  onClose: () => void;
}) {
  useBackspaceToClose(onClose);
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-sm flex-col rounded-[32px] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-black text-gray-900">Customer Advances</h2>
          <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>
        <div className="mt-4 flex-1 space-y-2 overflow-y-auto pr-1">
          {advances.length === 0 ? (
            <p className="py-8 text-center text-xs font-bold text-gray-400">No customer currently has an advance.</p>
          ) : (
            advances.map((customer) => (
              <div key={customer.phone || customer.name} className="flex items-center justify-between rounded-2xl bg-[#F8F9FB] p-3">
                <p className="truncate text-sm font-bold text-gray-800">{customer.name}</p>
                <p className="text-sm font-black text-emerald-600">Rs {customer.amount.toLocaleString()}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function todayDateInputValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function firstOfMonthDateInputValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

// Task 3: Recovery "Details" - every real due-payment (Cash or Bank) any
// customer has made, with a Today/This Month/Custom/All date filter (same
// idea as IngredientStockSection.tsx's own Ledger range pills) and a CSV
// download. Recovery already flows automatically into Cash in Hand (a
// Cash-method payment) or that Bank's own balance (a Bank-method payment) -
// see customerController.settleCustomerDues - this modal is purely a read
// view of what already happened, nothing here changes any total.
type RecoveryRangeMode = 'all' | 'today' | 'month' | 'custom';

function RecoveryHistoryModal({ onClose }: { onClose: () => void }) {
  useBackspaceToClose(onClose);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<RecoveryHistoryRow[]>([]);
  const [rangeMode, setRangeMode] = useState<RecoveryRangeMode>('all');
  const [customFrom, setCustomFrom] = useState(todayDateInputValue());
  const [customTo, setCustomTo] = useState(todayDateInputValue());

  const { startDate, endDate } = useMemo(() => {
    if (rangeMode === 'today') return { startDate: todayDateInputValue(), endDate: todayDateInputValue() };
    if (rangeMode === 'month') return { startDate: firstOfMonthDateInputValue(), endDate: todayDateInputValue() };
    if (rangeMode === 'custom') return { startDate: customFrom, endDate: customTo };
    return { startDate: undefined, endDate: undefined };
  }, [rangeMode, customFrom, customTo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const data = await fetchRecoveryHistory(startDate, endDate);
      if (!cancelled && data) setRows(data.rows || []);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [startDate, endDate]);

  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);

  const rangeLabel =
    rangeMode === 'today' ? 'Today'
    : rangeMode === 'month' ? 'This Month'
    : rangeMode === 'custom' ? `${customFrom} to ${customTo}`
    : 'All Time';

  // Same "title, stats, one table" ReportPdfDocument style every other
  // history download in this app uses (Cash in Hand/Correction History's
  // own PDF, BankPage.tsx's Bank Statement) - the owner's own ask was a
  // PDF here too, in that same style, not a CSV.
  async function download() {
    setIsDownloadingPdf(true);
    try {
      const { ReportPdfDocument, downloadPdfDocument } = await import('@/lib/pdf-export');
      const doc = (
        <ReportPdfDocument
          title="Recovery History"
          subtitle={rangeLabel}
          stats={[{ label: 'Total Recovery', value: `Rs ${total.toLocaleString()}` }]}
          tables={[
            {
              title: 'History',
              columns: [
                { label: 'Date', width: 1.4 },
                { label: 'Type', width: 0.9 },
                { label: 'Note', width: 1.8 },
                { label: 'By', width: 1 },
                { label: 'In', width: 1, align: 'right' },
              ],
              rows: rows.map((row) => [
                new Date(row.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
                row.paymentMethod === 'bank' ? row.bankName || 'Bank' : 'Cash',
                `${row.customerName}${row.note ? ` - ${row.note}` : ''}`,
                row.createdBy || '\u2014',
                `Rs ${row.amount.toLocaleString()}`,
              ]),
              footer: ['', '', '', 'Total', `Rs ${total.toLocaleString()}`],
              emptyMessage: 'No recovery in this range.',
            },
          ]}
        />
      );
      await downloadPdfDocument(doc, `recovery-history-${startDate || 'all'}-to-${endDate || 'all'}.pdf`);
    } finally {
      setIsDownloadingPdf(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-[32px] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-black text-gray-900">Recovery History</h2>
            <p className="mt-1 text-xs text-gray-400">Every due payment collected from a customer, Cash or Bank.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(['all', 'today', 'month', 'custom'] as RecoveryRangeMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setRangeMode(mode)}
              className={`rounded-full px-3 py-1.5 text-[11px] font-black uppercase tracking-wide transition ${rangeMode === mode ? 'bg-black text-white' : 'bg-gray-100 text-gray-500'}`}
            >
              {mode === 'all' ? 'All' : mode === 'today' ? 'Today' : mode === 'month' ? 'This Month' : 'Custom'}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void download()}
            disabled={rows.length === 0 || isDownloadingPdf}
            className="ml-auto rounded-full bg-emerald-50 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-emerald-600 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDownloadingPdf ? 'Preparing...' : 'PDF'}
          </button>
        </div>

        {rangeMode === 'custom' ? (
          <div className="mt-2 flex items-center gap-2">
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold" />
            <span className="text-xs text-gray-400">to</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold" />
          </div>
        ) : null}

        <p className="mt-3 text-sm font-black text-emerald-600">Total: Rs {total.toLocaleString()}</p>

        <div className="mt-2 flex-1 space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <p className="py-8 text-center text-xs font-bold text-gray-400">Loading...</p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-xs font-bold text-gray-400">No recovery in this range.</p>
          ) : (
            rows.map((row, index) => (
              <div key={index} className="flex items-center justify-between rounded-2xl bg-[#F8F9FB] p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-gray-800">{row.customerName}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    {new Date(row.createdAt).toLocaleString()} · {row.paymentMethod === 'bank' ? row.bankName || 'Bank' : 'Cash'}
                  </p>
                </div>
                <p className="text-sm font-black text-emerald-600">Rs {row.amount.toLocaleString()}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, subtitle, trend, color, icon }: { title: string; subtitle: string; trend: string; color: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-3xl border border-gray-50 bg-[#F8F9FB] p-4">
      <div className={`rounded-full p-3 ${color}`}>{icon}</div>
      <div className="min-w-0">
        <h4 className="truncate text-[17px] font-black xl:text-xl">{title}</h4>
        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{subtitle}</p>
        <p className="mt-1 text-[10px] font-bold text-green-500">Live {trend}</p>
      </div>
    </div>
  );
}

function MiniStat({ label, value, valueColor = 'text-black' }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="min-w-0">
      <h4 className={`truncate text-lg font-black xl:text-2xl ${valueColor}`}>{value}</h4>
      <p className="truncate text-[10px] font-bold uppercase text-gray-400">{label}</p>
    </div>
  );
}

function EmployeePerformance({ employees, formatter }: { employees: EmployeeStat[]; formatter: Intl.NumberFormat }) {
  return (
    <div className="rounded-[32px] bg-white p-6 shadow-sm">
      <div className="mb-6 flex items-center justify-between">
        <h3 className="font-bold">Top Employee Performance</h3>
        <span className="text-[10px] font-bold uppercase text-gray-400">Sales Volume</span>
      </div>
      <div className="space-y-4">
        {employees.map((employee, index) => (
          <div key={`${employee.name}-${index}`} className="flex items-center justify-between border-b border-gray-50 py-2 last:border-0">
            <span className="text-sm font-bold text-gray-700">{employee.name}</span>
            <div className="flex gap-4 sm:gap-12">
              <span className="text-sm font-bold text-gray-400">Rs {formatter.format(employee.sales)}</span>
              <span className="w-12 text-right text-sm font-bold">{employee.count} <span className="text-[10px] text-gray-300">ord</span></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusRing({ stats }: { stats: ServiceStats }) {
  const percent = stats.totalOrders ? Math.round((stats.completed / stats.totalOrders) * 100) : 0;
  return (
    <div className="flex flex-col items-center rounded-[32px] bg-white p-5 shadow-sm">
      <h3 className="mb-4 self-start text-sm font-bold">Completion Rate</h3>
      <div className="relative mt-2 flex h-28 w-28 items-center justify-center">
        <div className="absolute inset-0 -rotate-[135deg] rounded-full border-[8px] border-cyan-400 border-r-transparent border-t-transparent" />
        <div className="absolute inset-0 rotate-45 rounded-full border-[8px] border-yellow-400 border-b-transparent border-l-transparent" />
        <div className="text-center">
          <span className="text-2xl font-black">{percent}%</span>
          <p className="text-[8px] font-bold text-gray-400">Done</p>
        </div>
      </div>
      <div className="mt-6 w-full space-y-2">
        <div className="flex justify-between text-[10px] font-bold">
          <span className="text-gray-400">Completed</span>
          <span>{stats.completed}</span>
        </div>
        <div className="flex justify-between text-[10px] font-bold">
          <span className="text-gray-400">Pending</span>
          <span>{stats.pending}</span>
        </div>
      </div>
    </div>
  );
}

function InventoryCard({ products }: { products: InventoryItem[] }) {
  const colors = ['bg-red-400', 'bg-orange-400', 'bg-blue-400'];
  return (
    <div className="rounded-[32px] bg-white p-6 shadow-sm">
      <div className="mb-6 flex items-center justify-between">
        <h3 className="font-bold">Low Inventory Alert</h3>
        <span className="text-[10px] font-bold uppercase text-gray-400">Stock</span>
      </div>
      <div className="space-y-5">
        {products.map((product, index) => (
          <InventoryBar key={String(product.id)} label={product.name} color={colors[index % 3]} value={Math.max(5, product.stock || 0)} total={product.stock || 0} />
        ))}
      </div>
    </div>
  );
}

function InventoryBar({ color, value, total, label }: { color: string; value: number; total: number; label: string }) {
  const widthVal = Math.min(100, Math.max(5, value));
  return (
    <div>
      <div className="mb-1.5 flex justify-between truncate px-1 text-[10px] font-bold text-gray-400">
        <span className="truncate">{label}</span>
        <span>{total} Left</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex h-3 flex-1 overflow-hidden rounded-lg bg-gray-100">
          <div className={`${color} h-full transition-all duration-500`} style={{ width: `${widthVal}%` }} />
        </div>
      </div>
    </div>
  );
}

function ServiceRow({ label, value, percent, color, icon }: { label: string; value: number; percent: string; color: string; icon: React.ReactNode }) {
  return (
    <div className="group flex cursor-pointer items-center justify-between">
      <div className="flex items-center gap-2">
        <div className={`rounded-full bg-gray-50 p-1.5 ${color}`}>{icon}</div>
        <span className="text-xs font-bold text-gray-500">{label}</span>
      </div>
      <div className="flex gap-4">
        <span className="text-xs font-black">{value}</span>
        <span className={`w-10 text-right text-[10px] font-bold ${color}`}>{percent}</span>
      </div>
    </div>
  );
}

function formatTime(value: Date) {
  return value.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// The dashboard's "today" is exactly one ShopSession, computed by the
// shared getBusinessWindow (src/lib/shop-session.tsx - the single source
// of truth for this date-math, also used by Record/Sales) - no fixed clock
// hours involved. This just adds the header label text on top, which is
// display detail specific to this page. `history[0]` (most recent session,
// open or closed) is passed in from the effect above.
function buildDashboardWindow(session: ShopSession | null, now: Date): BusinessWindow {
  const window = getBusinessWindow(session, now);
  if (!window.hasSession) {
    return { ...window, label: 'No shift yet — open the shop to start counting orders' };
  }

  const label = window.isOpen
    ? `Open since ${formatWindowDate(window.start)} ${formatTime(window.start)} · Live`
    : `${formatWindowDate(window.start)} ${formatTime(window.start)} - ${formatWindowDate(window.end)} ${formatTime(window.end)} · Closed`;

  return { ...window, label };
}

function createBusinessHourBuckets(start: Date, end: Date) {
  const diffHours = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60));
  const length = diffHours > 0 ? diffHours : 24;

  return Array.from({ length }, (_, index) => {
    const bucketStart = new Date(start);
    bucketStart.setHours(start.getHours() + index, 0, 0, 0);
    const bucketEnd = new Date(bucketStart);
    bucketEnd.setHours(bucketStart.getHours() + 1, 0, 0, 0);
    return {
      name: bucketStart.toLocaleTimeString('en-PK', { hour: 'numeric', hour12: true }),
      start: bucketStart,
      end: bucketEnd,
      orders: 0,
      profit: 0,
    };
  });
}

function formatWindowDate(value: Date) {
  return value.toLocaleDateString('en-PK', {
    day: '2-digit',
    month: 'short',
  });
}
