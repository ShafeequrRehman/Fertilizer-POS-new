import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3, PieChart, Receipt, Wallet,
  ArrowUpCircle, ArrowDownCircle, Scale,
  ChevronRight, Download, Plus, FileText, Trash2, X, AlertCircle,
} from 'lucide-react';
import { fetchDayEndReport, fetchExpenses, createExpense, deleteExpense, fetchLedgerTransactions } from '@/lib/pos-api';
import { DayEndReport, Expense, LedgerTransaction } from '@/lib/pos-types';
import { useToast } from '@/lib/toast';
import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';

// This page used to be a static mockup - every figure below (Total Balance,
// Total Revenue, Op. Expenses, the General Ledger rows, the Budgeting
// percentages) was a hardcoded placeholder number, and Export PDF/Add Entry
// did nothing at all. It's now wired to the same real backend this shop's
// Reports page already uses: reportController.getDayEndReport for the
// revenue/expense/profit figures (identical math, just surfaced in this
// page's own card layout) and the Expense model (backend/models/Expense.js)
// for the ledger rows themselves - Add Entry creates a real Expense, Export
// PDF renders whatever's actually on screen. There is deliberately no
// synthetic "income" ledger row (the old mockup's "Daily POS Settlement"
// line) - Expense has no notion of income, and inventing one here would
// just be dummy data in a different shape. Real per-order revenue detail
// already lives on Sales/Record; this page's ledger is honestly scoped to
// the expenses a shop owner actually logs.

// en-CA formats as YYYY-MM-DD in the browser's LOCAL time zone (unlike
// toISOString, which is UTC) - matches the date input's own value format
// and the backend's plain YYYY-MM-DD query-param convention (see
// reportController.resolveRange). Same helper ReportsPage.tsx/RecordPage.tsx
// already use for the same reason.
function toDateKey(date: Date) {
  return date.toLocaleDateString('en-CA');
}

function formatMoney(amount: number) {
  return `Rs ${Math.round(amount).toLocaleString()}`;
}

type Preset = 'daily' | 'monthly' | 'yearly' | 'custom';

function computePresetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  if (preset === 'monthly') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: toDateKey(first), to: toDateKey(now) };
  }
  if (preset === 'yearly') {
    const first = new Date(now.getFullYear(), 0, 1);
    return { from: toDateKey(first), to: toDateKey(now) };
  }
  return { from: toDateKey(now), to: toDateKey(now) };
}

// Kept in sync with ReportsPage.tsx's own EXPENSE_CATEGORIES list - both
// pages log against the very same Expense collection, so the same presets
// make sense here. Free text is still accepted (see the "quick picks" row
// below) - this is just a convenience shortlist, not an enum on the model.
const EXPENSE_CATEGORIES = [
  'Gas', 'Electricity', 'Water', 'Wages', 'Damage / Waste', 'Rent', 'Maintenance', 'Other',
];

