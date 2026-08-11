
import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip,
  AreaChart, Area
} from 'recharts';
import {
  Target, Users, CheckCircle2, Clock,
  RotateCcw, XCircle
} from 'lucide-react';
import { fetchOrders, fetchProducts, fetchShopSessionHistory } from '@/lib/pos-api';
import { Product, SavedOrder, ShopSession } from '@/lib/pos-types';
import { getBusinessWindow, filterOrdersInBusinessWindow, type BusinessWindow as SessionBusinessWindow } from '@/lib/shop-session';

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

export default function DashboardPageClient() {
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [chartsReady, setChartsReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [shopSession, setShopSession] = useState<ShopSession | null>(null);

  useEffect(() => {
    setChartsReady(true);

    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  // "Today's" numbers on this dashboard are defined purely by the Open
  // Shop -> Close Shop cycle (see ShopStatusControl in DashboardShell and
  // backend/controllers/shopSessionController.js) - not a fixed clock
  // window. While a shift is open, the window is [openedAt, now) and
  // ticks live; once closed, it freezes at [openedAt, closedAt) so the
  // final count for that shift stays visible until the next shift opens.
  useEffect(() => {
    async function loadSession() {
      try {
        const history = await fetchShopSessionHistory();
        setShopSession(history && history.length > 0 ? history[0] : null);
      } catch (error) {
        console.error('Dashboard shop session fetch error', error);
      }
    }

    void loadSession();
    const intervalId = setInterval(() => void loadSession(), 45000);
    return () => clearInterval(intervalId);
  }, []);

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

  useEffect(() => {
    async function loadOrders() {
      try {
        // This page only ever shows "today's" (current/last shift) numbers
        // via the business-window filtering below - bounding the fetch to
        // the last 14 days (a generous margin over any realistic gap
        // between shifts) keeps this 45-second poll fast regardless of how
        // much order history this shop has accumulated overall. See
        // getOrders' `since` handling in orderController.js.
        const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const ordersData = await fetchOrders({ since });
        if (ordersData) setOrders(ordersData);
      } catch (error) {
        console.error('Dashboard orders fetch error', error);
      }
    }

    void loadOrders();

    const intervalId = setInterval(() => {
      void loadOrders();
    }, 45000);

    return () => clearInterval(intervalId);
  }, []);

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

    return data.map(({ start, end, ...bucket }) => bucket);
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

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 min-w-0 space-y-6 lg:col-span-7">
          <div className="rounded-[32px] bg-white p-6 shadow-sm">
            <h3 className="mb-6 font-bold text-gray-800">Sales Overview</h3>
            <div className="mb-8 grid grid-cols-2 gap-4">
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

            <div className="mt-8 grid grid-cols-3 gap-4">
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

          <div className="grid grid-cols-2 gap-6">
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
