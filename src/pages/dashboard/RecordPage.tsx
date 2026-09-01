import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Eye, Lock, Search, XCircle } from 'lucide-react';
import { fetchOrders, fetchShopSessionHistory } from '@/lib/pos-api';
import { SavedOrder, ShopSession } from '@/lib/pos-types';
import { hasPermission } from '@/lib/auth';
import CancelOrderModal from '@/components/CancelOrderModal';
import { resolveProductImage } from '@/lib/food-images';

type StatusFilter = 'All' | 'pending' | 'completed' | 'paid' | 'cancelled';

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'All', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'completed', label: 'Completed' },
  { key: 'paid', label: 'Paid' },
  { key: 'cancelled', label: 'Cancelled' },
];

// The "day" here is exactly the current/most recent shop shift - same
// definition used on the Dashboard (see DashboardPageClient.tsx
// getBusinessWindow) - not a fixed clock window. While a shift is open the
// window is [openedAt, now) and keeps growing; once closed it freezes at
// [openedAt, closedAt), so this stays "today's record" until the next
// Open Shop starts a new one.
export default function RecordPage() {
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [shopSession, setShopSession] = useState<ShopSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [search, setSearch] = useState('');
  const [viewOrder, setViewOrder] = useState<SavedOrder | null>(null);
  const [cancelOrderTarget, setCancelOrderTarget] = useState<SavedOrder | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [orderData, history] = await Promise.all([fetchOrders(), fetchShopSessionHistory()]);
        if (orderData) setOrders(orderData);
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

  const sessionWindow = useMemo(() => {
    if (!shopSession) return null;
    const start = new Date(shopSession.openedAt);
    const end = shopSession.status === 'open' ? new Date() : new Date(shopSession.closedAt as string);
    return { start, end };
  }, [shopSession]);

  const dayOrders = useMemo(() => {
    if (!sessionWindow) return [];
    return orders.filter((order) => {
      const createdAt = new Date(order.createdAt);
      return createdAt >= sessionWindow.start && createdAt <= sessionWindow.end;
    });
  }, [orders, sessionWindow]);

  const filteredOrders = useMemo(() => {
    return dayOrders
      .filter((order) => statusFilter === 'All' || order.status === statusFilter)
      .filter((order) => {
        if (!search.trim()) return true;
        const haystack = `${order.dailyOrderNumber ?? ''} ${order.id} ${order.customer?.name ?? ''} ${order.customer?.phone ?? ''} ${order.table ?? ''} ${order.waiter ?? ''}`.toLowerCase();
        return haystack.includes(search.trim().toLowerCase());
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [dayOrders, statusFilter, search]);

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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Record</h1>
        <p className="text-xs text-gray-400">
          {shopSession
            ? `Every order for ${shopSession.status === 'open' ? 'the current open shift' : "this shop's last shift"} - pending, completed, paid, and cancelled.`
            : 'No shift recorded yet. Open the shop to start today\'s record.'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setStatusFilter(tab.key)}
            className={`rounded-[20px] p-4 text-left transition ${statusFilter === tab.key ? 'glass-dark' : 'glass text-gray-700 hover:bg-white/70'}`}
          >
            <p className={`text-[10px] font-black uppercase tracking-[0.16em] ${statusFilter === tab.key ? 'text-gray-300' : 'text-gray-400'}`}>{tab.label}</p>
            <p className="mt-1 text-2xl font-black">{counts[tab.key]}</p>
          </button>
        ))}
      </div>

      <div className="rounded-[20px] bg-rose-50/60 p-4 shadow-inner backdrop-blur-xl sm:flex sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-rose-500">Total Discount Today</p>
          <p className="mt-1 text-2xl font-black text-rose-700">Rs {totalDiscountToday}</p>
        </div>
        <p className="mt-2 text-xs font-semibold text-rose-500 sm:mt-0">{discountedOrderCount} order{discountedOrderCount === 1 ? '' : 's'} discounted this shift</p>
      </div>

      <div className="glass rounded-[28px] p-4">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search order #, customer, phone, table, waiter"
            className="w-full rounded-full border border-white/60 bg-white/50 py-3 pl-11 pr-4 text-sm shadow-inner outline-none transition focus:border-[#D6E332]"
          />
        </div>
      </div>

      <div className="glass overflow-hidden rounded-[28px]">
        <div className="hidden grid-cols-[90px_1.3fr_1fr_0.9fr_0.7fr_0.9fr_0.9fr_80px] gap-2 border-b border-white/40 px-6 py-3 text-[10px] font-black uppercase tracking-[0.14em] text-gray-400 lg:grid">
          <span>Order</span>
          <span>Customer</span>
          <span>Type</span>
          <span>Items</span>
          <span>Total</span>
          <span>Payment</span>
          <span>Status</span>
          <span className="text-right">View</span>
        </div>

        {loading ? (
          <div className="p-10 text-center text-sm font-bold text-gray-400">Loading today's record...</div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-10 text-center text-sm font-bold text-gray-400">No orders match this filter.</div>
        ) : (
          <div className="divide-y divide-white/40">
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
  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);
  const customerName = order.orderType === 'DineIn' ? (order.table ? `Table ${order.table}` : 'Dine-In Customer') : order.customer?.name || 'Walk-in Customer';
  const orderType = order.orderType === 'DineIn' ? 'Dine In' : order.orderType === 'TakeAway' ? 'Take Away' : 'Delivery';

  return (
    <div className="grid grid-cols-2 gap-2 px-6 py-4 text-sm lg:grid-cols-[90px_1.3fr_1fr_0.9fr_0.7fr_0.9fr_0.9fr_80px] lg:items-center">
      <div>
        <p className="font-black text-gray-900">#{orderLabel}</p>
        <p className="text-[11px] font-semibold text-gray-400">{time}</p>
      </div>
      <div className="truncate">
        <p className="truncate font-bold text-gray-800">{customerName}</p>
        <p className="truncate text-[11px] text-gray-400">{order.customer?.phone || '—'}</p>
      </div>
      <span className="text-gray-600">{orderType}</span>
      <span className="text-gray-600">{order.items?.length ?? 0} items</span>
      <div>
        <span className="font-black text-gray-900">Rs {order.total}</span>
        {order.discount && order.discount.amount > 0 ? (
          <p className="text-[10px] font-bold text-rose-500">-Rs {order.discount.amount} off</p>
        ) : null}
      </div>
      <span className="text-gray-600">{order.paymentMethod}</span>
      <div>
        <StatusBadge status={order.status} />
      </div>
      <div className="flex justify-end lg:justify-end">
        <button
          type="button"
          onClick={onView}
          className="glass-pill flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-black text-gray-700 transition hover:bg-white/70"
        >
          <Eye size={13} /> View
        </button>
      </div>
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

        {order.status === 'pending' && canCancel ? (
          <div className="shrink-0 border-t border-white/40 p-6">
            <button
              type="button"
              onClick={onCancelRequested}
              className="flex w-full items-center justify-center gap-2 rounded-[20px] border-[0.5px] border-white/40 bg-gradient-to-b from-rose-500 to-rose-700 px-5 py-3.5 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-4px_10px_rgba(136,19,55,0.45)] transition hover:brightness-105"
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
