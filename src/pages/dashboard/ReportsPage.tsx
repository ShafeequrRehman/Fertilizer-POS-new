import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3, TrendingUp, TrendingDown, Receipt, Wallet, ShoppingBag,
  Plus, Trash2, AlertCircle, UserRound, Boxes, Truck, ClipboardList, ChevronDown,
} from 'lucide-react';
import { fetchDayEndReport, fetchExpenses, createExpense, deleteExpense, fetchMySalesReport, fetchInventoryReport, fetchEmployeesLite } from '@/lib/pos-api';
import { DayEndReport, Expense, InventoryReport, MySalesReport } from '@/lib/pos-types';
import { useToast } from '@/lib/toast';
import { hasPermission } from '@/lib/auth';

function formatMoney(amount: number) {
  return `Rs ${Math.round(amount).toLocaleString()}`;
}

// en-CA formats as YYYY-MM-DD in the browser's LOCAL time zone (unlike
// toISOString, which is UTC) - matches the date input's own value format
// and the backend's plain YYYY-MM-DD query-param convention (see
// customerController.getCustomerLedger / reportController.resolveRange).
function toDateKey(date: Date) {
  return date.toLocaleDateString('en-CA');
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
  // 'daily' and the initial 'custom' default both start on today.
  return { from: toDateKey(now), to: toDateKey(now) };
}

const EXPENSE_CATEGORIES = [
  'Gas', 'Electricity', 'Water', 'Wages', 'Damage / Waste', 'Rent', 'Maintenance',
  // Employee Expenses - see Expense.employeeId's own comment. These two are
  // just entries in the same free-text category field every other expense
  // uses (no separate model/table) - what actually links one to a specific
  // person is the optional employeeId picked alongside it below.
  'Employee Meal', 'Other Employee Expense',
  'Other',
];

// Must match backend/controllers/reportController.js's SALARY_PAYMENT_CATEGORY
// exactly - that's the expenseBreakdown row this page reads the aggregate
// Salary Payment/Advance total from (see salaryPaymentsTotal below).
const SALARY_EXPENSE_CATEGORY = 'Salary Payment / Advance';

