import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Download, Eye, Lock, Printer, Search, X, XCircle } from 'lucide-react';
import { fetchOrders, fetchShopSessionHistory } from '@/lib/pos-api';
import { SavedOrder, ShopSession } from '@/lib/pos-types';
import { hasPermission } from '@/lib/auth';
import { getBusinessWindow, filterOrdersInBusinessWindow, filterOrdersInBusinessWindows, getSessionDateKey } from '@/lib/shop-session';
import CancelOrderModal from '@/components/CancelOrderModal';

type StatusFilter = 'All' | 'pending' | 'completed' | 'paid' | 'cancelled';
type SearchField = 'all' | 'name' | 'phone' | 'orderId';

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
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [shopSession, setShopSession] = useState<ShopSession | null>(null);
  // Full shift history (up to the last 60 shifts, per the backend) - needed
  // so the date-range picker can find EVERY shift that opened on a picked
  // date, not just whatever the current/latest shift happens to be.
  const [sessionHistory, setSessionHistory] = useState<ShopSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [search, setSearch] = useState('');
  const [searchField, setSearchField] = useState<SearchField>('all');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [viewOrder, setViewOrder] = useState<SavedOrder | null>(null);
  const [cancelOrderTarget, setCancelOrderTarget] = useState<SavedOrder | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [orderData, history] = await Promise.all([fetchOrders(), fetchShopSessionHistory()]);
        if (orderData) setOrders(orderData);
        setSessionHistory(history ?? []);
        setShopSession(history && history.length > 0 ? history[0] : null);
      } catch (error) {
        console.error('Record page load error', error);
      } finally {
        setLoading(false);
      }
    }
    void load();
    const intervalId = setInterval(() => void load(), 45000);
    return () => clearInterval(intervalId);
  }, []);

  const sessionWindow = useMemo(() => getBusinessWindow(shopSession, new Date()), [shopSession]);

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

  const filteredOrders = useMemo(() => {
    return dayOrders
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
  }, [dayOrders, statusFilter, search, searchField]);

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

  const counts = useMemo(() => {
    const base: Record<StatusFilter, number> = { All: dayOrders.length, pending: 0, completed: 0, paid: 0, cancelled: 0 };
    dayOrders.forEach((order) => {
      if (order.status in base) base[order.status as StatusFilter] += 1;
    });
    return base;
  }, [dayOrders]);

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

  const canCancel = hasPermission('sales.delete');

  function handleOrderCancelled(updated: SavedOrder) {
    setOrders((previous) => previous.map((order) => (order.id === updated.id ? updated : order)));
    setCancelOrderTarget(null);
    setViewOrder(updated);
  }

  return (
    <div className="space-y-4">
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
        <button
          type="button"
          onClick={exportCsv}
          disabled={filteredOrders.length === 0}
          className="flex items-center gap-2 rounded-full bg-[#D6E332] px-4 py-2 text-xs font-black text-gray-900 shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download size={14} /> Export CSV
        </button>
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
            className={`rounded-[16px] p-2.5 text-left shadow-sm transition ${statusFilter === tab.key ? 'bg-black text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
          >
            <p className={`text-[9px] font-black uppercase tracking-[0.14em] ${statusFilter === tab.key ? 'text-gray-300' : 'text-gray-400'}`}>{tab.label}</p>
            <p className="text-lg font-black">{counts[tab.key]}</p>
          </button>
        ))}
      </div>

      <div className="rounded-[16px] bg-rose-50 p-3 shadow-sm sm:flex sm:items-center sm:justify-between">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-rose-500">Total Discount Today</p>
          <p className="text-lg font-black text-rose-700">Rs {totalDiscountToday}</p>
        </div>
        <p className="mt-1 text-xs font-semibold text-rose-500 sm:mt-0">{discountedOrderCount} order{discountedOrderCount === 1 ? '' : 's'} discounted this shift</p>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-[20px] bg-white p-3 shadow-sm sm:grid-cols-2 lg:grid-cols-6">
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
              onChange={(event) => setRangeFrom(event.target.value)}
              className="w-full min-w-0 rounded-full border border-transparent bg-[#F6F7FB] px-2.5 py-2 text-xs font-semibold outline-none transition focus:border-[#D6E332]"
            />
            <input
              type="date"
              value={rangeTo}
              onChange={(event) => setRangeTo(event.target.value)}
              className="w-full min-w-0 rounded-full border border-transparent bg-[#F6F7FB] px-2.5 py-2 text-xs font-semibold outline-none transition focus:border-[#D6E332]"
            />
          </div>
        </div>

        <div className="lg:col-span-1">
          <label className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.14em] text-gray-400">Search By</label>
          <select
            value={searchField}
            onChange={(event) => setSearchField(event.target.value as SearchField)}
            className="w-full rounded-full border border-transparent bg-[#F6F7FB] px-3 py-2 text-xs font-semibold outline-none transition focus:border-[#D6E332]"
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
              className="w-full rounded-full border border-transparent bg-[#F6F7FB] py-2 pl-11 pr-4 text-sm outline-none transition focus:border-[#D6E332]"
            />
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[28px] bg-white shadow-sm">
        <div className="hidden grid-cols-[90px_1.3fr_0.9fr_0.9fr_0.9fr_0.9fr_0.9fr_100px] gap-2 border-b border-gray-100 px-6 py-3 text-[10px] font-black uppercase tracking-[0.14em] text-gray-400 lg:grid">
          <span>Order</span>
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
          <div className="divide-y divide-gray-100">
            {filteredOrders.map((order) => (
              <RecordRow key={order.id} order={order} onView={() => setViewOrder(order)} />
            ))}
          </div>
        )}
      </div>

      {viewOrder ? (
        <OrderDetailModal
          order={viewOrder}
          canCancel={canCancel}
          onClose={() => setViewOrder(null)}
          onCancelRequested={() => setCancelOrderTarget(viewOrder)}
        />
      ) : null}

      {cancelOrderTarget ? (
        <CancelOrderModal order={cancelOrderTarget} onClose={() => setCancelOrderTarget(null)} onCancelled={handleOrderCancelled} />
      ) : null}
    </div>
  );
}

function RecordRow({ order, onView }: { order: SavedOrder; onView: () => void }) {
  const time = new Date(order.createdAt).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
  // A shift can run past midnight, so a bare time ("11:42 PM") is ambiguous
  // once a date range spans more than one day - the date underneath makes
  // it unambiguous which day each order actually belongs to.
  const date = new Date(order.createdAt).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' });
  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);
  const customerName = order.orderType === 'DineIn' ? (order.table ? `Table ${order.table}` : 'Dine-In Customer') : order.customer?.name || 'Walk-in Customer';
  const orderType = order.orderType === 'DineIn' ? 'Dine In' : order.orderType === 'TakeAway' ? 'Take Away' : 'Delivery';

  return (
    <div className="grid grid-cols-2 gap-2 px-6 py-4 text-sm lg:grid-cols-[90px_1.3fr_0.9fr_0.9fr_0.9fr_0.9fr_0.9fr_100px] lg:items-center">
      <div>
        <p className="font-black text-gray-900">#{orderLabel}</p>
        <p className="text-[11px] font-semibold text-gray-400">{time}</p>
        <p className="text-[10px] font-semibold text-gray-400">{date}</p>
      </div>
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
        <button
          type="button"
          onClick={onView}
          title="View order"
          className="flex items-center gap-1.5 rounded-full bg-[#F6F7FB] px-3 py-2 text-[11px] font-black text-gray-700 transition hover:bg-gray-100"
        >
          <Eye size={13} />
        </button>
        <Link
          to={`/dashboard/sales/print/${order.id}`}
          title="Print receipt"
          className="flex items-center gap-1.5 rounded-full bg-[#F6F7FB] px-3 py-2 text-[11px] font-black text-gray-700 transition hover:bg-gray-100"
        >
          <Printer size={13} />
        </Link>
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
    pending: 'bg-amber-100 text-amber-700',
    completed: 'bg-emerald-100 text-emerald-700',
    paid: 'bg-sky-100 text-sky-700',
    cancelled: 'bg-rose-100 text-rose-700',
  };
  return <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase ${styles[status] || 'bg-gray-100 text-gray-600'}`}>{status}</span>;
}

