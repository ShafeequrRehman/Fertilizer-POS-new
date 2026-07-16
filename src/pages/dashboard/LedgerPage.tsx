
import { useEffect, useMemo, useState } from 'react';
import { BookText, ChevronDown, ChevronUp, Phone, Search, AlertCircle, RefreshCcw } from 'lucide-react';
import { fetchCustomerLedger } from '@/lib/pos-api';
import { LedgerCustomer } from '@/lib/pos-types';

function formatMoney(amount: number) {
  return `₨${Math.round(amount).toLocaleString()}`;
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  completed: 'bg-emerald-100 text-emerald-700',
  paid: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-gray-200 text-gray-500 line-through',
};

export default function LedgerPage() {
  const [customers, setCustomers] = useState<LedgerCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    void loadLedger();
  }, []);

  const loadLedger = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchCustomerLedger();
      if (data) setCustomers(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load ledger.');
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return customers;
    return customers.filter((c) =>
      c.name.toLowerCase().includes(query) || c.phone.toLowerCase().includes(query)
    );
  }, [customers, search]);

  const totals = useMemo(() => {
    return customers.reduce(
      (acc, c) => ({
        billed: acc.billed + c.totalBilled,
        paid: acc.paid + c.totalPaid,
        due: acc.due + c.totalDue,
      }),
      { billed: 0, paid: 0, due: 0 }
    );
  }, [customers]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black text-gray-900 tracking-tight flex items-center gap-3">
            Ledger <BookText className="text-indigo-600" size={30} />
          </h1>
          <p className="text-gray-500 font-bold">Every customer's order history, what they've paid, and what's still owed.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-full sm:w-72">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
              <Search size={16} />
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or phone..."
              className="w-full rounded-2xl border border-gray-200 bg-white py-3 pl-11 pr-4 text-sm font-bold outline-none shadow-sm focus:ring-2 focus:ring-indigo-500 transition-all"
            />
          </div>
          <button
            type="button"
            onClick={() => void loadLedger()}
            disabled={loading}
            className="flex shrink-0 items-center gap-2 rounded-2xl bg-white shadow-sm px-4 py-3 text-sm font-black text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCcw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {errorMessage ? (
        <div className="flex items-center gap-3 bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-2xl font-bold text-sm">
          <AlertCircle size={20} />
          {errorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <StatCard label="Total Billed" value={formatMoney(totals.billed)} />
        <StatCard label="Total Collected" value={formatMoney(totals.paid)} />
        <StatCard label="Total Outstanding" value={formatMoney(totals.due)} tone={totals.due > 0 ? 'warn' : undefined} />
      </div>

      {loading ? (
        <div className="rounded-[32px] bg-white p-8 text-center text-sm font-bold text-gray-500 shadow-sm">Loading ledger...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-[32px] bg-white p-8 text-center text-sm font-bold text-gray-500 shadow-sm">
          {customers.length === 0 ? 'No customer orders recorded yet.' : 'No customers match your search.'}
        </div>
      ) : (
        <div className="rounded-[32px] bg-white shadow-sm overflow-hidden">
          <div className="grid grid-cols-[1.6fr_0.8fr_0.9fr_0.9fr_0.9fr_40px] gap-2 px-6 py-4 text-[11px] font-black uppercase tracking-[0.14em] text-gray-400 border-b border-gray-100">
            <span>Customer</span>
            <span>Orders</span>
            <span>Billed</span>
            <span>Paid</span>
            <span>Balance Due</span>
            <span />
          </div>
          <div className="divide-y divide-gray-100">
            {filtered.map((customer) => (
              <LedgerRow
                key={customer.id}
                customer={customer}
                expanded={expandedId === customer.id}
                onToggle={() => setExpandedId(expandedId === customer.id ? null : customer.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="rounded-[28px] bg-white px-5 py-5 shadow-sm">
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-gray-400">{label}</p>
      <p className={`mt-2 text-3xl font-black ${tone === 'warn' ? 'text-amber-600' : 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

function LedgerRow({
  customer,
  expanded,
  onToggle,
}: {
  customer: LedgerCustomer;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasDue = customer.totalDue > 0;
  // A customer can have several bills pending at once now (placing a new
  // order no longer requires their earlier one to be settled first - see
  // orderController.createOrder), so this is the actual list of what's
  // still unpaid, for the "total at the end" summary below.
  const pendingOrders = customer.orders.filter((order) => order.status === 'pending' && order.remainingAmount > 0);
  const pendingOrdersTotal = pendingOrders.reduce((sum, order) => sum + order.remainingAmount, 0);
  const billableOrders = customer.orders.filter((order) => order.status !== 'cancelled');
  const billableTotals = billableOrders.reduce(
    (acc, order) => ({
      total: acc.total + order.total,
      paid: acc.paid + order.paidAmount,
      due: acc.due + order.remainingAmount,
    }),
    { total: 0, paid: 0, due: 0 }
  );

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full grid grid-cols-[1.6fr_0.8fr_0.9fr_0.9fr_0.9fr_40px] gap-2 px-6 py-4 text-left items-center hover:bg-gray-50 transition-colors"
      >
        <div>
          <div className="text-sm font-black text-gray-900">{customer.name || 'Unnamed Customer'}</div>
          <div className="text-xs font-bold text-gray-400 flex items-center gap-1 mt-0.5">
            <Phone size={12} /> {customer.phone}
          </div>
        </div>
        <span className="text-sm font-bold text-gray-600">{customer.orderCount}</span>
        <span className="text-sm font-bold text-gray-600">{formatMoney(customer.totalBilled)}</span>
        <span className="text-sm font-bold text-emerald-600">{formatMoney(customer.totalPaid)}</span>
        <span className={`text-sm font-black ${hasDue ? 'text-rose-600' : 'text-gray-400'}`}>
          {formatMoney(customer.totalDue)}
        </span>
        <span className="text-gray-400">{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
      </button>

      {expanded ? (
        <div className="bg-gray-50 px-6 pb-5 pt-1">
          {customer.previousDues > 0 ? (
            <p className="text-xs font-bold text-amber-600 mb-3">
              Includes {formatMoney(customer.previousDues)} in older dues carried over before per-order tracking.
            </p>
          ) : null}
          {customer.orders.length === 0 ? (
            <p className="text-sm font-bold text-gray-400 py-3">No orders on record for this customer.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-[10px] font-black uppercase tracking-wider text-gray-400">
                    <th className="py-2 pr-4">Order</th>
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Total</th>
                    <th className="py-2 pr-4">Paid</th>
                    <th className="py-2 pr-4">Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {customer.orders.map((order) => (
                    <tr key={order.id}>
                      <td className="py-2.5 pr-4 font-black text-gray-800">#{order.dailyOrderNumber ?? '—'}</td>
                      <td className="py-2.5 pr-4 font-bold text-gray-500">{formatDate(order.createdAt)}</td>
                      <td className="py-2.5 pr-4 font-bold text-gray-500">{order.orderType}</td>
                      <td className="py-2.5 pr-4">
                        <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${STATUS_STYLES[order.status] || 'bg-gray-100 text-gray-500'}`}>
                          {order.status}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 font-bold text-gray-700">{formatMoney(order.total)}</td>
                      <td className="py-2.5 pr-4 font-bold text-emerald-600">{formatMoney(order.paidAmount)}</td>
                      <td className={`py-2.5 pr-4 font-black ${order.remainingAmount > 0 && order.status !== 'cancelled' ? 'text-rose-600' : 'text-gray-400'}`}>
                        {order.status === 'cancelled' ? '—' : formatMoney(order.remainingAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200">
                    <td colSpan={4} className="py-2.5 pr-4 text-right text-xs font-black uppercase tracking-wider text-gray-500">Total (all bills)</td>
                    <td className="py-2.5 pr-4 font-black text-gray-900">{formatMoney(billableTotals.total)}</td>
                    <td className="py-2.5 pr-4 font-black text-emerald-600">{formatMoney(billableTotals.paid)}</td>
                    <td className={`py-2.5 pr-4 font-black ${billableTotals.due > 0 ? 'text-rose-600' : 'text-gray-400'}`}>{formatMoney(billableTotals.due)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* The full running total the customer owes right now, across
              every still-pending bill plus any older carried-over dues -
              exactly what a cashier would need to collect if the customer
              wanted to clear everything today. */}
          {pendingOrders.length > 0 || customer.previousDues > 0 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
              <span className="text-xs font-black uppercase tracking-wider text-amber-700">
                {pendingOrders.length > 0 ? `${pendingOrders.length} pending bill${pendingOrders.length > 1 ? 's' : ''}${customer.previousDues > 0 ? ' + older carried-over dues' : ''}` : 'Older carried-over dues'}
              </span>
              <span className="text-sm font-black text-amber-700">Total Due: {formatMoney(pendingOrdersTotal + customer.previousDues)}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