function AddEntryModal({
  onClose,
  onSubmit,
  submitting,
  defaultDate,
}: {
  onClose: () => void;
  onSubmit: (input: { category: string; amount: number; date: string; note: string }) => void;
  submitting: boolean;
  defaultDate: string;
}) {
  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(defaultDate);

  function submit() {
    onSubmit({ category: category.trim(), amount: Number(amount), date, note: note.trim() });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-md flex-col rounded-[32px] bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <h2 className="text-xl font-black text-slate-900">Add Ledger Entry</h2>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-50 p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div>
            <label className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">Category</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Rent, Electricity, Wages"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:border-indigo-400 focus:bg-white"
            />
            {/* Deliberately plain buttons, not a native <select>/<datalist> -
                see ReportsPage.tsx's InlineDropdown/CategoryComboBox comment
                on why: a native popup reloads the whole renderer in the
                packaged Electron app. */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXPENSE_CATEGORIES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setCategory(option)}
                  className={`rounded-lg px-2.5 py-1 text-[10px] font-black uppercase tracking-wide transition-colors ${
                    category === option ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">Amount</label>
            <input
              type="number"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:border-indigo-400 focus:bg-white"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">Date</label>
            <input
              type="date"
              value={date}
              max={toDateKey(new Date())}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:border-indigo-400 focus:bg-white"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">Note (optional)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What's this for?"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold outline-none focus:border-indigo-400 focus:bg-white"
            />
          </div>
        </div>

        <div className="border-t border-slate-100 p-6">
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="w-full rounded-2xl bg-black py-3.5 text-sm font-black text-white transition-all hover:scale-[1.02] disabled:opacity-60"
          >
            {submitting ? 'Saving...' : 'Save Entry'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AccountingPage() {
  const { popup, confirm } = useToast();
  const navigate = useNavigate();
  const todayKey = toDateKey(new Date());

  const [preset, setPreset] = useState<Preset>('monthly');
  const initialRange = computePresetRange('monthly');
  const [rangeFrom, setRangeFrom] = useState(initialRange.from);
  const [rangeTo, setRangeTo] = useState(initialRange.to);

  const [report, setReport] = useState<DayEndReport | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  // Shop Ledger (feature 6): the unified transaction list (cash sales,
  // credit sales, due payments, purchases, expenses) backing the General
  // Ledger table below - kept separate from `expenses` above, which stays
  // exactly as it was (still what Add Entry/delete actually operate on).
  const [ledgerTransactions, setLedgerTransactions] = useState<LedgerTransaction[]>([]);
  type LedgerFilter = 'all' | 'sale' | 'credit' | 'due_payment' | 'purchase' | 'expense';
  const [ledgerFilter, setLedgerFilter] = useState<LedgerFilter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [isSavingEntry, setIsSavingEntry] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);

  function applyPreset(next: Preset) {
    setPreset(next);
    const { from, to } = computePresetRange(next);
    setRangeFrom(from);
    setRangeTo(to);
  }

  async function loadAll() {
    if (!rangeFrom || !rangeTo) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [reportData, expenseData, ledgerData] = await Promise.all([
        fetchDayEndReport(rangeFrom, rangeTo),
        fetchExpenses(),
        fetchLedgerTransactions(rangeFrom, rangeTo),
      ]);
      if (reportData) setReport(reportData);
      setExpenses(expenseData || []);
      setLedgerTransactions(ledgerData?.rows || []);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not load accounting data.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeFrom, rangeTo]);

  // Expenses have no date-filter query param on the backend (see
  // ReportsPage.tsx's own comment on this) - filtered client-side against
  // whatever range is currently picked, same approach.
  const ledgerRows = useMemo(() => {
    if (!rangeFrom || !rangeTo) return [];
    const start = new Date(`${rangeFrom}T00:00:00.000Z`).getTime();
    const end = new Date(`${rangeTo}T23:59:59.999Z`).getTime();
    return expenses
      .filter((expense) => {
        const t = new Date(expense.date).getTime();
        return t >= start && t <= end;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [expenses, rangeFrom, rangeTo]);

  // Shop Ledger tabs (feature 6): filters the unified transaction list by
  // category so cash sales / credit sales / due payments / purchases /
  // expenses can each be viewed on their own, on top of the existing
  // Daily/Monthly/Yearly/Custom date presets above (ledgerTransactions is
  // already scoped to rangeFrom/rangeTo server-side - see loadAll).
  const filteredLedgerTransactions = useMemo(() => {
    return ledgerTransactions
      .filter((row) => {
        if (ledgerFilter === 'all') return true;
        if (ledgerFilter === 'sale') return row.type === 'sale' && !row.isCredit;
        if (ledgerFilter === 'credit') return row.type === 'sale' && row.isCredit;
        return row.type === ledgerFilter;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [ledgerTransactions, ledgerFilter]);

  const LEDGER_FILTER_TABS: { key: 'all' | 'sale' | 'credit' | 'due_payment' | 'purchase' | 'expense'; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'sale', label: 'Cash Sales' },
    { key: 'credit', label: 'Credit Sales' },
    { key: 'due_payment', label: 'Due Payments' },
    { key: 'purchase', label: 'Purchases' },
    { key: 'expense', label: 'Expenses' },
  ];

  const revenue = report?.revenue ?? 0;
  const otherExpenses = report?.otherExpenses ?? 0;
  const netProfit = report?.netProfit ?? 0;
  const orderCount = report?.orderCount ?? 0;
  const expensePctOfRevenue = revenue > 0 ? Math.round((otherExpenses / revenue) * 100) : 0;
  const marginPct = revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0;
  const marginBarWidth = Math.max(0, Math.min(100, marginPct));

  // Budgeting card: real category-wise breakdown of this period's expenses
  // (reportController.getDayEndReport already groups these), not the old
  // mockup's fixed Inventory/Staffing/Marketing 65/25/10. "Kitchen Stock" is
  // excluded here the same way it's excluded from otherExpenses/netProfit
  // (see DayEndExpenseBreakdown's own comment) - showing it as a % of
  // otherExpenses would double up against costOfGoods.
  const budgetBreakdown = useMemo(() => {
    const rows = (report?.expenseBreakdown || []).filter((row) => !row.excludedFromNetProfit && row.total > 0);
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    if (total <= 0) return [];
    const colors = ['bg-emerald-400', 'bg-blue-400', 'bg-amber-400', 'bg-rose-400', 'bg-violet-400'];
    return [...rows]
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
      .map((row, index) => ({
        label: row.category,
        value: Math.round((row.total / total) * 100),
        color: colors[index % colors.length],
      }));
  }, [report]);

  async function handleAddEntry(input: { category: string; amount: number; date: string; note: string }) {
    if (!input.category) {
      popup({ tone: 'error', title: 'Missing information', message: 'Enter or pick a category for this entry.' });
      return;
    }
    if (!input.amount || input.amount <= 0) {
      popup({ tone: 'error', title: 'Missing information', message: 'Enter an amount greater than 0.' });
      return;
    }
    try {
      setIsSavingEntry(true);
      const created = await createExpense({
        category: input.category,
        amount: input.amount,
        date: new Date(`${input.date}T12:00:00.000Z`).toISOString(),
        note: input.note,
      });
      if (created) {
        setExpenses((prev) => [created, ...prev]);
        setShowAddModal(false);
        void loadAll();
      }
    } catch (error) {
      popup({ tone: 'error', title: "Couldn't save entry", message: error instanceof Error ? error.message : 'Failed to save.' });
    } finally {
      setIsSavingEntry(false);
    }
  }

  async function handleDeleteEntry(expense: Expense) {
    const confirmed = await confirm(`Remove "${expense.category}" (${formatMoney(expense.amount)}) from the ledger?`, {
      title: 'Remove entry',
      confirmText: 'Remove',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await deleteExpense(expense.id);
      setExpenses((prev) => prev.filter((e) => e.id !== expense.id));
      void loadAll();
    } catch (error) {
      popup({ tone: 'error', title: "Couldn't remove entry", message: error instanceof Error ? error.message : 'Failed to remove.' });
    }
  }

  async function handleExportPdf() {
    try {
      setIsExportingPdf(true);
      const { ReportPdfDocument, downloadPdfDocument } = await import('@/lib/pdf-export');
      const rangeLabel = preset === 'custom' || rangeFrom !== rangeTo
        ? `${rangeFrom} to ${rangeTo}`
        : rangeFrom;
      const doc = (
        <ReportPdfDocument
          title="Financial Ledger"
          subtitle={rangeLabel}
          stats={[
            { label: 'Total Revenue', value: formatMoney(revenue) },
            { label: 'Op. Expenses', value: formatMoney(otherExpenses) },
            { label: 'Net Profit', value: formatMoney(netProfit) },
            { label: 'Orders', value: String(orderCount) },
          ]}
          tables={[
            {
              title: 'General Ledger',
              columns: [
                { label: 'Date', width: 1 },
                { label: 'Description', width: 2 },
                { label: 'Category', width: 1 },
                { label: 'Amount', width: 1, align: 'right' },
              ],
              rows: ledgerRows.map((row) => [
                new Date(row.date).toLocaleDateString('en-CA'),
                row.note || row.category,
                row.category,
                `- ${formatMoney(row.amount)}`,
              ]),
              footer: ['', '', 'Total', `- ${formatMoney(ledgerRows.reduce((sum, row) => sum + row.amount, 0))}`],
              emptyMessage: 'No entries logged in this period.',
            },
          ]}
        />
      );
      await downloadPdfDocument(doc, `accounting_${rangeFrom}_to_${rangeTo}.pdf`);
    } catch (error) {
      popup({ tone: 'error', title: "Couldn't export PDF", message: error instanceof Error ? error.message : 'Failed to export.' });
    } finally {
      setIsExportingPdf(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-4 lg:p-8 space-y-8 text-slate-900">

      {/* Header: Financial Summary */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Financial Ledger</h1>
          <p className="text-slate-500 font-medium">
            {rangeFrom === rangeTo ? rangeFrom : `${rangeFrom} → ${rangeTo}`} &middot; {orderCount} order{orderCount === 1 ? '' : 's'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex bg-white p-1.5 rounded-2xl shadow-sm border border-slate-100">
            {(['daily', 'monthly', 'yearly', 'custom'] as Preset[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => applyPreset(item)}
                className={`px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wide transition-all ${
                  preset === item ? 'bg-slate-900 text-white' : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
          {preset === 'custom' ? (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={rangeFrom}
                max={rangeTo || todayKey}
                onChange={(e) => setRangeFrom(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold outline-none focus:border-indigo-400"
              />
              <span className="text-xs font-black text-slate-400">to</span>
              <input
                type="date"
                value={rangeTo}
                min={rangeFrom}
                max={todayKey}
                onChange={(e) => setRangeTo(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold outline-none focus:border-indigo-400"
              />
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void handleExportPdf()}
            disabled={isExportingPdf}
            className="flex items-center gap-2 px-6 py-3 bg-white border border-slate-200 rounded-2xl font-bold text-sm hover:bg-slate-50 transition-all shadow-inner disabled:opacity-60"
          >
            <Download size={18} /> {isExportingPdf ? 'Exporting...' : 'Export PDF'}
          </button>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-6 py-3 border-[0.5px] border-white/20 bg-black text-white rounded-2xl font-bold text-sm hover:scale-105 transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_-3px_7px_rgba(0,0,0,0.5)]"
          >
            <Plus size={18} /> Add Entry
          </button>
        </div>
      </div>

      {errorMessage ? (
        <div className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-600">
          <AlertCircle size={16} /> {errorMessage}
        </div>
      ) : null}

      {/* Financial Health Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm relative overflow-hidden group">
            <div className="flex justify-between items-center mb-6">
                <div className={`p-3 rounded-2xl ${netProfit >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}><Wallet size={24}/></div>
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Net Profit</span>
            </div>
            <h2 className="text-4xl font-black">{isLoading ? '...' : formatMoney(netProfit)}</h2>
            <p className={`text-sm font-bold mt-2 flex items-center gap-1 ${netProfit >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                {netProfit >= 0 ? <ArrowUpCircle size={14}/> : <ArrowDownCircle size={14}/>} {orderCount} order{orderCount === 1 ? '' : 's'} this period
            </p>
        </div>

        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm">
            <div className="flex justify-between items-center mb-6">
                <div className="p-3 bg-blue-50 text-blue-600 rounded-2xl"><BarChart3 size={24}/></div>
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total Revenue</span>
            </div>
            <h2 className="text-4xl font-black">{isLoading ? '...' : formatMoney(revenue)}</h2>
            <div className="w-full bg-slate-100 h-1.5 rounded-full mt-4">
                <div className={`h-full rounded-full ${marginPct >= 0 ? 'bg-blue-600' : 'bg-rose-500'}`} style={{ width: `${marginBarWidth}%` }}/>
            </div>
            <p className="text-slate-400 text-[11px] font-bold mt-2">{marginPct}% profit margin</p>
        </div>

        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm">
            <div className="flex justify-between items-center mb-6">
                <div className="p-3 bg-rose-50 text-rose-600 rounded-2xl"><Scale size={24}/></div>
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Op. Expenses</span>
            </div>
            <h2 className="text-4xl font-black">{isLoading ? '...' : formatMoney(otherExpenses)}</h2>
            <p className="text-rose-500 text-sm font-bold mt-2 flex items-center gap-1">
                <ArrowDownCircle size={14}/> {expensePctOfRevenue}% of revenue
            </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

        {/* Transaction Ledger */}
        <div className="lg:col-span-2 bg-white rounded-[40px] shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-8 border-b border-slate-50 flex justify-between items-center bg-white/50 backdrop-blur-md sticky top-0">
            <h3 className="font-black text-xl">General Ledger</h3>
            <div className="flex gap-2">
                <button type="button" onClick={() => void handleExportPdf()} className="p-2 hover:bg-slate-100 rounded-xl transition-colors"><Receipt size={20} className="text-slate-400"/></button>
                <button type="button" onClick={() => void handleExportPdf()} className="p-2 hover:bg-slate-100 rounded-xl transition-colors"><FileText size={20} className="text-slate-400"/></button>
            </div>
          </div>

          {/* Category tabs (feature 6) - cash sales / credit sales / due
              payments / purchases / expenses, all sourced from the one
              unified GET /reports/ledger-transactions endpoint, filtered
              by the SAME Daily/Monthly/Yearly/Custom range already picked
              above. "Expenses" renders the ORIGINAL Expense-only table
              below (with Add Entry's delete action still wired up exactly
              as before) - every other tab is a read-only view of real
              transactions, since only manual Expense entries are ever
              deletable from here. */}
          <div className="flex flex-wrap gap-2 border-b border-slate-50 px-8 py-4">
            {LEDGER_FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setLedgerFilter(tab.key)}
                className={`rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-wide transition-colors ${
                  ledgerFilter === tab.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            {ledgerFilter === 'expense' ? (
            <table className="w-full text-left">
              <thead>
                <tr className="text-slate-400 text-[10px] uppercase tracking-[0.2em] font-black">
                  <th className="px-8 py-6">Date</th>
                  <th className="px-8 py-6">Description</th>
                  <th className="px-8 py-6">Category</th>
                  <th className="px-8 py-6 text-right">Amount</th>
                  <th className="px-8 py-6" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {isLoading ? (
                  <tr><td colSpan={5} className="px-8 py-10 text-center text-sm font-bold text-slate-400">Loading...</td></tr>
                ) : ledgerRows.length === 0 ? (
                  <tr><td colSpan={5} className="px-8 py-10 text-center text-sm font-bold text-slate-400">No entries logged in this period. Click "Add Entry" to log one.</td></tr>
                ) : ledgerRows.map((row) => (
                  <tr key={row.id} className="group hover:bg-slate-50/80 transition-all">
                    <td className="px-8 py-6">
                        <span className="text-sm font-bold text-slate-400">{new Date(row.date).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                    </td>
                    <td className="px-8 py-6">
                        <div className="flex flex-col">
                            <span className="text-sm font-extrabold text-slate-800">{row.note || row.category}</span>
                            {row.employeeId && typeof row.employeeId === 'object' ? (
                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{row.employeeId.name}</span>
                            ) : null}
                        </div>
                    </td>
                    <td className="px-8 py-6">
                        <span className="px-3 py-1.5 bg-slate-100 rounded-lg text-[10px] font-black text-slate-500 uppercase italic">
                            {row.category}
                        </span>
                    </td>
                    <td className="px-8 py-6 text-right font-black text-sm text-rose-500">
                        - {formatMoney(row.amount)}
                    </td>
                    <td className="px-4 py-6 text-right">
                        <button
                          type="button"
                          onClick={() => void handleDeleteEntry(row)}
                          className="rounded-lg p-1.5 text-slate-300 opacity-0 transition-colors hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
                          title="Remove entry"
                        >
                          <Trash2 size={14} />
                        </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="text-slate-400 text-[10px] uppercase tracking-[0.2em] font-black">
                  <th className="px-8 py-6">Date</th>
                  <th className="px-8 py-6">Description</th>
                  <th className="px-8 py-6">Type</th>
                  <th className="px-8 py-6 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {isLoading ? (
                  <tr><td colSpan={4} className="px-8 py-10 text-center text-sm font-bold text-slate-400">Loading...</td></tr>
                ) : filteredLedgerTransactions.length === 0 ? (
                  <tr><td colSpan={4} className="px-8 py-10 text-center text-sm font-bold text-slate-400">No transactions in this period.</td></tr>
                ) : filteredLedgerTransactions.map((row) => (
                  <tr key={`${row.type}-${row.refId}-${row.date}`} className="group hover:bg-slate-50/80 transition-all">
                    <td className="px-8 py-6">
                        <span className="text-sm font-bold text-slate-400">{new Date(row.date).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                    </td>
                    <td className="px-8 py-6">
                        <div className="flex flex-col">
                            <span className="text-sm font-extrabold text-slate-800">{row.label}</span>
                            {row.detail ? <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{row.detail}</span> : null}
                        </div>
                    </td>
                    <td className="px-8 py-6">
                        <span className="px-3 py-1.5 bg-slate-100 rounded-lg text-[10px] font-black text-slate-500 uppercase italic">
                            {row.type === 'sale' ? (row.isCredit ? 'Credit Sale' : 'Cash Sale') : row.type === 'due_payment' ? 'Due Payment' : row.type}
                        </span>
                    </td>
                    <td className={`px-8 py-6 text-right font-black text-sm ${row.direction === 'in' ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {row.direction === 'in' ? '+' : '-'} {formatMoney(row.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </div>
        </div>

        {/* Expense Breakdown / Insight Sidebar */}
        <div className="space-y-6">
            <div className="bg-black rounded-[40px] p-8 text-white shadow-2xl shadow-slate-300">
                <h3 className="text-xl font-black mb-6 flex items-center gap-2">
                    <PieChart className="text-emerald-400" size={24}/> Budgeting
                </h3>
                <div className="space-y-6">
                    {budgetBreakdown.length === 0 ? (
                      <p className="text-sm font-bold text-slate-400">No expenses logged yet this period.</p>
                    ) : budgetBreakdown.map((item) => (
                        <div key={item.label} className="space-y-2">
                            <div className="flex justify-between text-[10px] font-black uppercase text-slate-400 tracking-widest">
                                <span>{item.label}</span>
                                <span>{item.value}%</span>
                            </div>
                            <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
                                <div className={`h-full ${item.color}`} style={{ width: `${item.value}%` }} />
                            </div>
                        </div>
                    ))}
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddModal(true)}
                  className="w-full mt-10 py-4 bg-white/10 hover:bg-white/20 border border-white/10 rounded-[20px] text-xs font-black transition-all flex items-center justify-center gap-2"
                >
                    Log an Expense <ChevronRight size={14}/>
                </button>
            </div>

            <div className="bg-emerald-500 rounded-[40px] p-8 text-white relative overflow-hidden">
                <div className="relative z-10">
                    <h4 className="text-lg font-black mb-2">Outstanding Dues</h4>
                    <p className="text-emerald-100 text-sm font-medium mb-6">Still owed to you by customers, as of today.</p>
                    <div className="text-4xl font-black">{isLoading ? '...' : formatMoney(report?.totalDue ?? 0)}</div>
                    <button
                      type="button"
                      onClick={() => navigate('/dashboard/dues')}
                      className="mt-6 flex items-center gap-2 rounded-[16px] bg-white/15 px-4 py-2.5 text-xs font-black hover:bg-white/25 transition-all"
                    >
                      View Customer Dues <ChevronRight size={14}/>
                    </button>
                </div>
                {/* Visual Flair */}
                <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-white/20 rounded-full blur-3xl" />
            </div>
        </div>

      </div>

      {showAddModal ? (
        <AddEntryModal
          onClose={() => setShowAddModal(false)}
          onSubmit={(input) => void handleAddEntry(input)}
          submitting={isSavingEntry}
          defaultDate={rangeTo || todayKey}
        />
      ) : null}
    </div>
  );
}
