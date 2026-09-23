import React, { useEffect, useMemo, useState } from 'react';
import { fetchGrains, createGrain, addGrainTransaction } from '@/lib/pos-api';
import { Grain } from '@/lib/pos-types';
import { Wheat, Plus, RefreshCcw, Save, X, ArrowDownCircle, ArrowUpCircle, ChevronDown, ChevronUp, Download } from 'lucide-react';
import { useToast } from '@/lib/toast';

// Same All/Today/This Month/Custom history-range pattern as BankPage.tsx's
// own local copy - kept separate here too since those helpers aren't
// exported from anywhere shared.
type GrainHistoryRangeMode = 'all' | 'today' | 'month' | 'custom';

function isSameCalendarMonth(value: string, reference: Date) {
  const d = new Date(value);
  return d.getFullYear() === reference.getFullYear() && d.getMonth() === reference.getMonth();
}

function todayDateInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The shop's own grain stock khata - same idea as Bank (BankPage.tsx), but
// tracking grain (Rice, Gandam, ...) instead of money: each grain has a
// running kg total AND a running rupee value, side by side. Adding a grain
// here (with optional opening kg/amount) is what makes it available to
// pick from the Customer Dues page's payment-method choice - a customer
// who pays their dues in grain instead of cash deposits kg+value into
// whichever grain was picked, and a customer "+ Add Dues"-d grain as
// credit withdraws from it, both recorded automatically (see
// backend/controllers/customerController.js). Manual deposits/withdrawals
// recorded directly here never touch any customer.
export default function GrainStockPage() {
  const { toast, confirm } = useToast();
  const [grains, setGrains] = useState<Grain[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddGrain, setShowAddGrain] = useState(false);
  const [newGrain, setNewGrain] = useState({ name: '', openingKg: '', openingAmount: '', note: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadGrains();
  }, []);

  const loadGrains = async () => {
    setLoading(true);
    try {
      const data = await fetchGrains();
      if (data) setGrains(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load grain stock.');
    } finally {
      setLoading(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await loadGrains();
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddGrain = async () => {
    const name = newGrain.name.trim();
    if (!name) {
      toast.error('Grain name is required.');
      return;
    }
    setSaving(true);
    try {
      const created = await createGrain(name, Number(newGrain.openingKg) || 0, Number(newGrain.openingAmount) || 0, newGrain.note.trim());
      if (!created) {
        toast.error('Could not add grain.');
        return;
      }
      setShowAddGrain(false);
      setNewGrain({ name: '', openingKg: '', openingAmount: '', note: '' });
      toast.success(`"${created.name}" added.`);
      await loadGrains();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add grain.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            Grain Stock <Wheat className="text-amber-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">
            Your own grain stock (Rice, Gandam, ...) - add kg+amount here, or pick a grain from Customer Dues when a payment comes in as grain.
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
            onClick={() => setShowAddGrain(true)}
            className="flex items-center gap-2 px-6 py-3 border-[0.5px] border-white/20 bg-black text-white rounded-2xl font-black hover:bg-slate-800 transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_-3px_7px_rgba(0,0,0,0.5)]"
          >
            <Plus size={18} /> Add Grain
          </button>
        </div>
      </div>

      {showAddGrain ? (
        <div className="bg-white p-6 rounded-[28px] border border-slate-200 shadow-sm space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-black">New Grain</h2>
            <button onClick={() => setShowAddGrain(false)} className="text-slate-400 hover:text-red-500"><X size={20} /></button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <input
              type="text"
              placeholder="Grain name (e.g. Rice)"
              value={newGrain.name}
              onChange={e => setNewGrain({ ...newGrain, name: e.target.value })}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-amber-500"
            />
            <input
              type="number"
              placeholder="Opening kg (optional)"
              value={newGrain.openingKg}
              onChange={e => setNewGrain({ ...newGrain, openingKg: e.target.value })}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-amber-500"
            />
            <input
              type="number"
              placeholder="Opening amount (optional)"
              value={newGrain.openingAmount}
              onChange={e => setNewGrain({ ...newGrain, openingAmount: e.target.value })}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-amber-500"
            />
            <input
              type="text"
              placeholder="Note (optional)"
              value={newGrain.note}
              onChange={e => setNewGrain({ ...newGrain, note: e.target.value })}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>
          <button
            onClick={() => void handleAddGrain()}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-amber-600 text-white rounded-xl font-bold hover:bg-amber-700 disabled:opacity-60"
          >
            <Save size={16} /> {saving ? 'Saving...' : 'Save Grain'}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="text-center p-10 text-slate-500 font-bold">Loading grain stock...</div>
      ) : grains.length === 0 ? (
        <div className="text-center p-10 text-slate-400 font-bold bg-white rounded-[28px] border border-slate-200">
          No grain added yet. Click "Add Grain" to add your first one (e.g. Rice).
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-6">
          {grains.map(grain => (
            <GrainCard key={grain.id} grain={grain} onChanged={loadGrains} confirm={confirm} toast={toast} />
          ))}
        </div>
      )}
    </div>
  );
}

function GrainCard({ grain, onChanged, confirm, toast }: {
  grain: Grain;
  onChanged: () => Promise<void>;
  confirm: ReturnType<typeof useToast>['confirm'];
  toast: ReturnType<typeof useToast>['toast'];
}) {
  const [kg, setKg] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [rangeMode, setRangeMode] = useState<GrainHistoryRangeMode>('all');
  const [customFrom, setCustomFrom] = useState(todayDateInputValue());
  const [customTo, setCustomTo] = useState(todayDateInputValue());

  const kgValue = Number(kg) || 0;
  const amountValue = Number(amount) || 0;

  // Date-filtered view of this grain's own history - used by both the
  // on-screen History list and the downloaded PDF below. `grain.totalKg`/
  // `grain.balance`/`grain.history[].balanceAfter*` are always left
  // untouched (true all-time running values) regardless of this filter,
  // same rule BankPage.tsx's own range filter follows.
  const filteredHistory = useMemo(() => {
    if (rangeMode === 'all') return grain.history;
    if (rangeMode === 'today') {
      const todayStr = todayDateInputValue();
      return grain.history.filter((e) => {
        const d = new Date(e.createdAt);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
    }
    if (rangeMode === 'month') {
      const now = new Date();
      return grain.history.filter((e) => isSameCalendarMonth(e.createdAt, now));
    }
    if (!customFrom || !customTo) return grain.history;
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59.999`);
    return grain.history.filter((e) => {
      const d = new Date(e.createdAt);
      return d >= from && d <= to;
    });
  }, [grain.history, rangeMode, customFrom, customTo]);

  const rangeLabel =
    rangeMode === 'today' ? 'Today'
    : rangeMode === 'month' ? 'This Month'
    : rangeMode === 'custom' ? `${customFrom} to ${customTo}`
    : 'All Time';

  // Grain Stock Statement PDF - same "title, stats, one table"
  // ReportPdfDocument building block BankPage.tsx's own Bank Statement PDF
  // uses, just with an extra Kg column since this khata tracks stock
  // alongside money.
  async function handleDownloadPdf() {
    setIsDownloadingPdf(true);
    try {
      const { ReportPdfDocument, downloadPdfDocument } = await import('@/lib/pdf-export');
      const totalInKg = filteredHistory.filter(e => e.type === 'deposit').reduce((sum, e) => sum + e.kg, 0);
      const totalOutKg = filteredHistory.filter(e => e.type === 'withdrawal').reduce((sum, e) => sum + e.kg, 0);
      const totalDeposits = filteredHistory.filter(e => e.type === 'deposit').reduce((sum, e) => sum + e.amount, 0);
      const totalWithdrawals = filteredHistory.filter(e => e.type === 'withdrawal').reduce((sum, e) => sum + e.amount, 0);
      const doc = (
        <ReportPdfDocument
          title="Grain Stock Statement"
          subtitle={`${grain.name} - ${rangeLabel}`}
          stats={[
            { label: 'Total In (kg)', value: `${totalInKg.toLocaleString()} kg` },
            { label: 'Total Out (kg)', value: `${totalOutKg.toLocaleString()} kg` },
            { label: 'Total In (Rs)', value: `Rs ${totalDeposits.toLocaleString()}` },
            { label: 'Total Out (Rs)', value: `Rs ${totalWithdrawals.toLocaleString()}` },
          ]}
          tables={[
            {
              title: 'History',
              columns: [
                { label: 'Date', width: 1.2 },
                { label: 'Type', width: 0.7 },
                { label: 'Note', width: 1.6 },
                { label: 'By', width: 0.8 },
                { label: 'Kg In', width: 0.7, align: 'right' },
                { label: 'Kg Out', width: 0.7, align: 'right' },
                { label: 'Rs', width: 0.9, align: 'right' },
                { label: 'Balance', width: 1, align: 'right' },
              ],
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
                  isIn ? `${entry.kg.toLocaleString()} kg` : '—',
                  isIn ? '—' : `${entry.kg.toLocaleString()} kg`,
                  `Rs ${entry.amount.toLocaleString()}`,
                  `${entry.balanceAfterKg.toLocaleString()} kg / Rs ${entry.balanceAfter.toLocaleString()}`,
                ];
              }),
              footer: ['', '', '', 'Total', `${totalInKg.toLocaleString()} kg`, `${totalOutKg.toLocaleString()} kg`, `Rs ${(totalDeposits - totalWithdrawals).toLocaleString()}`, `${grain.totalKg.toLocaleString()} kg / Rs ${grain.balance.toLocaleString()}`],
              emptyMessage: 'No transactions recorded for this grain yet.',
            },
          ]}
        />
      );
      await downloadPdfDocument(doc, `${grain.name.replace(/\s+/g, '_')}_grain_statement.pdf`);
    } finally {
      setIsDownloadingPdf(false);
    }
  }

  const record = async (type: 'deposit' | 'withdrawal') => {
    if (kgValue <= 0 && amountValue <= 0) return;
    if (type === 'withdrawal') {
      const confirmed = await confirm(`Withdraw ${kgValue}kg / ₨${amountValue} from ${grain.name}?`, { title: 'Withdraw', confirmText: 'Withdraw', tone: 'danger' });
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const updated = await addGrainTransaction(grain.id, type, kgValue, amountValue, note.trim());
      if (!updated) {
        toast.error('Could not record transaction.');
        return;
      }
      setKg('');
      setAmount('');
      setNote('');
      toast.success(type === 'deposit' ? 'Stock added.' : 'Withdrawal recorded.');
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not record transaction.');
    } finally {
      setSaving(false);
    }
  };

  const canWithdraw = kgValue > 0 && amountValue > 0 && kgValue <= grain.totalKg && amountValue <= grain.balance;

  return (
    <div className="bg-white rounded-[28px] border border-slate-200 shadow-sm p-5 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-lg font-black text-slate-900">{grain.name}</p>
          <p className={`text-2xl font-black ${grain.totalKg < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{grain.totalKg.toLocaleString()} kg</p>
          <p className={`text-sm font-black ${grain.balance < 0 ? 'text-red-600' : 'text-emerald-600'}`}>₨{grain.balance.toLocaleString()}</p>
          <p className="text-[11px] font-bold text-slate-400">Current stock</p>
        </div>
        <button
          type="button"
          onClick={() => void handleDownloadPdf()}
          disabled={isDownloadingPdf}
          title="Download this grain's complete statement as a PDF"
          className="flex shrink-0 items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-xl font-bold text-[11px] transition-colors shadow-sm"
        >
          <Download size={13} /> {isDownloadingPdf ? 'Preparing...' : 'PDF'}
        </button>
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            placeholder="Kg..."
            value={kg}
            onChange={e => setKg(e.target.value)}
            className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:border-amber-500"
          />
          <input
            type="number"
            placeholder="Amount..."
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:border-amber-500"
          />
        </div>
        <input
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={e => setNote(e.target.value)}
          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold outline-none focus:border-amber-500"
        />
        <div className="flex gap-2">
          <button
            onClick={() => void record('deposit')}
            disabled={saving || (kgValue <= 0 && amountValue <= 0)}
            className="flex-1 flex items-center justify-center gap-1.5 bg-green-100 hover:bg-green-200 text-green-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
          >
            <ArrowDownCircle size={14} /> {saving ? 'Saving...' : 'Add Stock'}
          </button>
          <button
            onClick={() => void record('withdrawal')}
            disabled={saving || !canWithdraw}
            title={!canWithdraw ? `Enter both kg and amount, not more than the ${grain.totalKg}kg / ₨${grain.balance} available` : 'Withdraw from this grain stock'}
            className="flex-1 flex items-center justify-center gap-1.5 bg-red-100 hover:bg-red-200 text-red-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
          >
            <ArrowUpCircle size={14} /> Withdraw
          </button>
        </div>
      </div>

      {grain.history.length > 0 ? (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowHistory(v => !v)}
            className="flex w-full items-center justify-between text-xs font-black text-slate-500 hover:text-slate-800"
          >
            History ({grain.history.length})
            {showHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showHistory ? (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {(['all', 'today', 'month', 'custom'] as GrainHistoryRangeMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setRangeMode(mode)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition-colors ${
                      rangeMode === mode ? 'bg-amber-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
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
                    className="flex-1 p-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold outline-none focus:border-amber-500"
                  />
                  <span className="text-[10px] font-bold text-slate-400">to</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="flex-1 p-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold outline-none focus:border-amber-500"
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
                  : (isIn ? 'Stock added' : 'Withdrawal');
                return (
                  <div key={`${entry.createdAt}-${index}`} className="rounded-xl bg-slate-50 border border-slate-100 p-2.5">
                    <div className="flex items-center justify-between">
                      <span className={`text-sm font-black ${isIn ? 'text-green-600' : 'text-red-600'}`}>
                        {isIn ? '+' : '-'} {entry.kg.toLocaleString()} kg (₨{entry.amount.toLocaleString()})
                      </span>
                      <span className="text-[10px] font-bold text-slate-400">
                        {new Date(entry.createdAt).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' })}
                      </span>
                    </div>
                    <p className="text-xs font-bold text-slate-600">{who}</p>
                    {entry.note ? <p className="text-[11px] text-slate-400">{entry.note}</p> : null}
                    <p className="text-[10px] font-bold text-slate-300">Balance after: {entry.balanceAfterKg.toLocaleString()} kg / ₨{entry.balanceAfter.toLocaleString()}</p>
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
