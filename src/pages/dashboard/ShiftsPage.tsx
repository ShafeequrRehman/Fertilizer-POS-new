
import { useEffect, useMemo, useState } from 'react';
import { Store, AlertCircle, Clock, RefreshCcw } from 'lucide-react';
import { fetchShopSessionHistory } from '@/lib/pos-api';
import { ShopSession } from '@/lib/pos-types';

function formatMoney(amount: number) {
  return `₨${Math.round(amount).toLocaleString()}`;
}

function formatDateTime(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(openedAt: string, closedAt: string | null) {
  const end = closedAt ? new Date(closedAt).getTime() : Date.now();
  const start = new Date(openedAt).getTime();
  const minutes = Math.max(0, Math.round((end - start) / 60000));
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours === 0) return `${remaining}m`;
  return `${hours}h ${remaining}m`;
}

// Every "Shop Open" -> "Shop Close" cycle is one row here, with the exact
// order count and sales total locked in at close time (see
// backend/controllers/shopSessionController.js) - this is what makes "how
// many orders did we do on the shift that started at 6pm" an exact,
// answerable question instead of a guess based on calendar dates.
export default function ShiftsPage() {
  const [sessions, setSessions] = useState<ShopSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void loadHistory();
  }, []);

  async function loadHistory() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchShopSessionHistory();
      if (data) setSessions(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load shift history.');
    } finally {
      setLoading(false);
    }
  }

  const totals = useMemo(() => {
    const closed = sessions.filter((s) => s.status === 'closed');
    return closed.reduce(
      (acc, s) => ({
        orders: acc.orders + s.summary.orderCount,
        sales: acc.sales + s.summary.totalSales,
      }),
      { orders: 0, sales: 0 }
    );
  }, [sessions]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black text-gray-900 tracking-tight flex items-center gap-3">
            Shifts <Store className="text-indigo-600" size={30} />
          </h1>
          <p className="text-gray-500 font-bold">Every Open Shop → Close Shop cycle, with the exact order count and sales locked in at close time.</p>
        </div>
        <button
          type="button"
          onClick={() => void loadHistory()}
          disabled={loading}
          className="flex items-center gap-2 rounded-2xl bg-white shadow-sm px-4 py-3 text-sm font-black text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          <RefreshCcw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {errorMessage ? (
        <div className="flex items-center gap-3 bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-2xl font-bold text-sm">
          <AlertCircle size={20} />
          {errorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <StatCard label="Closed Shifts" value={String(sessions.filter((s) => s.status === 'closed').length)} />
        <StatCard label="Total Orders" value={totals.orders.toLocaleString()} />
        <StatCard label="Total Sales" value={formatMoney(totals.sales)} />
      </div>

      {loading ? (
        <div className="rounded-[32px] bg-white p-8 text-center text-sm font-bold text-gray-500 shadow-sm">Loading shift history...</div>
      ) : sessions.length === 0 ? (
        <div className="rounded-[32px] bg-white p-8 text-center text-sm font-bold text-gray-500 shadow-sm">
          No shifts recorded yet. Use the "Open Shop" button to start one.
        </div>
      ) : (
        <div className="rounded-[32px] bg-white shadow-sm overflow-hidden">
          <div className="grid grid-cols-[1.3fr_0.9fr_0.7fr_0.9fr_0.9fr_1fr] gap-2 px-6 py-4 text-[11px] font-black uppercase tracking-[0.14em] text-gray-400 border-b border-gray-100">
            <span>Opened → Closed</span>
            <span>Duration</span>
            <span>Orders</span>
            <span>Sales</span>
            <span>Collected</span>
            <span>Opened / Closed By</span>
          </div>
          <div className="divide-y divide-gray-100">
            {sessions.map((session) => (
              <ShiftRow key={session.id} session={session} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[28px] bg-white px-5 py-5 shadow-sm">
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-gray-400">{label}</p>
      <p className="mt-2 text-3xl font-black text-gray-900">{value}</p>
    </div>
  );
}

function ShiftRow({ session }: { session: ShopSession }) {
  const isOpen = session.status === 'open';
  const summary = isOpen ? session.liveSummary || session.summary : session.summary;

  return (
    <div className="grid grid-cols-[1.3fr_0.9fr_0.7fr_0.9fr_0.9fr_1fr] gap-2 px-6 py-4 items-center">
      <div>
        <div className="text-sm font-black text-gray-900 flex items-center gap-2">
          {formatDateTime(session.openedAt)}
          {isOpen ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black uppercase text-emerald-700">Open</span>
          ) : (
            <>→ {formatDateTime(session.closedAt)}</>
          )}
        </div>
        {!isOpen && session.closedWithUnpaidOrders ? (
          <div className="mt-1 text-[11px] font-bold text-amber-600">Closed with unresolved orders</div>
        ) : null}
      </div>
      <span className="text-sm font-bold text-gray-600 flex items-center gap-1">
        <Clock size={13} className="text-gray-300" />
        {formatDuration(session.openedAt, session.closedAt)}
      </span>
      <span className="text-sm font-black text-gray-800">{summary.orderCount}</span>
      <span className="text-sm font-bold text-gray-700">{formatMoney(summary.totalSales)}</span>
      <span className="text-sm font-bold text-emerald-600">{formatMoney(summary.totalPaid)}</span>
      <div className="text-xs font-bold text-gray-500">
        <div>Opened: {session.openedByName || '—'}</div>
        <div>{isOpen ? '' : `Closed: ${session.closedByName || '—'}`}</div>
      </div>
    </div>
  );
}