function OrderDetailModal({
  order,
  canCancel,
  onClose,
  onCancelRequested,
}: {
  order: SavedOrder;
  canCancel: boolean;
  onClose: () => void;
  onCancelRequested: () => void;
}) {
  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);
  const customerName = order.orderType === 'DineIn' ? (order.table ? `Table ${order.table}` : 'Dine-In Customer') : order.customer?.name || 'Walk-in Customer';
  const orderType = order.orderType === 'DineIn' ? 'Dine In' : order.orderType === 'TakeAway' ? 'Take Away' : 'Delivery';
  const createdAt = new Date(order.createdAt).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col rounded-[32px] bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between border-b border-gray-100 p-6">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-gray-400">Order Detail</p>
            <h2 className="mt-1 text-2xl font-black text-gray-900">Order #{orderLabel}</h2>
            <p className="mt-1 text-sm text-gray-500">{createdAt}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={order.status} />
            <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
              <XCircle size={18} />
            </button>
          </div>
        </div>

        <div className="space-y-5 overflow-y-auto p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <DetailBox label="Customer" value={customerName} />
            <DetailBox label={order.orderType === 'DineIn' ? 'Waiter' : 'Phone'} value={order.orderType === 'DineIn' ? (order.waiter || 'Dine In') : (order.customer?.phone || 'No phone')} />
            <DetailBox label="Order Type" value={orderType} />
            <DetailBox label="Payment Method" value={order.paymentMethod} />
            <DetailBox label="Paid" value={`Rs ${order.paidAmount ?? 0}`} />
            <DetailBox label="Remaining" value={`Rs ${order.remainingAmount ?? 0}`} />
          </div>

          {order.status === 'cancelled' ? (
            <div className="space-y-1.5 rounded-[20px] border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-700">
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
                <div key={`${item.name}-${index}`} className="flex items-center justify-between rounded-[18px] bg-[#FAFBFC] px-4 py-3">
                  <div>
                    <p className="font-bold text-gray-900">{item.name}</p>
                    <p className="text-xs text-gray-400">{item.variation}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-black text-gray-900">Rs {item.price * item.quantity}</p>
                    <p className="text-xs text-gray-400">Qty {item.quantity}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[20px] bg-[#F8F9FB] p-4 text-sm">
            <DetailRow label="Subtotal" value={`Rs ${order.subtotal}`} />
            <DetailRow label="Tax" value={`Rs ${order.tax}`} />
            {order.discount && order.discount.amount > 0 ? (
              <DetailRow label={`Discount ${order.discount.type === 'percent' ? `(${order.discount.value}%)` : ''}`} value={`-Rs ${order.discount.amount}`} />
            ) : null}
            <DetailRow label="Total" value={`Rs ${order.total}`} strong />
          </div>

          {order.note ? <DetailBox label="Note" value={order.note} /> : null}
        </div>

        {order.status === 'pending' && canCancel ? (
          <div className="shrink-0 border-t border-gray-100 p-6">
            <button
              type="button"
              onClick={onCancelRequested}
              className="flex w-full items-center justify-center gap-2 rounded-[20px] bg-rose-600 px-5 py-3.5 text-sm font-black text-white transition hover:bg-rose-700"
            >
              <Lock size={16} /> Cancel Order
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DetailBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] bg-[#F8F9FB] px-4 py-3">
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
