import { useEffect, useState } from 'react';
import {
  Banknote, Landmark, Calendar,
  AlertCircle, CheckCircle2, ChevronLeft, ChevronRight,
  Calculator, History, X, RefreshCcw,
} from 'lucide-react';
import { shopApi, type PayrollResponse, type PayrollRow, type StaffPayment } from '@/lib/shop-api';
import { useToast } from '@/lib/toast';

// Real payroll, built on top of Manage Staff's monthlySalary field plus a
// ledger of StaffPayment rows recorded here (salary/advance/bonus/
// deduction) - see backend/controllers/shopOwnerController.js
// listPayroll/recordPayment. Replaces the earlier static/placeholder
// version of this page.
function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function shiftMonth(monthKey: string, delta: number) {
  const [year, month] = monthKey.split('-').map(Number);
  const d = new Date(year, month - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function PayrollPage() {
  const { toast } = useToast();
  const [month, setMonth] = useState(currentMonthKey());
  const [data, setData] = useState<PayrollResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [payTarget, setPayTarget] = useState<PayrollRow | null>(null);
  const [history, setHistory] = useState<StaffPayment[]>([]);
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(10);
  const [visibleRowCount, setVisibleRowCount] = useState(10);

  const load = () => {
    setLoading(true);
    Promise.all([shopApi.getPayroll(month), shopApi.listPayments({ month })])
      .then(([payroll, payments]) => { setData(payroll); setHistory(payments); })
      .finally(() => setLoading(false));
  };

  useEffect(load, [month]);
  useEffect(() => setVisibleRowCount(10), [data]);
  useEffect(() => setVisibleHistoryCount(10), [history]);

  const rows = data?.rows || [];
  const visibleRows = rows.slice(0, visibleRowCount);
  const visibleHistory = history.slice(0, visibleHistoryCount);

  const isCurrentMonth = month === currentMonthKey();

  return (
    <div className="min-h-screen bg-[#F9FAFB] p-4 lg:p-8 space-y-8">

      {/* Header Area */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            Payroll <Landmark className="text-purple-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">What each staff member is owed, has taken, and has left for the month.</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-[20px] border border-slate-200 bg-white px-3 py-2">
            <button type="button" onClick={() => setMonth((m) => shiftMonth(m, -1))} className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100">
              <ChevronLeft size={16} />
            </button>
            <span className="flex items-center gap-2 px-2 text-sm font-black text-slate-900">
              <Calendar size={14} className="text-purple-500" /> {monthLabel(month)}
            </span>
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              disabled={isCurrentMonth}
              className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <button onClick={load} disabled={loading} className="flex items-center gap-2 px-5 py-3 bg-white border border-slate-200 rounded-[20px] font-black text-sm hover:bg-slate-50 transition-all disabled:opacity-60">
            <RefreshCcw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Payroll Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2">Total Monthly Payroll</p>
          <h2 className="text-3xl font-black text-slate-900">Rs {(data?.summary.totalMonthlySalary || 0).toLocaleString()}</h2>
          <p className="text-slate-400 text-xs font-bold mt-2 italic">Sum of every staff member's monthly salary</p>
        </div>

        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2">Paid So Far This Month</p>
          <h2 className="text-3xl font-black text-slate-900">Rs {(data?.summary.totalPaidThisMonth || 0).toLocaleString()}</h2>
          <p className="text-slate-400 text-xs font-bold mt-2 italic">Salary + advances, minus deductions</p>
        </div>

        <div className="bg-purple-900 p-8 rounded-[32px] text-white shadow-xl shadow-purple-100">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-purple-300 mb-2">Remaining To Pay</p>
          <h2 className="text-3xl font-black">Rs {(data?.summary.totalRemaining || 0).toLocaleString()}</h2>
          <p className="text-purple-400 text-xs font-bold mt-2 flex items-center gap-1">
            <AlertCircle size={14} /> Across {rows.length} staff member{rows.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {/* Per-employee table */}
      <div className="bg-white rounded-[40px] shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-8 border-b border-slate-50 flex items-center justify-between bg-white/50 backdrop-blur-md">
          <h3 className="font-black text-xl text-slate-900">Staff Pay Summary</h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-slate-400 text-[10px] uppercase tracking-widest font-black">
                <th className="px-8 py-6">Staff Member</th>
                <th className="px-8 py-6">Designation</th>
                <th className="px-8 py-6">Monthly Salary</th>
                <th className="px-8 py-6">Taken This Month</th>
                <th className="px-8 py-6">Remaining</th>
                <th className="px-8 py-6"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr><td colSpan={6} className="px-8 py-10 text-center text-slate-400 font-bold">Loading...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-8 py-10 text-center text-slate-400 font-bold">No staff members yet. Add them from Manage Staff.</td></tr>
              ) : (
                visibleRows.map((row) => (
                  <tr key={row.employeeId} className="group hover:bg-slate-50/50 transition-colors">
                    <td className="px-8 py-6">
                      <div className="text-sm font-black text-slate-900">{row.name}</div>
                      <div className="text-[10px] font-bold text-slate-400 uppercase">@{row.username}</div>
                    </td>
                    <td className="px-8 py-6">
                      <span className="text-sm font-bold text-slate-600">{row.designation || '—'}</span>
                    </td>
                    <td className="px-8 py-6">
                      <span className="text-sm font-black text-slate-900">Rs {row.monthlySalary.toLocaleString()}</span>
                    </td>
                    <td className="px-8 py-6">
                      <span className="text-sm font-bold text-slate-600">Rs {row.paidThisMonth.toLocaleString()}</span>
                      {row.bonusThisMonth ? (
                        <div className="text-[10px] text-emerald-600 font-bold uppercase">+Rs {row.bonusThisMonth.toLocaleString()} bonus</div>
                      ) : null}
                    </td>
                    <td className="px-8 py-6">
                      <span className={`flex items-center gap-1.5 text-[10px] font-black uppercase px-3 py-1.5 rounded-lg w-fit ${row.remaining <= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                        {row.remaining <= 0 ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                        Rs {Math.abs(row.remaining).toLocaleString()} {row.remaining <= 0 ? (row.remaining < 0 ? 'overpaid' : 'settled') : 'left'}
                      </span>
                    </td>
                    <td className="px-8 py-6 text-right">
                      <button
                        type="button"
                        onClick={() => setPayTarget(row)}
                        className="flex items-center gap-2 rounded-full bg-purple-600 px-4 py-2 text-xs font-black text-white hover:bg-purple-700"
                      >
                        <Calculator size={14} /> Record Payment
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {rows.length > visibleRows.length ? (
          <div className="flex justify-center border-t border-slate-100 py-4">
            <button type="button" onClick={() => setVisibleRowCount((c) => c + 10)} className="rounded-full bg-slate-50 px-5 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-100">
              Load More ({rows.length - visibleRows.length} more)
            </button>
          </div>
        ) : null}
      </div>

      {/* Recent transactions */}
      <div className="bg-white rounded-[40px] shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-8 border-b border-slate-50 flex items-center gap-2 bg-white/50 backdrop-blur-md">
          <History size={18} className="text-purple-600" />
          <h3 className="font-black text-xl text-slate-900">Payments This Month</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-slate-400 text-[10px] uppercase tracking-widest font-black">
                <th className="px-8 py-5">Staff Member</th>
                <th className="px-8 py-5">Type</th>
                <th className="px-8 py-5">Amount</th>
                <th className="px-8 py-5">Note</th>
                <th className="px-8 py-5">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {history.length === 0 ? (
                <tr><td colSpan={5} className="px-8 py-8 text-center text-slate-400 font-bold">No payments recorded this month yet.</td></tr>
              ) : (
                visibleHistory.map((p) => {
                  const emp = typeof p.employeeId === 'object' ? p.employeeId : null;
                  return (
                    <tr key={p._id} className="hover:bg-slate-50/50">
                      <td className="px-8 py-4 text-sm font-bold text-slate-800">{emp?.name || emp?.username || '—'}</td>
                      <td className="px-8 py-4">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">{p.type}</span>
                      </td>
                      <td className="px-8 py-4 text-sm font-black text-slate-900">Rs {p.amount.toLocaleString()}</td>
                      <td className="px-8 py-4 text-sm text-slate-500">{p.note || '—'}</td>
                      <td className="px-8 py-4 text-xs font-bold text-slate-400">{new Date(p.date).toLocaleDateString()}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {history.length > visibleHistory.length ? (
          <div className="flex justify-center border-t border-slate-100 py-4">
            <button type="button" onClick={() => setVisibleHistoryCount((c) => c + 10)} className="rounded-full bg-slate-50 px-5 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-100">
              Load More ({history.length - visibleHistory.length} more)
            </button>
          </div>
        ) : null}
      </div>

      {payTarget ? (
        <RecordPaymentModal
          row={payTarget}
          onClose={() => setPayTarget(null)}
          onSaved={() => { toast.success('Payment recorded.'); load(); }}
        />
      ) : null}
    </div>
  );
}

function RecordPaymentModal({ row, onClose, onSaved }: { row: PayrollRow; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState(row.remaining > 0 ? String(row.remaining) : '');
  const [type, setType] = useState<'salary' | 'advance' | 'bonus' | 'deduction'>('salary');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const value = Number(amount);
    if (!value || value <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await shopApi.recordPayment({ employeeId: row.employeeId, amount: value, type, note });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to record payment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-[28px] bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-black text-slate-900">Record Payment</h2>
            <p className="text-xs font-bold text-slate-400">{row.name} · Rs {row.remaining.toLocaleString()} remaining this month</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-500">Type</label>
            <div className="grid grid-cols-4 gap-2">
              {(['salary', 'advance', 'bonus', 'deduction'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`rounded-xl border px-2 py-2 text-[11px] font-black capitalize transition ${type === t ? 'border-purple-600 bg-purple-50 text-purple-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-500">Amount</label>
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5">
              <Banknote size={16} className="text-slate-400" />
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full outline-none"
                placeholder="0"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-500">Note (optional)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-purple-400"
              placeholder="e.g. mid-month advance"
            />
          </div>
        </div>

        {error ? <p className="mt-3 text-sm font-bold text-rose-600">{error}</p> : null}

        <button
          type="button"
          disabled={submitting}
          onClick={submit}
          className="mt-5 w-full rounded-xl bg-purple-600 py-3 text-sm font-black text-white transition hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Saving...' : 'Save Payment'}
        </button>
      </div>
    </div>
  );
}
