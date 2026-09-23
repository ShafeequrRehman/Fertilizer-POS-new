import React, { useEffect, useMemo, useState } from 'react';
import { fetchBanks, createBank, addBankTransaction } from '@/lib/pos-api';
import { Bank } from '@/lib/pos-types';
import { Landmark, Plus, RefreshCcw, Save, X, ArrowDownCircle, ArrowUpCircle, ChevronDown, ChevronUp, Download } from 'lucide-react';
import { useToast } from '@/lib/toast';

// Task 3's "bank ki bhi history ho ... date wise wala bhe option ho" - same
// All/Today/This Month/Custom pattern already used for the Ingredient
// Stock Ledger (IngredientStockSection.tsx) and Record page, just this
// component's own local copy since those helpers aren't exported.
type BankHistoryRangeMode = 'all' | 'today' | 'month' | 'custom';

function isSameCalendarMonth(value: string, reference: Date) {
  const d = new Date(value);
  return d.getFullYear() === reference.getFullYear() && d.getMonth() === reference.getMonth();
}

function todayDateInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The shop's own bank ledger - same "khata" idea as Customer Dues
// (DuesPage.tsx), just flipped: instead of a customer owing the shop, the
// shop keeps its own money in these accounts. Adding a bank here (with an
// optional opening payment) is what makes it available to pick from the
// Customer Dues page's "Cash / Bank" payment-method choice - a customer
// paid "via Bank" deposits into whichever bank was picked, and a customer
// "+ Add Dues"-d money via bank withdraws from it, both recorded
// automatically (see backend/controllers/customerController.js). Manual
// deposits/withdrawals recorded directly here (e.g. the very first
// "add my bank, add a payment" step) never touch any customer.
export default function BankPage() {
  const { toast, confirm } = useToast();
  const [banks, setBanks] = useState<Bank[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddBank, setShowAddBank] = useState(false);
  const [newBank, setNewBank] = useState({ name: '', openingAmount: '', note: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadBanks();
  }, []);

  const loadBanks = async () => {
    setLoading(true);
    try {
      const data = await fetchBanks();
      if (data) setBanks(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load banks.');
    } finally {
      setLoading(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await loadBanks();
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddBank = async () => {
    const name = newBank.name.trim();
    if (!name) {
      toast.error('Bank name is required.');
      return;
    }
    setSaving(true);
    try {
      const created = await createBank(name, Number(newBank.openingAmount) || 0, newBank.note.trim());
      if (!created) {
        toast.error('Could not add bank.');
        return;
      }
      setShowAddBank(false);
      setNewBank({ name: '', openingAmount: '', note: '' });
      toast.success(`"${created.name}" added.`);
      await loadBanks();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add bank.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            Bank <Landmark className="text-indigo-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">
            Your own bank accounts - add a payment here to deposit into one, or pick one from Customer Dues when a payment goes through the bank.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={refreshing}
            className="flex items-center gap-2 px-5 py-3 bg-white border border-slate-200 text-slate-700 rounded-2xl font-black hover:bg-slate-50 transition-all shadow-sm disabled:opacity-60"
          >
            <RefreshCcw size={16} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => setShowAddBank(true)}
            className="flex items-center gap-2 px-6 py-3 border-[0.5px] border-white/20 bg-black text-white rounded-2xl font-black hover:bg-slate-800 transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_-3px_7px_rgba(0,0,0,0.5)]"
          >
            <Plus size={18} /> Add Bank
          </button>
        </div>
      </div>

      {showAddBank ? (
        <div className="bg-white p-6 rounded-[28px] border border-slate-200 shadow-sm space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-black">New Bank</h2>
            <button onClick={() => setShowAddBank(false)} className="text-slate-400 hover:text-red-500"><X size={20} /></button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input
              type="text"
              placeholder="Bank name (e.g. MCB Bank)"
              value={newBank.name}
              onChange={e => setNewBank({ ...newBank, name: e.target.value })}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="number"
              placeholder="First payment (optional)"
              value={newBank.openingAmount}
              onChange={e => setNewBank({ ...newBank, openingAmount: e.target.value })}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="text"
              placeholder="Note (optional)"
              value={newBank.note}
              onChange={e => setNewBank({ ...newBank, note: e.target.value })}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <button
            onClick={() => void handleAddBank()}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 disabled:opacity-60"
          >
            <Save size={16} /> {saving ? 'Saving...' : 'Save Bank'}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="text-center p-10 text-slate-500 font-bold">Loading banks...</div>
      ) : banks.length === 0 ? (
        <div className="text-center p-10 text-slate-400 font-bold bg-white rounded-[28px] border border-slate-200">
          No banks added yet. Click "Add Bank" to add your first one.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-6">
          {banks.map(bank => (
            <BankCard key={bank.id} bank={bank} onChanged={loadBanks} confirm={confirm} toast={toast} />
          ))}
        </div>
      )}
    </div>
  );
}

function BankCard({ bank, onChanged, confirm, toast }: {
  bank: Bank;
  onChanged: () => Promise<void>;
  confirm: ReturnType<typeof useToast>['confirm'];
  toast: ReturnType<typeof useToast>['toast'];
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [rangeMode, setRangeMode] = useState<BankHistoryRangeMode>('all');
  const [customFrom, setCustomFrom] = useState(todayDateInputValue());
  const [customTo, setCustomTo] = useState(todayDateInputValue());

  const amountValue = Number(amount) || 0;

  // Date-filtered view of this bank's own history - used by both the
  // on-screen History list and the downloaded PDF below. `bank.balance`/
  // `bank.history[].balanceAfter` are always left untouched (true all-time
  // running values) regardless of this filter, same rule the Ingredient
  // Ledger's own range filter follows.
  const filteredHistory = useMemo(() => {
    if (rangeMode === 'all') return bank.history;
    if (rangeMode === 'today') {
      const todayStr = todayDateInputValue();
      return bank.history.filter((e) => {
        const d = new Date(e.createdAt);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
    }
    if (rangeMode === 'month') {
      const now = new Date();
      return bank.history.filter((e) => isSameCalendarMonth(e.createdAt, now));
    }
    if (!customFrom || !customTo) return bank.history;
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59.999`);
    return bank.history.filter((e) => {
      const d = new Date(e.createdAt);
      return d >= from && d <= to;
    });
  }, [bank.history, rangeMode, customFrom, customTo]);

  const rangeLabel =
    rangeMode === 'today' ? 'Today'
    : rangeMode === 'month' ? 'This Month'
    : rangeMode === 'custom' ? `${customFrom} to ${customTo}`
    : 'All Time';

  // Bank Statement PDF - same "title, stats, one table" ReportPdfDocument
  // building block DuesPage.tsx's own Dues Statement PDF uses (see
  // buildDuesStatementDoc there), just for this bank's own history instead
  // of a customer's. Unlike that customer statement, no running-balance
  // replay is needed here - each entry's balanceAfter was computed and
  // stored server-side at the moment it happened (bankController.js), so
  // it's already exactly right; this just reads it straight off.
  async function handleDownloadPdf() {
    setIsDownloadingPdf(true);
    try {
      const { ReportPdfDocument, downloadPdfDocument } = await import('@/lib/pdf-export');
      const totalDeposits = filteredHistory.filter(e => e.type === 'deposit').reduce((sum, e) => sum + e.amount, 0);
      const totalWithdrawals = filteredHistory.filter(e => e.type === 'withdrawal').reduce((sum, e) => sum + e.amount, 0);
      const doc = (
        <ReportPdfDocument
          title="Bank Statement"
          subtitle={`${bank.name} - ${rangeLabel}`}
          // Same Total In / Total Out / Net stat-box style, and the same
          // Date/Type/Note/By/In/Out/Balance table shape, as every other
          // In-Out PDF in this app (Cash in Hand History, Correction
          // History, Recovery History) - the owner's own ask was for one
          // consistent PDF look everywhere.
          stats={[
            { label: 'Total In', value: `Rs ${totalDeposits.toLocaleString()}` },
            { label: 'Total Out', value: `Rs ${totalWithdrawals.toLocaleString()}` },
            { label: 'Net', value: `Rs ${(totalDeposits - totalWithdrawals).toLocaleString()}` },
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
              // Newest-first, same order the on-screen History list above
              // already shows (bank.history comes back sorted that way -
              // see bankController.js's serializeBank).
              rows: filteredHistory.map((entry) => {
                const isIn = entry.type === 'deposit';
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
              footer: ['', '', '', 'Total', `Rs ${totalDeposits.toLocaleString()}`, `Rs ${totalWithdrawals.toLocaleString()}`, `Rs ${bank.balance.toLocaleString()}`],
              emptyMessage: 'No transactions recorded for this bank yet.',
            },
          ]}
        />
      );
      await downloadPdfDocument(doc, `${bank.name.replace(/\s+/g, '_')}_bank_statement.pdf`);
    } finally {
      setIsDownloadingPdf(false);
    }
  }

  const record = async (type: 'deposit' | 'withdrawal') => {
    if (amountValue <= 0) return;
    if (type === 'withdrawal') {
      const confirmed = await confirm(`Withdraw ₨${amountValue} from ${bank.name}?`, { title: 'Withdraw', confirmText: 'Withdraw', tone: 'danger' });
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const updated = await addBankTransaction(bank.id, type, amountValue, note.trim());
      if (!updated) {
        toast.error('Could not record transaction.');
        return;
      }
      setAmount('');
      setNote('');
      toast.success(type === 'deposit' ? 'Payment added.' : 'Withdrawal recorded.');
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not record transaction.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-[28px] border border-slate-200 shadow-sm p-5 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-lg font-black text-slate-900">{bank.name}</p>
          <p className={`text-2xl font-black ${bank.balance < 0 ? 'text-red-600' : 'text-emerald-600'}`}>₨{bank.balance.toLocaleString()}</p>
          <p className="text-[11px] font-bold text-slate-400">Current balance</p>
        </div>
        <button
          type="button"
          onClick={() => void handleDownloadPdf()}
          disabled={isDownloadingPdf}
          title="Download this bank's complete statement as a PDF"
          className="flex shrink-0 items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-xl font-bold text-[11px] transition-colors shadow-sm"
        >
          <Download size={13} /> {isDownloadingPdf ? 'Preparing...' : 'PDF'}
        </button>
      </div>

      <div className="space-y-2">
        <input
          type="number"
          placeholder="Enter amount..."
          value={amount}
          onChange={e => setAmount(e.target.value)}
          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:border-indigo-500"
        />
        <input
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={e => setNote(e.target.value)}
          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold outline-none focus:border-indigo-500"
        />
        <div className="flex gap-2">
          <button
            onClick={() => void record('deposit')}
            disabled={saving || amountValue <= 0}
            className="flex-1 flex items-center justify-center gap-1.5 bg-green-100 hover:bg-green-200 text-green-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
          >
            <ArrowDownCircle size={14} /> {saving ? 'Saving...' : 'Add Payment'}
          </button>
          <button
            onClick={() => void record('withdrawal')}
            disabled={saving || amountValue <= 0 || amountValue > bank.balance}
            title={amountValue > bank.balance ? `Can't exceed the ₨${bank.balance} available` : 'Withdraw from this bank'}
            className="flex-1 flex items-center justify-center gap-1.5 bg-red-100 hover:bg-red-200 text-red-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
          >
            <ArrowUpCircle size={14} /> Withdraw
          </button>
        </div>
      </div>

      {bank.history.length > 0 ? (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowHistory(v => !v)}
            className="flex w-full items-center justify-between text-xs font-black text-slate-500 hover:text-slate-800"
          >
            History ({bank.history.length})
            {showHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showHistory ? (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {(['all', 'today', 'month', 'custom'] as BankHistoryRangeMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setRangeMode(mode)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition-colors ${
                      rangeMode === mode ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
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
                    className="flex-1 p-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold outline-none focus:border-indigo-500"
                  />
                  <span className="text-[10px] font-bold text-slate-400">to</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="flex-1 p-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold outline-none focus:border-indigo-500"
                  />
                </div>
              ) : null}
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {filteredHistory.length === 0 ? (
                <p className="text-[11px] font-bold text-slate-400 text-center py-3">No transactions in this range.</p>
              ) : null}
              {filteredHistory.map((entry, index) => {
                const isIn = entry.type === 'deposit';
                const who = entry.relatedCustomerName
                  ? (isIn ? `Received from ${entry.relatedCustomerName}` : `Given to ${entry.relatedCustomerName}`)
                  : (isIn ? 'Payment added' : 'Withdrawal');
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
      ) : null}
    </div>
  );
}