// Reported bug: in the packaged Electron desktop app (nodeIntegration:true,
// contextIsolation:false, and no custom Menu set - see main.js - so
// Electron's DEFAULT application menu, with its Reload/Ctrl+R accelerator,
// stays live even though autoHideMenuBar just hides the visible bar),
// opening a native <select>/<datalist> popup on this page and clicking an
// option was reloading the whole renderer back to the dashboard. Native
// OS-drawn popups are exactly the kind of window-focus-stealing UI most
// prone to tripping that class of Electron quirk. Rather than chase the
// exact internal mechanism, every dropdown on this page is rendered fully
// in-DOM instead (a plain absolutely-positioned panel of <button
// type="button">s, closed via the same click-outside pattern
// DashboardShell's NotificationBellButton already uses) - there is no
// native popup left here at all, so this entire class of bug can't recur
// regardless of which exact Electron/Chromium behavior was causing it.
function InlineDropdown({ value, onChange, options, placeholder, className }: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className={`relative ${className || ''}`} ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border-none ring-1 ring-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold outline-none"
      >
        <span className={selected ? 'text-slate-800' : 'text-slate-400'}>{selected ? selected.label : placeholder}</span>
        <ChevronDown size={14} className="shrink-0 text-slate-400" />
      </button>
      {open ? (
        <div className="absolute z-20 mt-1 max-h-56 w-full min-w-[10rem] overflow-y-auto rounded-xl bg-white py-1 shadow-lg ring-1 ring-slate-200">
          {options.map((option) => (
            <button
              key={option.value || '__all__'}
              type="button"
              onClick={() => { onChange(option.value); setOpen(false); }}
              className={`block w-full whitespace-nowrap px-3 py-2 text-left text-xs font-bold hover:bg-slate-50 ${option.value === value ? 'bg-indigo-50 text-indigo-600' : 'text-slate-700'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Same reasoning as InlineDropdown above, for the one field that also
// needs free-text entry (a category not already in EXPENSE_CATEGORIES) -
// this replaces the old <input list="..."> + <datalist> pair, which is
// itself a native OS popup under the hood.
function CategoryComboBox({ value, onChange, options, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = value.trim()
    ? options.filter((option) => option.toLowerCase().includes(value.trim().toLowerCase()))
    : options;

  return (
    <div className="relative" ref={containerRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
      />
      {open && filtered.length > 0 ? (
        <div className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-2xl bg-white py-1 shadow-lg ring-1 ring-slate-200">
          {filtered.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => { onChange(option); setOpen(false); }}
              className="block w-full px-4 py-2 text-left text-sm font-bold text-slate-700 hover:bg-slate-50"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Role-Based Security: which report a logged-in account actually sees.
// Full 'reports.view' (Owner/Manager/Accountant) keeps the existing
// restaurant-wide Day-End Profit report exactly as it was. The
// Receptionist role has only 'reports.view.own_sales' - their own daily
// sales, nothing else. The Stock Manager role has only
// 'reports.view.inventory' - kitchen stock logs + supplier dues, nothing
// else. Dispatching to a different component per case (rather than one
// component with conditional hooks) keeps each view's own state/effects
// simple and independent - safe here because a session's permission set
// never changes mid-session (it's fixed at login), so which branch renders
// never changes after the first render either.
export default function ReportsPage() {
  if (hasPermission('reports.view')) return <DayEndReportView />;
  if (hasPermission('reports.view.own_sales')) return <MySalesReportView />;
  if (hasPermission('reports.view.inventory')) return <InventoryReportView />;
  return (
    <div className="min-h-screen bg-[#F4F7FA] p-4 lg:p-8 flex items-center justify-center">
      <div className="rounded-[32px] bg-white p-8 text-center text-sm font-bold text-slate-500 shadow-sm">
        You don't have access to any report view yet.
      </div>
    </div>
  );
}

// Task 3 (Purchasing/Financial Logic): the Day-End Net Profit Closing
// matrix - Revenue, Total Product Cost (COGS), Other Expenses, and the
// resulting Net Profit, over a Daily/Monthly/Yearly/Custom date range. This
// replaces what used to be a purely mock "Intelligence Hub" page (hardcoded
// KPI cards, a chart placeholder, fake export buttons) with the real
// backend-aggregated report from reportController.getDayEndReport.
function DayEndReportView() {
  const { popup, confirm } = useToast();
  const [preset, setPreset] = useState<Preset>('daily');
  const initial = computePresetRange('daily');
  const [rangeFrom, setRangeFrom] = useState(initial.from);
  const [rangeTo, setRangeTo] = useState(initial.to);
  const todayKey = toDateKey(new Date());

  const [report, setReport] = useState<DayEndReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseCategory, setExpenseCategory] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseNote, setExpenseNote] = useState('');
  const [expenseEmployeeId, setExpenseEmployeeId] = useState('');
  const [isSavingExpense, setIsSavingExpense] = useState(false);

  // Employee Expenses filters - "which employee" and "which category" to
  // narrow the entries list below to. Both default to "All" (empty string)
  // so this page's existing behavior (every expense, no filtering) is
  // unchanged until someone actually picks one.
  const [employees, setEmployees] = useState<Array<{ _id: string; name: string; username: string }>>([]);
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  useEffect(() => {
    void fetchEmployeesLite().then((list) => setEmployees(list || []));
  }, []);

  function applyPreset(next: Preset) {
    setPreset(next);
    const { from, to } = computePresetRange(next);
    setRangeFrom(from);
    setRangeTo(to);
  }

  async function loadReport() {
    if (!rangeFrom || !rangeTo) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [reportData, expenseData] = await Promise.all([fetchDayEndReport(rangeFrom, rangeTo), fetchExpenses()]);
      if (reportData) setReport(reportData);
      setExpenses(expenseData || []);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load the report.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeFrom, rangeTo]);

  // Expenses have no date-filter query param on the backend (the list is
  // typically small enough per shop that it isn't worth one yet) - filtered
  // client-side against whatever range is currently picked instead.
  const expensesInRange = useMemo(() => {
    let list = expenses;
    if (rangeFrom && rangeTo) {
      const start = new Date(`${rangeFrom}T00:00:00.000Z`).getTime();
      const end = new Date(`${rangeTo}T23:59:59.999Z`).getTime();
      list = list.filter((e) => {
        const t = new Date(e.date).getTime();
        return t >= start && t <= end;
      });
    }
    if (employeeFilter) {
      list = list.filter((e) => {
        const id = typeof e.employeeId === 'object' && e.employeeId ? e.employeeId._id : e.employeeId;
        return id === employeeFilter;
      });
    }
    if (categoryFilter) {
      list = list.filter((e) => e.category === categoryFilter);
    }
    return [...list].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [expenses, rangeFrom, rangeTo, employeeFilter, categoryFilter]);

  // Employee Expenses summary (point 9's "Total employee meals / Total
  // employee expenses"): derived from the SAME filtered list above, so
  // these totals always match whatever's actually visible in "Entries in
  // this period" - not a second, possibly-inconsistent query. Total Salary
  // Advances/Payments comes from the Day-End report's own aggregate
  // instead (see reportController.getDayEndReport's StaffPayment query) -
  // those rows live in a separate collection, never in this Expense list.
  const employeeExpenseTotals = useMemo(() => {
    let meals = 0;
    let otherEmployee = 0;
    for (const expense of expensesInRange) {
      if (!expense.employeeId) continue;
      if (expense.category === 'Employee Meal') meals += expense.amount;
      else otherEmployee += expense.amount;
    }
    return { meals, otherEmployee, total: meals + otherEmployee };
  }, [expensesInRange]);

  const salaryPaymentsTotal = report?.expenseBreakdown.find((row) => row.category === SALARY_EXPENSE_CATEGORY)?.total ?? 0;

  async function handleLogExpense() {
    if (!expenseCategory.trim()) {
      popup({ tone: 'error', title: 'Missing information', message: 'Pick or type a category.' });
      return;
    }
    const amount = Number(expenseAmount);
    if (!amount || amount <= 0) {
      popup({ tone: 'error', title: 'Missing information', message: 'Enter an amount greater than 0.' });
      return;
    }
    try {
      setIsSavingExpense(true);
      const created = await createExpense({
        category: expenseCategory.trim(),
        amount,
        date: rangeTo ? new Date(`${rangeTo}T12:00:00.000Z`).toISOString() : undefined,
        note: expenseNote.trim(),
        employeeId: expenseEmployeeId || null,
      });
      if (created) {
        setExpenses((prev) => [created, ...prev]);
        setExpenseCategory('');
        setExpenseAmount('');
        setExpenseNote('');
        setExpenseEmployeeId('');
        void loadReport();
      }
    } catch (error) {
      popup({ tone: 'error', title: "Couldn't log expense", message: error instanceof Error ? error.message : 'Failed to log expense.' });
    } finally {
      setIsSavingExpense(false);
    }
  }

  async function handleDeleteExpense(expense: Expense) {
    const confirmed = await confirm(`Delete this ${expense.category} expense of ${formatMoney(expense.amount)}?`, {
      title: 'Delete expense',
      confirmText: 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await deleteExpense(expense.id);
      setExpenses((prev) => prev.filter((e) => e.id !== expense.id));
      void loadReport();
    } catch (error) {
      popup({ tone: 'error', title: "Couldn't delete", message: error instanceof Error ? error.message : 'Failed to delete expense.' });
    }
  }

  const netProfit = report?.netProfit ?? 0;
  const isProfitable = netProfit >= 0;

  return (
    <div className="min-h-screen bg-[#F4F7FA] p-4 lg:p-8 space-y-8 text-slate-900">

      {/* Header + Date Range Filter */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black tracking-tight flex items-center gap-3">
            Day-End Profit Report <BarChart3 className="text-indigo-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">Revenue, ingredient cost, and expenses - net profit for the period you pick.</p>
        </div>

        <div className="flex flex-col items-end gap-3">
          <div className="flex bg-white p-1.5 rounded-[20px] shadow-sm border border-slate-100">
            {(['daily', 'monthly', 'yearly', 'custom'] as Preset[]).map((item) => (
              <button
                key={item}
                onClick={() => applyPreset(item)}
                className={`px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wide transition-all ${
                  preset === item ? 'bg-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),inset_0_-2px_5px_rgba(0,0,0,0.4)]' : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={rangeFrom}
              max={rangeTo || todayKey}
              onChange={(e) => { setPreset('custom'); setRangeFrom(e.target.value); }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold outline-none focus:border-indigo-400"
            />
            <span className="text-xs font-black text-slate-400">to</span>
            <input
              type="date"
              value={rangeTo}
              min={rangeFrom}
              max={todayKey}
              onChange={(e) => { setPreset('custom'); setRangeTo(e.target.value); }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold outline-none focus:border-indigo-400"
            />
          </div>
        </div>
      </div>

      {errorMessage ? (
        <div className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          <AlertCircle size={16} /> {errorMessage}
        </div>
      ) : null}

      {/* Net Profit Matrix */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <KPICard icon={<Wallet size={24} />} iconClass="bg-blue-50 text-blue-600" label="Total Revenue" value={formatMoney(report?.revenue ?? 0)} sub={`${report?.orderCount ?? 0} order${(report?.orderCount ?? 0) === 1 ? '' : 's'}`} />
        <KPICard icon={<ShoppingBag size={24} />} iconClass="bg-amber-50 text-amber-600" label="Product Cost (COGS)" value={formatMoney(report?.costOfGoods ?? 0)} sub="Ingredients consumed" />
        <KPICard icon={<Receipt size={24} />} iconClass="bg-rose-50 text-rose-600" label="Other Expenses" value={formatMoney(report?.otherExpenses ?? 0)} sub={`${report?.expenseCount ?? 0} logged`} />
        <div className={`p-8 rounded-[32px] border shadow-sm relative overflow-hidden ${isProfitable ? 'bg-emerald-600 border-emerald-600' : 'bg-rose-600 border-rose-600'}`}>
          <div className="flex justify-between items-center mb-6">
            <div className="p-3 bg-white/15 text-white rounded-2xl">{isProfitable ? <TrendingUp size={24} /> : <TrendingDown size={24} />}</div>
            <span className="text-[10px] font-black uppercase tracking-widest text-white/80">Net Profit</span>
          </div>
          <h2 className="text-3xl font-black text-white">{formatMoney(netProfit)}</h2>
          <p className="text-white/80 text-xs font-bold mt-2">Revenue - COGS - Expenses</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

        {/* Expense Breakdown */}
        <div className="lg:col-span-2 bg-white p-8 rounded-[40px] shadow-sm border border-slate-100">
          <h3 className="font-black text-xl mb-1">Expense Breakdown</h3>
          <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-6">By category, this period</p>

          {isLoading ? (
            <div className="rounded-2xl bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 animate-pulse">Loading...</div>
          ) : !report?.expenseBreakdown || report.expenseBreakdown.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500">No expenses logged in this period.</div>
          ) : (
            <div className="space-y-2">
              {report.expenseBreakdown.map((row) => {
                const share = report.otherExpenses > 0 ? Math.round((row.total / report.otherExpenses) * 100) : 0;
                return (
                  <div key={row.category}>
                    <div className={`flex items-center justify-between gap-4 rounded-2xl px-5 py-4 ${row.excludedFromNetProfit ? 'bg-amber-50 border border-amber-100' : 'bg-slate-50'}`}>
                      <div>
                        <p className="text-sm font-black text-slate-900 flex items-center gap-2 flex-wrap">
                          {row.category}
                          {row.excludedFromNetProfit ? (
                            <span className="inline-flex items-center bg-amber-100 text-amber-700 px-2 py-0.5 rounded-lg text-[9px] uppercase font-black tracking-wider">
                              Not in Net Profit
                            </span>
                          ) : null}
                        </p>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                          {row.count} entr{row.count === 1 ? 'y' : 'ies'}
                          {row.excludedFromNetProfit ? ' · raw stock already costed via COGS when sold' : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        {!row.excludedFromNetProfit ? (
                          <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden hidden sm:block">
                            <div className="h-full bg-indigo-600" style={{ width: `${share}%` }} />
                          </div>
                        ) : null}
                        <span className="text-sm font-black text-slate-900 w-20 text-right">{formatMoney(row.total)}</span>
                      </div>
                    </div>

                    {/* Task 3 (Granular Expense Report Breakdown): the
                        detailed Company/Product/Quantity/financials table
                        that makes up this Kitchen Stock total. */}
                    {row.excludedFromNetProfit && report.kitchenStockDetails.length > 0 ? (
                      <div className="mt-2 mb-1 overflow-x-auto rounded-2xl border border-amber-100">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-amber-50/60 text-[9px] font-black uppercase tracking-widest text-amber-700">
                            <tr>
                              <th className="px-4 py-2.5">Company</th>
                              <th className="px-4 py-2.5">Product</th>
                              <th className="px-4 py-2.5 text-right">Quantity</th>
                              <th className="px-4 py-2.5 text-right">Total</th>
                              <th className="px-4 py-2.5 text-right">Paid</th>
                              <th className="px-4 py-2.5 text-right">Due</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-amber-50">
                            {report.kitchenStockDetails.map((detail) => (
                              <tr key={detail.id}>
                                <td className="px-4 py-2.5 font-bold text-slate-800">{detail.companyName}</td>
                                <td className="px-4 py-2.5 text-slate-600">
                                  {detail.ingredientName}
                                  {detail.productDetails ? <span className="text-slate-400"> · {detail.productDetails}</span> : null}
                                </td>
                                <td className="px-4 py-2.5 text-right font-bold text-slate-700">{detail.quantity}{detail.unit}</td>
                                <td className="px-4 py-2.5 text-right font-black text-slate-900">{formatMoney(detail.totalAmount)}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-emerald-600">{formatMoney(detail.paidAmount)}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-rose-600">{formatMoney(detail.remainingAmount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {/* Employee Expenses summary - see employeeExpenseTotals/
              salaryPaymentsTotal's own comments above. Only shown once
              there's actually something to summarize, so a shop that's
              never used this feature sees the page exactly as before. */}
          {employeeExpenseTotals.total > 0 || salaryPaymentsTotal > 0 ? (
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl bg-slate-50 px-4 py-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Employee Meals</p>
                <p className="text-sm font-black text-slate-900">{formatMoney(employeeExpenseTotals.meals)}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 px-4 py-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Salary Payments/Advances</p>
                <p className="text-sm font-black text-slate-900">{formatMoney(salaryPaymentsTotal)}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 px-4 py-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Total Employee Expenses</p>
                <p className="text-sm font-black text-slate-900">{formatMoney(employeeExpenseTotals.total)}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 px-4 py-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Overall Expenses</p>
                <p className="text-sm font-black text-slate-900">{formatMoney(report?.otherExpenses ?? 0)}</p>
              </div>
            </div>
          ) : null}

          <div className="mt-8 mb-3 flex flex-wrap items-center justify-between gap-3">
            <h4 className="font-black text-sm uppercase tracking-widest text-slate-400">Entries in this period</h4>
            <div className="flex flex-wrap gap-2">
              <InlineDropdown
                className="w-40"
                value={employeeFilter}
                onChange={setEmployeeFilter}
                placeholder="All employees"
                options={[{ value: '', label: 'All employees' }, ...employees.map((emp) => ({ value: emp._id, label: emp.name }))]}
              />
              <InlineDropdown
                className="w-40"
                value={categoryFilter}
                onChange={setCategoryFilter}
                placeholder="All categories"
                options={[{ value: '', label: 'All categories' }, ...EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c }))]}
              />
            </div>
          </div>
          <div className="space-y-2 max-h-[280px] overflow-y-auto">
            {expensesInRange.length === 0 ? (
              <p className="text-sm font-bold text-slate-400">Nothing logged yet.</p>
            ) : (
              expensesInRange.map((expense) => {
                const emp = typeof expense.employeeId === 'object' ? expense.employeeId : null;
                return (
                <div key={expense.id} className="flex items-center justify-between gap-4 rounded-xl border border-slate-100 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-800">
                      {expense.category}
                      {emp ? <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[9px] font-black uppercase text-indigo-600">{emp.name}</span> : null}
                    </p>
                    <p className="text-[10px] font-bold text-slate-400">{new Date(expense.date).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}{expense.note ? ` · ${expense.note}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-black text-slate-900">{formatMoney(expense.amount)}</span>
                    <button onClick={() => void handleDeleteExpense(expense)} className="p-2 text-slate-300 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                );
              })
            )}
          </div>
        </div>

        {/* Log Expense */}
        <div className="space-y-6">
          <div className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm">
            <h3 className="font-black text-lg text-slate-900 mb-1 flex items-center gap-2">
              <Plus className="text-indigo-600" size={20} /> Log an Expense
            </h3>
            <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-6">Gas, electricity, wages, damage/waste, employee meals...</p>

            <div className="space-y-3">
              <CategoryComboBox
                value={expenseCategory}
                onChange={setExpenseCategory}
                options={EXPENSE_CATEGORIES}
                placeholder="Category"
              />
              {/* Employee Expenses - optional. Left on "No specific
                  employee" for every ordinary shop-wide expense; only
                  matters for something like "Employee Meal" that should
                  show up on one person's own Payroll history view too (see
                  Expense.employeeId's own comment - purely informational
                  there, never subtracted from their salary). */}
              <InlineDropdown
                value={expenseEmployeeId}
                onChange={setExpenseEmployeeId}
                placeholder="No specific employee"
                options={[{ value: '', label: 'No specific employee' }, ...employees.map((emp) => ({ value: emp._id, label: emp.name }))]}
              />
              <input
                type="number"
                value={expenseAmount}
                onChange={(e) => setExpenseAmount(e.target.value)}
                placeholder="Amount"
                className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
              />
              <input
                type="text"
                value={expenseNote}
                onChange={(e) => setExpenseNote(e.target.value)}
                placeholder="Note (optional)"
                className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
              />
              <p className="text-[10px] font-bold text-slate-400 ml-1">Logged against {new Date(`${rangeTo}T12:00:00.000Z`).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}.</p>
            </div>

            <button
              type="button"
              onClick={() => void handleLogExpense()}
              disabled={isSavingExpense}
              className="w-full mt-6 py-4 border-[0.5px] border-white/30 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white rounded-[24px] text-sm font-black transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-3px_7px_rgba(49,46,129,0.5)]"
            >
              {isSavingExpense ? 'Saving...' : 'Log Expense'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Receptionist's scoped view: reports.view.own_sales ---
//
// Task 1's "restrict the Reports section so they can only view their own
// daily personal sales report" - a single calendar day (no Daily/Monthly/
// Yearly/Custom picker like the full report has - "daily" here means
// exactly that), only the orders THIS logged-in account created. No cost/
// profit figures anywhere - reportController.getMySalesReport never sends
// them in the first place.
function MySalesReportView() {
  const [date, setDate] = useState(() => toDateKey(new Date()));
  const [report, setReport] = useState<MySalesReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const todayKey = toDateKey(new Date());

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const data = await fetchMySalesReport(date);
        if (data) setReport(data);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load your sales report.');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [date]);

  return (
    <div className="min-h-screen bg-[#F4F7FA] p-4 lg:p-8 space-y-8 text-slate-900">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black tracking-tight flex items-center gap-3">
            My Daily Sales <UserRound className="text-indigo-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">Only the orders you personally placed, one day at a time.</p>
        </div>
        <input
          type="date"
          value={date}
          max={todayKey}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold outline-none focus:border-indigo-400"
        />
      </div>

      {errorMessage ? (
        <div className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          <AlertCircle size={16} /> {errorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <KPICard icon={<Wallet size={24} />} iconClass="bg-blue-50 text-blue-600" label="My Revenue" value={formatMoney(report?.revenue ?? 0)} sub={`${report?.orderCount ?? 0} order${(report?.orderCount ?? 0) === 1 ? '' : 's'}`} />
        <KPICard icon={<Receipt size={24} />} iconClass="bg-emerald-50 text-emerald-600" label="Collected" value={formatMoney(report?.totalCollected ?? 0)} sub="Cash received" />
        <KPICard icon={<ShoppingBag size={24} />} iconClass="bg-amber-50 text-amber-600" label="Still Due" value={formatMoney(report?.totalDue ?? 0)} sub="Across your orders" />
        <KPICard icon={<TrendingDown size={24} />} iconClass="bg-rose-50 text-rose-600" label="Cancelled" value={String(report?.cancelledCount ?? 0)} sub="Not counted above" />
      </div>

      <div className="bg-white p-8 rounded-[40px] shadow-sm border border-slate-100">
        <h3 className="font-black text-xl mb-1">Your Orders</h3>
        <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-6">{new Date(`${date}T12:00:00.000Z`).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</p>

        {isLoading ? (
          <div className="rounded-2xl bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 animate-pulse">Loading...</div>
        ) : !report || report.orders.length === 0 ? (
          <div className="rounded-2xl bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500">No orders on this day.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                  <th className="py-2 pr-4">Order</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4 text-right">Total</th>
                  <th className="py-2 pr-4 text-right">Paid</th>
                  <th className="py-2 pr-4 text-right">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.orders.map((order) => (
                  <tr key={order.id}>
                    <td className="py-2.5 pr-4 font-black text-slate-800">#{order.dailyOrderNumber ?? '—'}</td>
                    <td className="py-2.5 pr-4 font-bold text-slate-500">{order.orderType}</td>
                    <td className="py-2.5 pr-4">
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${order.status === 'cancelled' ? 'bg-gray-200 text-gray-500 line-through' : 'bg-emerald-100 text-emerald-700'}`}>
                        {order.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-right font-bold text-slate-700">{formatMoney(order.total)}</td>
                    <td className="py-2.5 pr-4 text-right font-bold text-emerald-600">{formatMoney(order.paidAmount)}</td>
                    <td className="py-2.5 pr-4 text-right font-black text-rose-600">{order.status === 'cancelled' ? '—' : formatMoney(order.remainingAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Stock Manager's scoped view: reports.view.inventory ---
//
// Task 2's "they should only see data, logs, and supplier dues directly
// related to inventory and kitchen stock management" - kitchen stock
// purchase logs over a Daily/Monthly/Yearly/Custom range (same preset
// picker as the full report), plus every company's all-time due. No
// revenue/COGS/net-profit anywhere - reportController.getInventoryReport
// never sends them in the first place.
function InventoryReportView() {
  const [preset, setPreset] = useState<Preset>('daily');
  const initial = computePresetRange('daily');
  const [rangeFrom, setRangeFrom] = useState(initial.from);
  const [rangeTo, setRangeTo] = useState(initial.to);
  const todayKey = toDateKey(new Date());

  const [report, setReport] = useState<InventoryReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function applyPreset(next: Preset) {
    setPreset(next);
    const { from, to } = computePresetRange(next);
    setRangeFrom(from);
    setRangeTo(to);
  }

  useEffect(() => {
    if (!rangeFrom || !rangeTo) return;
    (async () => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const data = await fetchInventoryReport(rangeFrom, rangeTo);
        if (data) setReport(data);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load the inventory report.');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [rangeFrom, rangeTo]);

  return (
    <div className="min-h-screen bg-[#F4F7FA] p-4 lg:p-8 space-y-8 text-slate-900">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black tracking-tight flex items-center gap-3">
            Stock &amp; Supplier Report <Boxes className="text-indigo-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">Kitchen stock purchase logs and supplier dues for the period you pick.</p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <div className="flex bg-white p-1.5 rounded-[20px] shadow-sm border border-slate-100">
            {(['daily', 'monthly', 'yearly', 'custom'] as Preset[]).map((item) => (
              <button
                key={item}
                onClick={() => applyPreset(item)}
                className={`px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wide transition-all ${
                  preset === item ? 'bg-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),inset_0_-2px_5px_rgba(0,0,0,0.4)]' : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={rangeFrom}
              max={rangeTo || todayKey}
              onChange={(e) => { setPreset('custom'); setRangeFrom(e.target.value); }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold outline-none focus:border-indigo-400"
            />
            <span className="text-xs font-black text-slate-400">to</span>
            <input
              type="date"
              value={rangeTo}
              min={rangeFrom}
              max={todayKey}
              onChange={(e) => { setPreset('custom'); setRangeTo(e.target.value); }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold outline-none focus:border-indigo-400"
            />
          </div>
        </div>
      </div>

      {errorMessage ? (
        <div className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          <AlertCircle size={16} /> {errorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <KPICard icon={<ShoppingBag size={24} />} iconClass="bg-amber-50 text-amber-600" label="Kitchen Stock Purchased" value={formatMoney(report?.kitchenStockPurchases ?? 0)} sub={`${report?.kitchenStockPurchaseCount ?? 0} batches logged`} />
        <KPICard icon={<Truck size={24} />} iconClass="bg-indigo-50 text-indigo-600" label="Total Supplier Due" value={formatMoney(report?.totalSupplierDue ?? 0)} sub="All-time, every company" />
        <KPICard icon={<ClipboardList size={24} />} iconClass="bg-blue-50 text-blue-600" label="Companies Owed" value={String(report?.supplierDues.length ?? 0)} sub="With an outstanding balance" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white p-8 rounded-[40px] shadow-sm border border-slate-100">
          <h3 className="font-black text-xl mb-1">Supplier Dues</h3>
          <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-6">All-time balance owed, every company</p>
          {isLoading ? (
            <div className="rounded-2xl bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 animate-pulse">Loading...</div>
          ) : !report || report.supplierDues.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500">Nothing due to any company.</div>
          ) : (
            <div className="space-y-2">
              {report.supplierDues.map((row) => (
                <div key={row.companyName} className="flex items-center justify-between gap-4 rounded-2xl bg-slate-50 px-5 py-4">
                  <p className="text-sm font-black text-slate-900">{row.companyName}</p>
                  <span className={`text-sm font-black ${row.totalDue > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{formatMoney(row.totalDue)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white p-8 rounded-[40px] shadow-sm border border-slate-100">
          <h3 className="font-black text-xl mb-1">Kitchen Stock Log</h3>
          <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-6">Every batch logged this period</p>
          {isLoading ? (
            <div className="rounded-2xl bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 animate-pulse">Loading...</div>
          ) : !report || report.kitchenStockDetails.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500">No purchases logged in this period.</div>
          ) : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {report.kitchenStockDetails.map((detail) => (
                <div key={detail.id} className="rounded-2xl bg-slate-50 px-5 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm font-black text-slate-900">{detail.companyName}</p>
                    <span className="text-sm font-black text-slate-900">{formatMoney(detail.totalAmount)}</span>
                  </div>
                  <p className="text-xs font-bold text-slate-400 mt-1">
                    {detail.ingredientName}{detail.productDetails ? ` · ${detail.productDetails}` : ''} · {detail.quantity}{detail.unit}
                    {detail.remainingAmount > 0 ? <span className="text-rose-500"> · {formatMoney(detail.remainingAmount)} due</span> : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- UI ATOMS ---

function KPICard({ icon, iconClass, label, value, sub }: { icon: ReactNode; iconClass: string; label: string; value: string; sub: string }) {
  return (
    <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm">
      <div className="flex justify-between items-center mb-6">
        <div className={`p-3 rounded-2xl ${iconClass}`}>{icon}</div>
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-right">{label}</span>
      </div>
      <h2 className="text-3xl font-black text-slate-900">{value}</h2>
      <p className="text-slate-400 text-xs font-bold mt-2">{sub}</p>
    </div>
  );
}
