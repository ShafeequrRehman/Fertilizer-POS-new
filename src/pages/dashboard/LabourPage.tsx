import React, { useEffect, useMemo, useState } from 'react';
import { fetchLabourSummary, adjustLabour } from '@/lib/pos-api';
import { LabourSummary } from '@/lib/pos-types';
import { HardHat, RefreshCcw, ArrowDownCircle, ArrowUpCircle, ChevronDown, ChevronUp, Download } from 'lucide-react';
import { useToast } from '@/lib/toast';

// Same All/Today/This Month/Custom history-range pattern as BankPage.tsx/
// GrainStockPage.tsx's own local copy.
type LabourHistoryRangeMode = 'all' | 'today' | 'month' | 'custom';

function isSameCalendarMonth(value: string, reference: Date) {
  const d = new Date(value);
  return d.getFullYear() === reference.getFullYear() && d.getMonth() === reference.getMonth();
}

function todayDateInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The shop's own Labour Khata - a single running balance (unlike Bank/
// Grain Stock, which can have several named accounts - see
// backend/models/LabourAccount.js's own comment on why). Fed automatically
// whenever a Customer Dues "+ Add Dues"/"- Pay Dues" action is made "via
// Labour" (see DuesPage.tsx's payment-method picker) - that ALSO still
// moves Cash in Hand, since Labour is real cash the shop is tracking
// separately, not a replacement pool of money the way Bank/Grain Stock
// are. Manual add/withdraw here (e.g. actually paying a labourer their
// wages) never touches any customer.
export default function LabourPage() {
  const { toast, confirm } = useToast();
  const [summary, setSummary] = useState<LabourSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [rangeMode, setRangeMode] = useState<LabourHistoryRangeMode>('all');
  const [customFrom, setCustomFrom] = useState(todayDateInputValue());
  const [customTo, setCustomTo] = useState(todayDateInputValue());

  const amountValue = Number(amount) || 0;
  const balance = summary?.balance || 0;
  const history = useMemo(() => summary?.history || [], [summary]);

  useEffect(() => {
    void loadSummary();
  }, []);

  const loadSummary = async () => {
    setLoading(true);
    try {
      const data = await fetchLabourSummary();
      if (data) setSummary(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load Labour Khata.');
    } finally {
      setLoading(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await loadSummary();
    } finally {
      setRefreshing(false);
    }
  };

  const filteredHistory = useMemo(() => {
    if (rangeMode === 'all') return history;
    if (rangeMode === 'today') {
      const todayStr = todayDateInputValue();
      return history.filter((e) => {
        const d = new Date(e.createdAt);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
    }
    if (rangeMode === 'month') {
      const now = new Date();
      return history.filter((e) => isSameCalendarMonth(e.createdAt, now));
    }
    if (!customFrom || !customTo) return history;
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59.999`);
    return history.filter((e) => {
      const d = new Date(e.createdAt);
      return d >= from && d <= to;
    });
  }, [history, rangeMode, customFrom, customTo]);

  const rangeLabel =
    rangeMode === 'today' ? 'Today'
    : rangeMode === 'month' ? 'This Month'
    : rangeMode === 'custom' ? `${customFrom} to ${customTo}`
    : 'All Time';

  async function handleDownloadPdf() {
    setIsDownloadingPdf(true);
    try {
      const { ReportPdfDocument, downloadPdfDocument } = await import('@/lib/pdf-export');
      const totalIn = filteredHistory.filter(e => e.direction === 'in').reduce((sum, e) => sum + e.amount, 0);
      const totalOut = filteredHistory.filter(e => e.direction === 'out').reduce((sum, e) => sum + e.amount, 0);
      const doc = (
        <ReportPdfDocument
          title="Labour Khata Statement"
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
              rows: filteredHistory.map((entry) => {
                const isIn = entry.direction === 'in';
                const who = entry.relatedCustomerName
                  ? (isIn ? `Received from ${entry.relatedCustomerName}` : `Given to ${entry.relatedCustomerName}`)
                  : '';
                return [
                  new Date(entry.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
                  isIn ? 'In' : 'Out',
                  [who, entry.note].filter(Boolean).join(' - ') || '—',
                  entry.createdBy || '—',
                  isIn ? `Rs ${entry.amount.toLocaleString()}` : '—',
                  isIn ? '—' : `Rs ${entry.amount.toLocaleString()}`,
                  `Rs ${entry.balanceAfter.toLocaleString()}`,
                ];
              }),
              footer: ['', '', '', 'Total', `Rs ${totalIn.toLocaleString()}`, `Rs ${totalOut.toLocaleString()}`, `Rs ${balance.toLocaleString()}`],
              emptyMessage: 'No transactions recorded yet.',
            },
          ]}
        />
      );
      await downloadPdfDocument(doc, `labour_khata_statement.pdf`);
    } finally {
      setIsDownloadingPdf(false);
    }
  }

  const record = async (direction: 'in' | 'out') => {
    if (amountValue <= 0) return;
    if (direction === 'out') {
      const confirmed = await confirm(`Withdraw ₨${amountValue} from Labour Khata?`, { title: 'Withdraw', confirmText: 'Withdraw', tone: 'danger' });
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const updated = await adjustLabour(amountValue, direction, note.trim());
      if (!updated) {
        toast.error('Could not record transaction.');
        return;
      }
      setSummary(updated);
      setAmount('');
      setNote('');
      toast.success(direction === 'in' ? 'Amount added.' : 'Withdrawal recorded.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not record transaction.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            Labour Khata <HardHat className="text-orange-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">
            Money tracked for labour - a Customer Dues payment made "via Labour" moves both this khata and Cash in Hand together.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={refreshing}
          className="flex items-center gap-2 px-5 py-3 bg-white border border-slate-200 text-slate-700 rounded-2xl font-black hover:bg-slate-50 transition-all shadow-sm disabled:opacity-60"
        >
          <RefreshCcw size={16} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-center p-10 text-slate-500 font-bold">Loading Labour Khata...</div>
      ) : (
        <div className="bg-white rounded-[28px] border border-slate-200 shadow-sm p-6 space-y-5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className={`text-3xl font-black ${balance < 0 ? 'text-red-600' : 'text-emerald-600'}`}>₨{balance.toLocaleString()}</p>
              <p className="text-[11px] font-bold text-slate-400">Current balance</p>
            </div>
            <button
              type="button"
              onClick={() => void handleDownloadPdf()}
              disabled={isDownloadingPdf}
              title="Download the complete Labour Khata statement as a PDF"
              className="flex shrink-0 items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-xl font-bold text-[11px] transition-colors shadow-sm"
            >
              <Download size={13} /> {isDownloadingPdf ? 'Preparing...' : 'PDF'}
            </button>
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <input
                type="number"
                placeholder="Enter amount..."
                value={amount}
                onChange={e => setAmount(e.target.value)}
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:border-orange-500"
              />
              <input
                type="text"
                placeholder="Note (optional)"
                value={note}
                onChange={e => setNote(e.target.value)}
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold outline-none focus:border-orange-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void record('in')}
                disabled={saving || amountValue <= 0}
                className="flex-1 flex items-center justify-center gap-1.5 bg-green-100 hover:bg-green-200 text-green-700 disabled:opacity-50 disabled:cursor-not-allowed py-2.5 rounded-xl font-bold text-xs transition-colors"
              >
                <ArrowDownCircle size={14} /> {saving ? 'Saving...' : 'Add Amount'}
              </button>
              <button
                onClick={() => void record('out')}
                disabled={saving || amountValue <= 0}
                className="flex-1 flex items-center justify-center gap-1.5 bg-red-100 hover:bg-red-200 text-red-700 disabled:opacity-50 disabled:cursor-not-allowed py-2.5 rounded-xl font-bold text-xs transition-colors"
              >
                <ArrowUpCircle size={14} /> Withdraw
              </button>
            </div>
          </div>

          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowHistory(v => !v)}
              className="flex w-full items-center justify-between text-xs font-black text-slate-500 hover:text-slate-800"
            >
              History ({history.length})
              {showHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showHistory ? (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {(['all', 'today', 'month', 'custom'] as LabourHistoryRangeMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setRangeMode(mode)}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition-colors ${
                        rangeMode === mode ? 'bg-orange-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      }`}
                    >
                      {mode === 'all' ? 'All' : mode === 'today' ? 'Today' : mode === 'month' ? 'This Month' : 'Custom'}
                    </button>
                  ))}
                </div>
                {rangeMode === 'custom' ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="flex-1 p-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold outline-none focus:border-orange-500"
                    />
                    <span className="text-[10px] font-bold text-slate-400">to</span>
                    <input
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="flex-1 p-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold outline-none focus:border-orange-500"
                    />
                  </div>
                ) : null}
                <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                {filteredHistory.length === 0 ? (
                  <p className="text-[11px] font-bold text-slate-400 text-center py-3">No transactions in this range.</p>
                ) : null}
                {filteredHistory.map((entry, index) => {
                  const isIn = entry.direction === 'in';
                  const who = entry.relatedCustomerName
                    ? (isIn ? `Received from ${entry.relatedCustomerName}` : `Given to ${entry.relatedCustomerName}`)
                    : (isIn ? 'Amount added' : 'Withdrawal');
                  return (
                    <div key={`${entry.createdAt}-${index}`} className="rounded-xl bg-slate-50 border border-slate-100 p-2.5">
                      <div className="flex items-center justify-between">
                        <span className={`text-sm font-black ${isIn ? 'text-green-600' : 'text-red-600'}`}>
                          {isIn ? '+' : '-'} ₨{entry.amount.toLocaleString()}
                        </span>
                        <span className="text-[10px] font-bold text-slate-400">
                          {new Date(entry.createdAt).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' })}
                        </span>
                      </div>
                      <p className="text-xs font-bold text-slate-600">{who}</p>
                      {entry.note ? <p className="text-[11px] text-slate-400">{entry.note}</p> : null}
                      <p className="text-[10px] font-bold text-slate-300">Balance after: ₨{entry.balanceAfter.toLocaleString()}</p>
                    </div>
                  );
                })}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
