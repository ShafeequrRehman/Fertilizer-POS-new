
import { useEffect, useMemo, useState } from 'react';
import { BookText, ChevronDown, ChevronUp, Phone, Search, AlertCircle, RefreshCcw, Download, X, Users, Truck } from 'lucide-react';
import { fetchCustomerLedger, fetchCompanyLedger } from '@/lib/pos-api';
import { CompanyLedgerEntry, LedgerCustomer } from '@/lib/pos-types';
// NOTE: intentionally NOT a static top-level import. @react-pdf/renderer
// (imported by @/lib/pdf-export) pulls in a transitive dependency
// (js-md5) whose Node/CJS-environment detection misfires under Vite's
// bundling and throws at MODULE-LOAD time ("Cannot read properties of
// undefined (reading 'from')"), which crashed the entire app at startup
// when this was a static import - since LedgerPage is on the app's main
// route tree, it got pulled into Vite's eager dependency pre-bundle. A
// dynamic import() deferred to the moment the user actually clicks
// "Download PDF" keeps that dependency out of the startup graph entirely.

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
  // Task 4 (Ledger Integration): Customers (existing, per-order dues) vs
  // Suppliers (new, company-wise purchase dues from IngredientPurchase -
  // see getCompanyLedger's own comment). Same page, same date range picker
  // and search box, just a different backend list and table shape.
  const [tab, setTab] = useState<'customers' | 'suppliers'>('customers');

  const [customers, setCustomers] = useState<LedgerCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [companies, setCompanies] = useState<CompanyLedgerEntry[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  const [companyVisibleCount, setCompanyVisibleCount] = useState(10);
  // Show 10 customers, "Load More" grows it by 10 - same pattern as
  // Record's tables.
  const [visibleCount, setVisibleCount] = useState(10);
  // Same Date Range picker pattern as RecordPage.tsx (two `type="date"`
  // inputs + a clear button), restyled to match this page's plain white-
  // card look rather than Record's glass design language. Unlike Record,
  // there's no client-side "shift window" business logic here at all - a
  // range just gets sent straight to the backend (see getCustomerLedger's
  // own comment for how startDate/endDate scope orderCount/totalBilled/
  // totalPaid/orders/lastOrderAt, but deliberately never totalDue).
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const isCustomRange = Boolean(rangeFrom && rangeTo);
  // en-CA formats as YYYY-MM-DD in the browser's LOCAL time zone (unlike
  // toISOString, which is UTC) - matches the date input's own value format,
  // so it can be used directly as `max` to block picking a day after today.
  const todayKey = new Date().toLocaleDateString('en-CA');

  const loadLedger = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchCustomerLedger(isCustomRange ? { startDate: rangeFrom, endDate: rangeTo } : undefined);
      if (data) setCustomers(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load ledger.');
    } finally {
      setLoading(false);
    }
  };

  const loadCompanyLedger = async () => {
    setCompaniesLoading(true);
    setCompaniesError(null);
    try {
      const data = await fetchCompanyLedger(isCustomRange ? { startDate: rangeFrom, endDate: rangeTo } : undefined);
      if (data) setCompanies(data);
    } catch (error) {
      setCompaniesError(error instanceof Error ? error.message : 'Failed to load supplier ledger.');
    } finally {
      setCompaniesLoading(false);
    }
  };

  // Re-fetches from the backend every time the picked range changes
  // (including clearing it back to all-time) - this filter is server-side,
  // unlike Record's, so there's no client-side data to just re-slice. Both
  // lists load together (not just the active tab's) so switching tabs never
  // shows stale/empty data while the other list catches up.
  useEffect(() => {
    void loadLedger();
    void loadCompanyLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeFrom, rangeTo]);

  function clearRange() {
    setRangeFrom('');
    setRangeTo('');
  }

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

  // A new search re-filters the whole list, so a stale "load more" position
  // would otherwise leave the table showing an arbitrary/inconsistent slice
  // - always restart at 10 when the search itself changes.
  useEffect(() => {
    setVisibleCount(10);
  }, [search, customers]);

  const visibleCustomers = filtered.slice(0, visibleCount);

  // Same search box filters the Suppliers tab too - by company name instead
  // of customer name/phone.
  const filteredCompanies = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return companies;
    return companies.filter((c) => c.companyName.toLowerCase().includes(query));
  }, [companies, search]);

  const companyTotals = useMemo(() => {
    return companies.reduce(
      (acc, c) => ({
        purchased: acc.purchased + c.totalPurchased,
        paid: acc.paid + c.totalPaid,
        due: acc.due + c.totalDue,
      }),
      { purchased: 0, paid: 0, due: 0 }
    );
  }, [companies]);

  useEffect(() => {
    setCompanyVisibleCount(10);
  }, [search, companies]);

  const visibleCompanies = filteredCompanies.slice(0, companyVisibleCount);

  // "Ledger summary and transaction logs" as one downloadable PDF -
  // Customer Summary mirrors the on-screen table (respecting the current
  // search, same as what's visible), Transaction Log flattens every one of
  // those customers' orders into a single chronological log. Both reflect
  // whatever's currently filtered/searched; the three stat cards above
  // stay unfiltered by search (see `totals`'s own comment) so the PDF's
  // header figures match what's on screen, not just the visible table.
  async function downloadLedgerPdf() {
    const { ReportPdfDocument, downloadPdfDocument } = await import('@/lib/pdf-export');
    const rangeLabel = isCustomRange ? `${rangeFrom} to ${rangeTo}` : 'All-Time';
    const summaryRows = filtered.map((customer) => [
      customer.name || 'Unnamed Customer',
      customer.phone,
      String(customer.orderCount),
      formatMoney(customer.totalBilled),
      formatMoney(customer.totalPaid),
      formatMoney(customer.totalDue),
    ]);
    const filteredTotals = filtered.reduce(
      (acc, customer) => ({
        orders: acc.orders + customer.orderCount,
        billed: acc.billed + customer.totalBilled,
        paid: acc.paid + customer.totalPaid,
        due: acc.due + customer.totalDue,
      }),
      { orders: 0, billed: 0, paid: 0, due: 0 },
    );

    const transactions = filtered
      .flatMap((customer) => customer.orders.map((order) => ({
        ...order,
        customerName: customer.name || 'Unnamed Customer',
        customerPhone: customer.phone,
      })))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const doc = (
      <ReportPdfDocument
        title="Customer Ledger"
        subtitle={`${rangeLabel} · ${filtered.length} customer${filtered.length === 1 ? '' : 's'}${search.trim() ? ` · Search: "${search.trim()}"` : ''}`}
        stats={[
          { label: isCustomRange ? 'Billed (Selected Range)' : 'Total Billed', value: formatMoney(totals.billed) },
          { label: isCustomRange ? 'Collected (Selected Range)' : 'Total Collected', value: formatMoney(totals.paid) },
          { label: 'Outstanding (All-Time)', value: formatMoney(totals.due) },
        ]}
        tables={[
          {
            title: 'Customer Summary',
            columns: [
              { label: 'Customer', width: 3 },
              { label: 'Phone', width: 2 },
              { label: isCustomRange ? 'Orders (Range)' : 'Orders', width: 1.2, align: 'right' },
              { label: isCustomRange ? 'Billed (Range)' : 'Billed', width: 1.5, align: 'right' },
              { label: isCustomRange ? 'Paid (Range)' : 'Paid', width: 1.5, align: 'right' },
              { label: 'Balance Due', width: 1.5, align: 'right' },
            ],
            rows: summaryRows,
            footer: ['Total', '', String(filteredTotals.orders), formatMoney(filteredTotals.billed), formatMoney(filteredTotals.paid), formatMoney(filteredTotals.due)],
            emptyMessage: 'No customers match this selection.',
          },
          {
            title: 'Transaction Log',
            columns: [
              { label: 'Order', width: 1 },
              { label: 'Date', width: 1.3 },
              { label: 'Customer', width: 2 },
              { label: 'Phone', width: 1.5 },
              { label: 'Type', width: 1 },
              { label: 'Status', width: 1 },
              { label: 'Total', width: 1.2, align: 'right' },
              { label: 'Paid', width: 1.2, align: 'right' },
              { label: 'Due', width: 1.2, align: 'right' },
            ],
            rows: transactions.map((order) => [
              `#${order.dailyOrderNumber ?? '—'}`,
              formatDate(order.createdAt),
              order.customerName,
              order.customerPhone,
              order.orderType,
              order.status,
              formatMoney(order.total),
              formatMoney(order.paidAmount),
              order.status === 'cancelled' ? '—' : formatMoney(order.remainingAmount),
            ]),
            emptyMessage: isCustomRange ? 'No orders in this range.' : 'No orders recorded yet.',
          },
        ]}
      />
    );

    await downloadPdfDocument(doc, `ledger_${isCustomRange ? `${rangeFrom}_to_${rangeTo}` : 'all-time'}.pdf`);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black text-gray-900 tracking-tight flex items-center gap-3">
            Ledger <BookText className="text-indigo-600" size={30} />
          </h1>
          <p className="text-gray-500 font-bold">
            {tab === 'customers'
              ? (isCustomRange
                ? `Showing activity from ${rangeFrom} to ${rangeTo} - every customer's order history, what they've paid, and what's still owed.`
                : "Every customer's order history, what they've paid, and what's still owed.")
              : (isCustomRange
                ? `Showing activity from ${rangeFrom} to ${rangeTo} - every supplier's purchase history and outstanding dues.`
                : "Every supplier's purchase history, what you've paid, and what's still owed.")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-72">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
              <Search size={16} />
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tab === 'customers' ? 'Search by name or phone...' : 'Search by company name...'}
              className="w-full rounded-2xl border border-gray-200 bg-white py-3 pl-11 pr-4 text-sm font-bold outline-none shadow-sm focus:ring-2 focus:ring-indigo-500 transition-all"
            />
          </div>
          <button
            type="button"
            onClick={() => { void loadLedger(); void loadCompanyLedger(); }}
            disabled={loading || companiesLoading}
            className="flex shrink-0 items-center gap-2 rounded-2xl bg-white shadow-sm px-4 py-3 text-sm font-black text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCcw size={16} className={loading || companiesLoading ? 'animate-spin' : ''} /> Refresh
          </button>
          {tab === 'customers' ? (
            <button
              type="button"
              onClick={() => void downloadLedgerPdf()}
              disabled={loading || filtered.length === 0}
              className="flex shrink-0 items-center gap-2 rounded-2xl bg-indigo-600 shadow-sm px-4 py-3 text-sm font-black text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download size={16} /> Download PDF
            </button>
          ) : null}
        </div>
      </div>

      {/* Task 4 (Ledger Integration): Customers vs Suppliers toggle - same
          page, same date range + search box above, different backend list
          and table below. */}
      <div className="inline-flex items-center gap-1 rounded-full bg-white p-1 shadow-sm">
        <button
          type="button"
          onClick={() => setTab('customers')}
          className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-black uppercase tracking-wider transition ${tab === 'customers' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-800'}`}
        >
          <Users size={14} /> Customers
        </button>
        <button
          type="button"
          onClick={() => setTab('suppliers')}
          className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-black uppercase tracking-wider transition ${tab === 'suppliers' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-800'}`}
        >
          <Truck size={14} /> Suppliers
        </button>
      </div>

      {errorMessage ? (
        <div className="flex items-center gap-3 bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-2xl font-bold text-sm">
          <AlertCircle size={20} />
          {errorMessage}
        </div>
      ) : null}

      {/* Same Date Range picker pattern as RecordPage.tsx - two date
          inputs plus a clear button - restyled as a plain white card to
          match this page's look. Unlike Record, this filters on the
          BACKEND (see loadLedger/fetchCustomerLedger above), not client-
          side, so there's no separate "apply" step: picking a date just
          re-fetches. */}
      <div className="grid grid-cols-1 gap-3 rounded-[28px] bg-white p-4 shadow-sm sm:grid-cols-[auto_auto_1fr]">
        <div className="sm:col-span-1">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label className="block text-[10px] font-black uppercase tracking-[0.14em] text-gray-400">Date Range</label>
            {isCustomRange ? (
              <button
                type="button"
                onClick={clearRange}
                className="flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.1em] text-gray-400 transition hover:text-gray-700"
              >
                <X size={11} /> Back to all-time
              </button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-1.5 sm:w-72">
            <input
              type="date"
              value={rangeFrom}
              max={todayKey}
              onChange={(event) => setRangeFrom(event.target.value)}
              className="w-full min-w-0 rounded-full border border-gray-200 bg-white px-2.5 py-2 text-xs font-semibold shadow-sm outline-none transition focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="date"
              value={rangeTo}
              max={todayKey}
              onChange={(event) => setRangeTo(event.target.value)}
              className="w-full min-w-0 rounded-full border border-gray-200 bg-white px-2.5 py-2 text-xs font-semibold shadow-sm outline-none transition focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
      </div>

      {tab === 'customers' ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <StatCard label={isCustomRange ? 'Billed (Selected Range)' : 'Total Billed'} value={formatMoney(totals.billed)} />
            <StatCard label={isCustomRange ? 'Collected (Selected Range)' : 'Total Collected'} value={formatMoney(totals.paid)} />
            <StatCard label="Outstanding (All-Time)" value={formatMoney(totals.due)} tone={totals.due > 0 ? 'warn' : undefined} />
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
                {visibleCustomers.map((customer) => (
                  <LedgerRow
                    key={customer.id}
                    customer={customer}
                    expanded={expandedId === customer.id}
                    onToggle={() => setExpandedId(expandedId === customer.id ? null : customer.id)}
                  />
                ))}
              </div>
              {filtered.length > visibleCustomers.length ? (
                <div className="flex justify-center border-t border-gray-100 py-3">
                  <button
                    type="button"
                    onClick={() => setVisibleCount((previous) => previous + 10)}
                    className="rounded-full bg-[#F6F7FB] px-5 py-2 text-xs font-black text-gray-700 transition hover:bg-gray-100"
                  >
                    Load More ({filtered.length - visibleCustomers.length} more)
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <StatCard label={isCustomRange ? 'Purchased (Selected Range)' : 'Total Purchased'} value={formatMoney(companyTotals.purchased)} />
            <StatCard label={isCustomRange ? 'Paid (Selected Range)' : 'Total Paid'} value={formatMoney(companyTotals.paid)} />
            <StatCard label="Outstanding (All-Time)" value={formatMoney(companyTotals.due)} tone={companyTotals.due > 0 ? 'warn' : undefined} />
          </div>

          {companiesError ? (
            <div className="flex items-center gap-3 bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-2xl font-bold text-sm">
              <AlertCircle size={20} />
              {companiesError}
            </div>
          ) : null}

          {companiesLoading ? (
            <div className="rounded-[32px] bg-white p-8 text-center text-sm font-bold text-gray-500 shadow-sm">Loading supplier ledger...</div>
          ) : filteredCompanies.length === 0 ? (
            <div className="rounded-[32px] bg-white p-8 text-center text-sm font-bold text-gray-500 shadow-sm">
              {companies.length === 0 ? 'No ingredient purchases logged yet.' : 'No suppliers match your search.'}
            </div>
          ) : (
            <div className="rounded-[32px] bg-white shadow-sm overflow-hidden">
              <div className="grid grid-cols-[1.8fr_0.8fr_1fr_1fr_1fr] gap-2 px-6 py-4 text-[11px] font-black uppercase tracking-[0.14em] text-gray-400 border-b border-gray-100">
                <span>Company</span>
                <span>Purchases</span>
                <span>Purchased</span>
                <span>Paid</span>
                <span>Balance Due</span>
              </div>
              <div className="divide-y divide-gray-100">
                {visibleCompanies.map((company) => {
                  const hasDue = company.totalDue > 0;
                  return (
                    <div key={company.companyName} className="grid grid-cols-[1.8fr_0.8fr_1fr_1fr_1fr] gap-2 px-6 py-4 items-center">
                      <div>
                        <div className="text-sm font-black text-gray-900">{company.companyName}</div>
                        <div className="text-xs font-bold text-gray-400 mt-0.5">Last purchase: {formatDate(company.lastPurchaseAt)}</div>
                      </div>
                      <span className="text-sm font-bold text-gray-600">{company.purchaseCount}</span>
                      <span className="text-sm font-bold text-gray-600">{formatMoney(company.totalPurchased)}</span>
                      <span className="text-sm font-bold text-emerald-600">{formatMoney(company.totalPaid)}</span>
                      <span className={`text-sm font-black ${hasDue ? 'text-rose-600' : 'text-gray-400'}`}>{formatMoney(company.totalDue)}</span>
                    </div>
                  );
                })}
              </div>
              {filteredCompanies.length > visibleCompanies.length ? (
                <div className="flex justify-center border-t border-gray-100 py-3">
                  <button
                    type="button"
                    onClick={() => setCompanyVisibleCount((previous) => previous + 10)}
                    className="rounded-full bg-[#F6F7FB] px-5 py-2 text-xs font-black text-gray-700 transition hover:bg-gray-100"
                  >
                    Load More ({filteredCompanies.length - visibleCompanies.length} more)
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </>
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
