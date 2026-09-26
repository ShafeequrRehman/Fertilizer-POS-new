
import React, { useState, useEffect, useRef } from 'react';
import {
  fetchCustomerLedger,
  createCustomer,
  updateCustomerDues,
  settleCustomerDues,
  sendWhatsappMessage,
  sendWhatsappDocument,
  fetchWhatsappStatus,
  fetchOrder,
  cancelOrder,
  cancelIngredientPurchase,
  deleteDuesHistoryEntry,
  fetchBanks,
  fetchGrains,
} from '@/lib/pos-api';
import { LedgerCustomer, LedgerPurchase, SavedOrder, DuesHistoryEntry, Bank, Grain, DuesPaymentOption } from '@/lib/pos-types';
import { isDesktopApp } from '@/lib/api';
import { isConnectivityFailure, loadCustomersFromLocalHub, queueCreateCustomerOffline, queueAddDueOffline, queueSettleDueOffline } from '@/lib/offline-dues-helpers';
import { pushCurrentCustomersLedgerCache } from '@/lib/offline-sync';
import { Plus, User, Phone, DollarSign, MessageCircle, AlertCircle, Save, X, RefreshCcw, Search, Download, FileText, Trash2, Eye, Printer, Loader2 } from 'lucide-react';
import { useToast } from '@/lib/toast';
import OrderDetailModal from '@/components/OrderDetailModal';
import PurchaseDetailModal from '@/components/PurchaseDetailModal';
import DuesHistoryDetailModal from '@/components/DuesHistoryDetailModal';


// This page used to source its list from fetchAllCustomers(), which only
// ever carries the OLD, manually-set lump-sum Customer.previousDues field -
// a customer who owes money purely because they have an unpaid/partially
// paid ORDER (the normal, everyday case - see SalesPage.tsx's Complete
// Payment) never had previousDues touched at all, so they silently never
// showed up here as "owing" anything even though Sales/Ledger both agreed
// they did. fetchCustomerLedger() (same aggregation Ledger already uses -
// see backend/controllers/customerController.js's getCustomerLedger) is
// the one true "how much does this customer actually owe right now" figure
// - every unpaid order's remainingAmount, plus that legacy lump-sum, added
// together as totalDue. That's what "Pending Dues" is now filtered and
// displayed by.
export default function CustomerDuesPage() {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<LedgerCustomer[]>([]);
  // The shop's own banks (see BankPage.tsx) - loaded once here so every
  // CustomerCard's Cash/Bank payment-method picker can offer the same
  // up-to-date list without each card fetching it separately.
  const [banks, setBanks] = useState<Bank[]>([]);
  // The shop's own grain stock (see GrainStockPage.tsx) - same idea as
  // banks above, so every CustomerCard's Cash/Bank/Grain Stock
  // payment-method picker can offer whichever grains the shop has added
  // (Rice, Gandam, ...) without each card fetching its own list.
  const [grains, setGrains] = useState<Grain[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', address: '', previousDues: 0 });
  const [isAddingCustomer, setIsAddingCustomer] = useState(false);
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Each grid (Pending Dues, All Other Customers) paginates independently -
  // 10 shown, "Load More" grows just that grid's own count by 10.
  const [visiblePendingCount, setVisiblePendingCount] = useState(10);
  const [visibleOtherCount, setVisibleOtherCount] = useState(10);

  useEffect(() => {
    loadCustomers();
    checkWhatsapp();
    void loadBanks();
    void loadGrains();
    // WhatsApp's socket can take a few seconds to finish (re)connecting
    // after the backend starts, so the very first status check right after
    // this page mounts can catch it mid-handshake and report "not
    // connected" even though it comes online moments later. Poll instead
    // of checking once, so the banner clears itself without the user
    // having to manually refresh.
    const interval = setInterval(checkWhatsapp, 8000);
    return () => clearInterval(interval);
  }, []);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadCustomers(), checkWhatsapp()]);
    } finally {
      setRefreshing(false);
    }
  };

  // Paints instantly from the Local Hub's cache first (same "never wait
  // on a live cloud round trip just to show the list" pattern
  // Dashboard/Sales/Kitchen already use for orders - see
  // offline-dues-helpers.ts's loadCustomersFromLocalHub) - a slow or dead
  // connection still shows this shop's customers/dues immediately instead
  // of a blank "Loading customers..." screen. The real cloud fetch below
  // still runs whenever possible, refining this with up-to-date numbers
  // and refreshing the cache for next time (pushCurrentCustomersLedgerCache).
  const loadCustomers = async () => {
    setErrorMessage(null);
    let paintedFromCache = false;
    if (isDesktopApp()) {
      try {
        const cached = await loadCustomersFromLocalHub();
        if (cached.length > 0) {
          setCustomers(cached);
          setLoading(false);
          paintedFromCache = true;
        }
      } catch {
        // Local Hub itself unreachable (rare) - falls through to the
        // cloud-only path below, exactly like before this cache existed.
      }
    }
    if (!paintedFromCache) setLoading(true);
    try {
      const data = await fetchCustomerLedger();
      if (data) {
        setCustomers(data);
        if (isDesktopApp()) void pushCurrentCustomersLedgerCache();
      }
    } catch (error) {
      // Cached data is already on screen and still useful - a failed LIVE
      // refresh (offline, or too slow) shouldn't blank the page or scare
      // the shop owner with an error on top of data that's already there.
      if (!paintedFromCache) {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load customers.');
      }
    } finally {
      setLoading(false);
    }
  };

  const loadBanks = async () => {
    try {
      const data = await fetchBanks();
      if (data) setBanks(data);
    } catch {
      // Non-fatal - a card just falls back to Cash-only if this fails.
    }
  };

  const loadGrains = async () => {
    try {
      const data = await fetchGrains();
      if (data) setGrains(data);
    } catch {
      // Non-fatal - a card just falls back to Cash/Bank-only if this fails.
    }
  };

  const checkWhatsapp = async () => {
    try {
      const status = await fetchWhatsappStatus();
      setWhatsappConnected(Boolean(status?.isConnected));
    } catch {
      setWhatsappConnected(false);
    }
  };

  const handleAddCustomer = async () => {
    if (!newCustomer.name || !newCustomer.phone) {
      toast.error('Name and phone are required.');
      return;
    }
    setIsAddingCustomer(true);
    try {
      const created = await createCustomer(newCustomer);
      if (!created) {
        toast.error('Could not add customer.');
        return;
      }
      setShowAddCustomer(false);
      setNewCustomer({ name: '', phone: '', address: '', previousDues: 0 });
      toast.success(`"${created.name}" added.`);
      // createCustomer only ever returns the raw Customer record, not a
      // full ledger entry (order history/totals) - reload from the ledger
      // so the new customer shows up with correctly computed totals
      // (0 orders, totalDue === whatever previousDues they were given).
      await loadCustomers();
    } catch (error) {
      // Net down or too slow to reach the backend (not a real rejection
      // like a duplicate phone or bad input - see isConnectivityFailure) -
      // queue it instead of erroring out. It reaches the cloud
      // automatically the moment connectivity returns (see
      // offline-dues-helpers.ts), and shows up in the list right away as
      // a provisional row so nothing looks lost in the meantime.
      if (isDesktopApp() && isConnectivityFailure(error)) {
        try {
          const provisional = await queueCreateCustomerOffline(newCustomer);
          setCustomers((previous) => [...previous, provisional].sort((a, b) => a.name.localeCompare(b.name)));
          setShowAddCustomer(false);
          setNewCustomer({ name: '', phone: '', address: '', previousDues: 0 });
          toast.success(`"${provisional.name}" saved offline - will sync automatically once online.`);
          return;
        } catch {
          // Local Hub itself unreachable too - nothing more can be done
          // locally, fall through to the normal error below.
        }
      }
      toast.error(error instanceof Error ? error.message : 'Could not add customer.');
    } finally {
      setIsAddingCustomer(false);
    }
  };

  // "+ Add Dues" only ever adds to the manual previousDues lump-sum (the
  // one thing PATCH /customers/dues/:phone can touch) - it's for charging
  // something not tied to any order (a manual note-of-hand, a damaged-item
  // charge, whatever). It deliberately can't touch order balances - there's
  // no order underneath a manual charge to reduce. Returns whether it
  // actually succeeded - CustomerCard awaits this so it only clears its
  // amount field on a real success, and surfaces a toast either way
  // instead of silently doing nothing on failure (updateCustomerDues
  // throws on any HTTP error).
  const handleAddManualDue = async (phone: string, amount: number, note: string, payment?: DuesPaymentOption): Promise<boolean> => {
    const customer = customers.find(c => c.phone === phone);
    if (!customer || amount <= 0) return false;
    // Labour/Munshi are the payment methods where "+ Paid Amount" runs
    // backwards from every other method: the shop owner treats a
    // Labour/Munshi-routed "Paid Amount" as the customer's due being
    // cleared THROUGH that khata (which holds the money on the shop's
    // behalf, not handed over at the till) - see
    // customerController.applyUpdateCustomerDues's own comment on this.
    // So it lowers previousDues instead of raising it, the mirror image
    // of every other method here.
    const nextPreviousDues = payment?.method === 'munshi' || payment?.method === 'labour'
      ? (customer.previousDues || 0) - amount
      : (customer.previousDues || 0) + amount;

    try {
      const updated = await updateCustomerDues(phone, nextPreviousDues, note, payment);
      if (!updated) {
        toast.error('Could not update dues.');
        return false;
      }
      await loadCustomers();
      if (payment?.bankId) await loadBanks();
      if (payment?.grainId) await loadGrains();
      toast.success('Dues updated.');
      return true;
    } catch (error) {
      // See handleAddCustomer's own comment on isConnectivityFailure - net
      // down/slow queues instead of erroring; a real rejection still shows
      // the error below.
      if (isDesktopApp() && isConnectivityFailure(error)) {
        try {
          const patched = await queueAddDueOffline(customer, {
            previousDues: nextPreviousDues,
            note,
            paymentMethod: payment?.method || 'cash',
            bankId: payment?.bankId,
            grainId: payment?.grainId,
            grainKg: payment?.grainKg,
          });
          setCustomers((previous) => previous.map((c) => (c.phone === phone ? patched : c)));
          toast.success('Saved offline - will sync automatically once online.');
          return true;
        } catch {
          // Local Hub itself unreachable too - fall through below.
        }
      }
      toast.error(error instanceof Error ? error.message : 'Could not update dues.');
      return false;
    }
  };

  // "- Pay Dues" / "Clear" are a real payment actually collected from the
  // customer - a pure manual-ledger move against previousDues only, never
  // touching this customer's Orders (see customerController.settleCustomerDues).
  // Deliberately NOT capped at totalDue any more - a payment can exceed
  // what's currently owed, which leaves the customer in credit (previousDues
  // goes negative, shown as an advance) rather than being silently clipped.
  const handleSettlePayment = async (phone: string, amount: number, note: string, payment?: DuesPaymentOption): Promise<boolean> => {
    const customer = customers.find(c => c.phone === phone);
    if (!customer || amount <= 0) return false;

    try {
      const result = await settleCustomerDues(phone, amount, note, payment);
      if (!result) {
        toast.error('Could not record payment.');
        return false;
      }
      await loadCustomers();
      if (payment?.bankId) await loadBanks();
      if (payment?.grainId) await loadGrains();
      toast.success(`₨${result.appliedAmount} recorded.`);
      return true;
    } catch (error) {
      // See handleAddCustomer's own comment on isConnectivityFailure.
      if (isDesktopApp() && isConnectivityFailure(error)) {
        try {
          const patched = await queueSettleDueOffline(customer, {
            amount,
            note,
            paymentMethod: payment?.method || 'cash',
            bankId: payment?.bankId,
            grainId: payment?.grainId,
            grainKg: payment?.grainKg,
          });
          setCustomers((previous) => previous.map((c) => (c.phone === phone ? patched : c)));
          toast.success(`₨${amount} saved offline - will sync automatically once online.`);
          return true;
        } catch {
          // Local Hub itself unreachable too - fall through below.
        }
      }
      toast.error(error instanceof Error ? error.message : 'Could not record payment.');
      return false;
    }
  };

  const handleSendReminder = async (customer: LedgerCustomer) => {
    if (!whatsappConnected) {
      toast.error('WhatsApp is not connected. Please connect it in the WhatsApp settings first.');
      return;
    }
    if (!customer.totalDue || customer.totalDue <= 0) {
      toast.info('Customer has no dues.');
      return;
    }

    const message = `Hello ${customer.name},\nThis is a gentle reminder that you have pending dues of ₨${customer.totalDue}. Please clear them at your earliest convenience.\nThank you!`;
    const response = await sendWhatsappMessage(customer.phone, message);
    if (response?.success) {
      toast.success('Reminder sent successfully!');
    } else {
      toast.error('Failed to send reminder.');
    }
  };

  const query = searchQuery.trim().toLowerCase();
  const searchedCustomers = query
    ? customers.filter(c =>
        (c.name || '').toLowerCase().includes(query) ||
        (c.phone || '').toLowerCase().includes(query)
      )
    : customers;

  // Newest activity first - a customer who just ran up a due today is more
  // useful to see than one who's owed the same amount for months.
  // lastOrderAt is the freshest signal we have (a manually-added lump-sum
  // dues customer with no orders sinks to the bottom, which is fine - they
  // aren't "recent" by any real measure).
  const byRecent = (a: LedgerCustomer, b: LedgerCustomer) => {
    const at = a.lastOrderAt ? new Date(a.lastOrderAt).getTime() : 0;
    const bt = b.lastOrderAt ? new Date(b.lastOrderAt).getTime() : 0;
    return bt - at;
  };

  // Unified Khata / Customer-Supplier Netting: "pending" now means this
  // contact's NET balance is non-zero either way - either they still owe
  // the shop (netBalance > 0, same as the old totalDue > 0 case) OR the
  // shop now owes THEM (netBalance < 0, only possible once a purchase has
  // been linked to their Khata account) - both are equally worth surfacing
  // here rather than buried in "All Other Customers". Falls back to
  // totalDue for a defensive default (netBalance is always present from a
  // freshly-loaded ledger, but this avoids a hard crash if `fetchCustomerLedger`
  // ever came from stale/cached data missing the new field).
  const netOf = (c: LedgerCustomer) => (typeof c.netBalance === 'number' ? c.netBalance : (c.totalDue || 0));
  const customersWithDues = searchedCustomers.filter(c => netOf(c) !== 0).sort(byRecent);
  const customersWithoutDues = searchedCustomers.filter(c => netOf(c) === 0).sort(byRecent);

  // Restart both grids at 10 whenever the underlying customer list or search
  // changes (add/update/refresh/search), so "Load More" never leaves a
  // stale/inconsistent slice showing.
  useEffect(() => {
    setVisiblePendingCount(10);
    setVisibleOtherCount(10);
  }, [customers, searchQuery]);

  const visiblePending = customersWithDues.slice(0, visiblePendingCount);
  const visibleOther = customersWithoutDues.slice(0, visibleOtherCount);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            Unified Khata <DollarSign className="text-indigo-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">
            Customer dues, plus any purchases linked to a contact - netted into one balance per person.
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
            onClick={() => setShowAddCustomer(true)}
            className="flex items-center gap-2 px-6 py-3 border-[0.5px] border-white/20 bg-black text-white rounded-2xl font-black hover:bg-slate-800 transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_-3px_7px_rgba(0,0,0,0.5)]"
          >
            <Plus size={18} /> Add Customer
          </button>
        </div>
      </div>

      <div className="relative">
        <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search customers by name or phone..."
          className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-11 pr-10 text-sm font-bold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-500"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
            title="Clear search"
          >
            <X size={16} />
          </button>
        ) : null}
      </div>

      {!whatsappConnected && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-2xl font-bold text-sm">
          <AlertCircle size={20} />
          WhatsApp is not connected. Reminders cannot be sent until you link your WhatsApp in the WhatsApp menu.
        </div>
      )}

      {errorMessage ? (
        <div className="flex items-center gap-3 bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-2xl font-bold text-sm">
          <AlertCircle size={20} />
          {errorMessage}
        </div>
      ) : null}

      {showAddCustomer && (
        <div className="bg-white p-6 rounded-[28px] border border-slate-200 shadow-sm space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-black">New Customer</h2>
            <button onClick={() => setShowAddCustomer(false)} className="text-slate-400 hover:text-red-500"><X size={20} /></button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input 
              type="text" 
              placeholder="Full Name" 
              value={newCustomer.name}
              onChange={e => setNewCustomer({...newCustomer, name: e.target.value})}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-indigo-500" 
            />
            <input 
              type="text" 
              placeholder="Phone Number (e.g. 923...)" 
              value={newCustomer.phone}
              onChange={e => setNewCustomer({...newCustomer, phone: e.target.value})}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-indigo-500" 
            />
            <input 
              type="number" 
              placeholder="Initial Dues" 
              value={newCustomer.previousDues || ''}
              onChange={e => setNewCustomer({...newCustomer, previousDues: Number(e.target.value)})}
              className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-bold outline-none focus:ring-2 focus:ring-indigo-500" 
            />
          </div>
          <button onClick={handleAddCustomer} disabled={isAddingCustomer} className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed">
            {isAddingCustomer ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {isAddingCustomer ? 'Saving...' : 'Save Customer'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-center p-10 text-slate-500 font-bold">Loading customers...</div>
      ) : (
        <div className="space-y-8">
          <div>
            <h2 className="text-xl font-black text-slate-800 mb-4 flex items-center gap-2">
              <AlertCircle size={20} className="text-amber-500" /> Pending Dues ({customersWithDues.length})
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-6">
              {visiblePending.map(c => (
                <CustomerCard
                  key={c.id}
                  customer={c}
                  banks={banks}
                  grains={grains}
                  onAddManual={handleAddManualDue}
                  onSettlePayment={handleSettlePayment}
                  onRemind={() => handleSendReminder(c)}
                  onOrderCancelled={loadCustomers}
                  whatsappConnected={whatsappConnected}
                />
              ))}
              {customersWithDues.length === 0 && (
                <p className="text-slate-400 font-bold col-span-full">
                  {query ? 'No matching customers with pending dues.' : 'No customers have pending dues. Great!'}
                </p>
              )}
            </div>
            {customersWithDues.length > visiblePending.length ? (
              <div className="flex justify-center mt-4">
                <button
                  type="button"
                  onClick={() => setVisiblePendingCount((previous) => previous + 10)}
                  className="rounded-full bg-white border border-slate-200 px-5 py-2.5 text-xs font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
                >
                  Load More ({customersWithDues.length - visiblePending.length} more)
                </button>
              </div>
            ) : null}
          </div>

          <div>
            <h2 className="text-xl font-black text-slate-800 mb-4 flex items-center gap-2">
              <User size={20} className="text-green-500" /> All Other Customers
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-6">
              {visibleOther.map(c => (
                <CustomerCard
                  key={c.id}
                  customer={c}
                  banks={banks}
                  grains={grains}
                  onAddManual={handleAddManualDue}
                  onSettlePayment={handleSettlePayment}
                  onRemind={() => handleSendReminder(c)}
                  onOrderCancelled={loadCustomers}
                  whatsappConnected={whatsappConnected}
                />
              ))}
            </div>
            {customersWithoutDues.length > visibleOther.length ? (
              <div className="flex justify-center mt-4">
                <button
                  type="button"
                  onClick={() => setVisibleOtherCount((previous) => previous + 10)}
                  className="rounded-full bg-white border border-slate-200 px-5 py-2.5 text-xs font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
                >
                  Load More ({customersWithoutDues.length - visibleOther.length} more)
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// Per-customer History filter (feature: "customer ki history Day month
// custom date ka hissab say show ho, start mn month say show ho") - same
// Today/Month/Custom idea already used by BankPage's card history and
// IngredientStockSection's per-ingredient khata, but defaults to 'month'
// here instead of 'all'/'today' - a long-standing customer's full
// historyEntries trail (every order/purchase/manual entry ever) can get
// long, so rendering + PDF-building only this month's slice by default
// keeps the card fast; switching to Today or a Custom range narrows (or
// widens) it further, and the Download/Send PDF buttons above follow
// whichever range is currently selected (see buildDuesStatementDoc below).
type HistoryRangeMode = 'today' | 'month' | 'custom';

function isSameCalendarDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isSameCalendarMonth(value: string, reference: Date) {
  const d = new Date(value);
  return d.getFullYear() === reference.getFullYear() && d.getMonth() === reference.getMonth();
}

function todayDateInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CustomerCard({ customer, banks, grains, onAddManual, onSettlePayment, onRemind, onOrderCancelled, whatsappConnected }: { customer: LedgerCustomer, banks: Bank[], grains: Grain[], onAddManual: (phone: string, amount: number, note: string, payment?: DuesPaymentOption) => Promise<boolean>, onSettlePayment: (phone: string, amount: number, note: string, payment?: DuesPaymentOption) => Promise<boolean>, onRemind: () => void, onOrderCancelled: () => void, whatsappConnected: boolean }) {
  const { confirm, toast } = useToast();
  const [amount, setAmount] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [saving, setSaving] = useState(false);
  // Auto-print a receipt right after "+ Paid Amount"/"- Received Amount"/
  // "Clear" succeeds, instead of making the shop owner go find the entry
  // in History and click Print separately. The print window has to be
  // opened SYNCHRONOUSLY inside the button's onClick (before the `await`
  // below) or the browser's popup blocker silently kills it - by the time
  // the async update finishes and this component re-renders with the new
  // entry, we're well outside the "user just clicked something" window
  // popup blockers require. So pendingPrintWindowRef holds that
  // pre-opened window, and the effect below watches customer.duesHistory
  // for the new entry (via a length bump) to fill it in and print once
  // the real entry - with its real, server-computed balanceAfter - has
  // actually arrived through the reloaded customer prop.
  const pendingPrintWindowRef = useRef<Window | null>(null);
  const previousDuesHistoryLengthRef = useRef(customer.duesHistory.length);
  // Cash vs Bank vs Grain Stock - "+ Add Dues" via Bank/Grain Stock means
  // the shop handed the customer that credit out of the picked bank/grain
  // (its balance goes down); "- Pay Dues"/"Clear" via Bank/Grain Stock
  // means the customer's payment landed IN the picked bank/grain (its
  // balance goes up) - see
  // customerController.applyUpdateCustomerDues/applySettleCustomerDues.
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank' | 'grain' | 'labour' | 'munshi'>('cash');
  const [bankId, setBankId] = useState<string>('');
  const [grainId, setGrainId] = useState<string>('');
  const [grainKg, setGrainKg] = useState<string>('');
  const grainKgValue = Number(grainKg) || 0;
  // Labour/Munshi need no extra id/picker - each shop only ever has ONE of
  // each (a single running khata, not a list of named accounts like
  // Bank/Grain Stock - see LabourPage.tsx/MunshiPage.tsx's own comment).
  const paymentOption: DuesPaymentOption =
    paymentMethod === 'bank' ? { method: 'bank', bankId }
    : paymentMethod === 'grain' ? { method: 'grain', grainId, grainKg: grainKgValue }
    : { method: paymentMethod };
  const paymentIncomplete =
    (paymentMethod === 'bank' && !bankId) || (paymentMethod === 'grain' && (!grainId || grainKgValue <= 0));
  // Dues Statement PDF (Download/Send): a full, printable record of
  // everything that makes up this customer's balance - same historyEntries
  // trail already shown in the on-screen History dropdown below, just as a
  // PDF a shop owner can hand over or forward on WhatsApp instead of
  // reading off the screen. isSendingPdf mirrors IngredientStockSection's
  // own isSendingWhatsapp - disables the Send button and swaps its label
  // while the request is in flight, since a WhatsApp send is a real network
  // round trip (unlike the instant client-side PDF download).
  const [isSendingPdf, setIsSendingPdf] = useState(false);
  // Collapsed by default - the History list can get long on a
  // long-standing customer, no point rendering/scrolling past it on every
  // card just to see the current balance.
  const [showHistory, setShowHistory] = useState(false);
  // Defaults to 'month' (not 'all') - see HistoryRangeMode's own comment
  // above for why. customFrom/customTo only matter once 'custom' is picked.
  const [historyRangeMode, setHistoryRangeMode] = useState<HistoryRangeMode>('month');
  const [customFrom, setCustomFrom] = useState(todayDateInputValue());
  const [customTo, setCustomTo] = useState(todayDateInputValue());

  const fromOrders = customer.totalOrderBalance || 0;
  const fromLumpSum = customer.previousDues || 0;
  const totalDue = customer.totalDue || 0;
  const amountValue = Number(amount) || 0;

  // Unified Khata / Customer-Supplier Netting: the single Net Outstanding
  // Balance this card leads with - `totalDue` (sales side, unchanged) minus
  // `totalPurchaseBalance` (purchase side, from any IngredientPurchase
  // linked to this contact) - see customerController.getCustomerLedger's
  // own comment for the full computation and worked examples. Falls back
  // to totalDue for the same defensive reason as DuesPage's netOf() above.
  const netBalance = typeof customer.netBalance === 'number' ? customer.netBalance : totalDue;
  const isPending = netBalance !== 0;
  // + / - Add/Pay Dues and Clear below only ever touch the SALES side
  // (Customer.previousDues + this customer's Orders - see
  // customerController.updateCustomerDues/settleCustomerDues) - they are
  // deliberately NOT wired to netBalance, since a single payment action
  // that also somehow "pays down" a purchase-side due would mean writing
  // money back into IngredientPurchase.paidAmount from here, which is out
  // of scope (the owner asked for the BALANCE to net, not a unified
  // payment action - see this feature's own spec).

  // Unified "everything that makes up what this customer owes" trail -
  // merges the manual duesHistory entries (each with whatever note was
  // typed) with the order-based ones (each tagged with its order number),
  // newest first, so a dropdown here answers "where did this due come
  // from" without having to separately check Sales/Ledger.
  const historyEntries = [
    ...customer.duesHistory.map((entry) => ({
      key: `manual-${entry.createdAt}-${entry.amount}`,
      date: entry.createdAt,
      // Wording matches the renamed buttons above ('+ Paid Amount' /
      // '- Received Amount') - an 'add' entry is money the shop PAID
      // out (increasing what's owed), a 'settle' entry is money the shop
      // RECEIVED back (paying the balance down). Previously "added"/
      // "paid" here, which no longer matched those button names.
      label: entry.type === 'add' ? `+ Rs ${entry.amount} paid` : `- Rs ${entry.amount} received`,
      // Bank-routed entries say so right in the History row - "took/gave
      // via <bank>" - not just on the Bank page's own history (see
      // customerController.js's updateCustomerDues/settleCustomerDues).
      // A handful of OLD "- Pay Dues" entries (from before Pay Dues was
      // fixed to never touch orders) carry an auto-note like
      // "Applied to orders: #8 (Rs 500)" - that wording no longer matches
      // how Pay Dues works today (it's now a pure ledger move, see
      // settleCustomerDues) and only confuses the statement, so it's
      // shown here as a plain payment instead of repeating the stale note.
      detail: /applied to orders/i.test(entry.note || '')
        ? 'Payment received'
        : entry.paymentMethod === 'bank' && entry.bankName
        ? `${entry.note ? `${entry.note} - ` : ''}via ${entry.bankName}`
        : entry.paymentMethod === 'grain' && entry.grainName
        ? `${entry.note ? `${entry.note} - ` : ''}via ${entry.grainName} (${entry.grainKg || 0}kg)`
        : entry.paymentMethod === 'labour'
        ? `${entry.note ? `${entry.note} - ` : ''}via Labour`
        : entry.paymentMethod === 'munshi'
        ? `${entry.note ? `${entry.note} - ` : ''}via Munshi`
        : (entry.note || 'No note'),
      tone: entry.type === 'add' ? 'text-red-600' : 'text-green-600',
      by: entry.createdBy,
      orderId: undefined as string | undefined,
      viewOrderId: undefined as string | undefined,
      purchaseId: undefined as string | undefined,
      viewPurchase: undefined as LedgerPurchase | undefined,
      // Manual "+ Add"/"- Pay" rows are the one entry type that isn't an
      // Order or a Purchase - View/Print/Delete for these read straight
      // off this entry itself, no extra fetch needed.
      duesEntry: entry as DuesHistoryEntry | undefined,
      // Only order/purchase rows carry raw amounts (below) - the Dues
      // Statement PDF's Pay/Add/Balance columns read off these, not the
      // free-text `detail` string, so they stay numerically exact.
      orderAmounts: undefined as { total: number; paid: number; remaining: number } | undefined,
      purchaseAmounts: undefined as { total: number; paid: number; remaining: number } | undefined,
    })),
    // Audit trail: a cancelled order is NOT excluded from this History
    // list anymore - it still counts toward totalOrderBalance/totalDue as
    // zero (see getCustomerLedger's own `billable` filter, unrelated to
    // this display list), but it must stay visible here, explicitly
    // labelled "Cancelled" and naming this customer, so deleting an order
    // never looks like it just vanished without a trace.
    ...customer.orders.map((order) => {
        const isCancelled = order.status === 'cancelled';
        const paidStatus = isCancelled
          ? `Cancelled order for ${customer.name}`
          : order.remainingAmount > 0 ? `Rs ${order.remainingAmount} still due (paid Rs ${order.paidAmount})` : 'Fully paid';
        // Electricity Bill / Cash special-product details - only ever set
        // on an order whose cart had the matching special item in it (see
        // POSPage.tsx's hasElectricityBillItem/hasCashItem). Appended onto
        // the same detail line so a due tied to one of these is
        // immediately traceable from this page, not just Sales/Record.
        const specialDetails = [
          order.billTid ? `TID: ${order.billTid}` : '',
          order.billName ? `Bill Name: ${order.billName}` : '',
          order.cashRecipientName ? `Cash Given To: ${order.cashRecipientName}` : '',
        ].filter(Boolean).join(' · ');
        return {
          key: `order-${order.id}`,
          date: order.createdAt,
          label: `${isCancelled ? 'Cancelled Order' : 'Order'} #${order.dailyOrderNumber ?? order.id.slice(-4)} - Rs ${order.total}`,
          detail: specialDetails ? `${paidStatus} · ${specialDetails}` : paidStatus,
          tone: isCancelled ? 'text-slate-400 line-through' : order.remainingAmount > 0 ? 'text-amber-600' : 'text-slate-400',
          by: '',
          // Only order-based rows carry an id - lets the History row
          // below know which entries can offer a Delete action (an order
          // that isn't already cancelled) vs. which can't (a manual dues
          // add/settle entry, or an already-cancelled order).
          orderId: !isCancelled ? (order.id as string | undefined) : undefined,
          // View/Print stay available even on an already-cancelled order -
          // seeing what was cancelled (and printing that record) is still
          // useful, only Delete is order-status-gated.
          viewOrderId: order.id as string | undefined,
          purchaseId: undefined as string | undefined,
          viewPurchase: undefined as LedgerPurchase | undefined,
          duesEntry: undefined as DuesHistoryEntry | undefined,
          // A cancelled order no longer counts toward anything owed (see
          // getCustomerLedger's own `billable` filter) so it contributes
          // nothing to the Statement's running Pay/Add/Balance either.
          orderAmounts: !isCancelled ? { total: order.total, paid: order.paidAmount, remaining: order.remainingAmount } : undefined,
          purchaseAmounts: undefined as { total: number; paid: number; remaining: number } | undefined,
        };
      }),
    // Unified Khata: this contact's linked purchases (the shop buying FROM
    // them) - tagged distinctly from the sales-side rows above so it's
    // always clear which side of the net balance each row belongs to.
    // Purely informational here - unlike an order row, a purchase has no
    // Delete action from this page (see IngredientPurchase.js's own
    // comment on why a received purchase is never deleted).
    ...(customer.purchases || []).map((purchase) => {
      const isCancelled = purchase.status === 'cancelled';
      const paidStatus = isCancelled
        ? `Cancelled purchase from ${customer.name}${purchase.cancelReason ? ` - ${purchase.cancelReason}` : ''}`
        : purchase.remainingAmount > 0
          ? `Rs ${purchase.remainingAmount} still owed to them (paid Rs ${purchase.paidAmount})`
          : 'Fully paid';
      return {
        key: `purchase-${purchase.id}`,
        date: purchase.purchaseDate,
        // Quantity + unit alongside the ingredient name - without it a
        // Statement row like "Rs 1350000 (Urea)" gives no idea how much
        // Urea that actually was (the shop owner's own point: the amount
        // alone doesn't say how many bags/kg it was).
        label: `${isCancelled ? 'Cancelled Purchase' : 'Purchase'} ${purchase.purchaseOrderNumber} - Rs ${purchase.totalAmount} (${purchase.quantity} ${purchase.unit} ${purchase.ingredientName})`,
        detail: paidStatus,
        tone: isCancelled ? 'text-slate-400 line-through' : purchase.remainingAmount > 0 ? 'text-blue-600' : 'text-slate-400',
        by: isCancelled ? purchase.cancelledBy : '',
        orderId: undefined as string | undefined,
        viewOrderId: undefined as string | undefined,
        // Only a still-"received" (not yet cancelled) purchase carries a
        // purchaseId - lets the History row below know which entries can
        // offer the Cancel-Purchase action (see the orderId/purchaseId
        // convention this same object already uses for orders above).
        purchaseId: !isCancelled ? (purchase.id as string | undefined) : undefined,
        // View/Print stay available even on a cancelled purchase - see the
        // matching viewOrderId comment above for the same reasoning.
        viewPurchase: purchase as LedgerPurchase | undefined,
        duesEntry: undefined as DuesHistoryEntry | undefined,
        orderAmounts: undefined as { total: number; paid: number; remaining: number } | undefined,
        purchaseAmounts: !isCancelled ? { total: purchase.totalAmount, paid: purchase.paidAmount, remaining: purchase.remainingAmount } : undefined,
      };
    }),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Narrows historyEntries down to whatever range is currently picked
  // (Today/This Month/Custom) - drives both the on-screen list below AND
  // the Download/Send PDF buttons above (see buildDuesStatementDoc), so a
  // shop owner who picks "This Month" gets a statement for exactly that,
  // not the customer's entire history.
  const now = new Date();
  const filteredHistoryEntries = historyEntries.filter((entry) => {
    const entryDate = new Date(entry.date);
    if (historyRangeMode === 'today') return isSameCalendarDay(entryDate, now);
    if (historyRangeMode === 'month') return isSameCalendarMonth(entry.date, now);
    const from = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
    const to = customTo ? new Date(`${customTo}T23:59:59.999`) : null;
    if (from && entryDate < from) return false;
    if (to && entryDate > to) return false;
    return true;
  });

  const historyRangeLabel = historyRangeMode === 'today' ? 'Today' : historyRangeMode === 'month' ? 'This Month' : `${customFrom || '...'} to ${customTo || '...'}`;

  function historyRangeFilenameSuffix() {
    if (historyRangeMode === 'today') return todayDateInputValue();
    if (historyRangeMode === 'month') {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    return `${customFrom || 'start'}_to_${customTo || 'end'}`;
  }

  // View/Print/Delete for every History row (feature 4) - orders,
  // purchases and manual dues entries all get the same three actions, in
  // the same instant-action-plus-toast style RecordPage.tsx's own Delete
  // now uses (the shop owner asked for the Cancel Order Key AND the
  // reason-prompt popup both dropped in favour of a single click + a
  // toast - see this file's own history for that request). `busyKeys`
  // guards every action button against a double-click the same way
  // RecordPage's `deletingOrderIds` does.
  const [viewOrder, setViewOrder] = useState<SavedOrder | null>(null);
  const [viewPurchase, setViewPurchase] = useState<LedgerPurchase | null>(null);
  const [viewDuesEntry, setViewDuesEntry] = useState<DuesHistoryEntry | null>(null);
  const [printReadyUrl, setPrintReadyUrl] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());

  function setBusy(key: string, busy: boolean) {
    setBusyKeys((previous) => {
      const next = new Set(previous);
      if (busy) next.add(key); else next.delete(key);
      return next;
    });
  }

  async function handleViewOrder(orderId: string) {
    setBusy(`view-order-${orderId}`, true);
    try {
      const fullOrder = await fetchOrder(orderId);
      setViewOrder(fullOrder);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load this order.');
    } finally {
      setBusy(`view-order-${orderId}`, false);
    }
  }

  // Same hidden-iframe auto-print page RecordPage.tsx's own
  // printCustomerReceipt uses for its Print button - this page has no
  // counter-printer/Electron context of its own, so it always goes
  // through that page rather than trying to duplicate the direct-IPC path.
  function handlePrintOrder(orderId: string) {
    setPrintReadyUrl(`/dashboard/sales/print/${orderId}?auto=true&type=cashier`);
  }

  // Direct-cancel-no-popup, same as RecordPage.tsx's own handleDeleteOrder
  // - fetches the order fresh (the ledger's own row is lean, no items),
  // cancels it (restores stock, adjusts dues server-side), then reloads
  // the whole ledger so this card's balance/History reflect it at once.
  async function handleDeleteOrderClick(orderId: string) {
    const key = `order-${orderId}`;
    if (busyKeys.has(key)) return;
    setBusy(key, true);
    try {
      await cancelOrder(orderId, {});
      toast.success('Order cancelled.');
      onOrderCancelled();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not cancel this order.');
    } finally {
      setBusy(key, false);
    }
  }

  function handleViewPurchase(purchaseId: string) {
    const purchase = (customer.purchases || []).find((p) => p.id === purchaseId);
    if (!purchase) {
      toast.error('Could not find this purchase.');
      return;
    }
    setViewPurchase(purchase);
  }

  // No print route/receipt exists for a purchase anywhere in the app yet,
  // so this builds a small printable slip on the fly (same info as
  // PurchaseDetailModal) and hands it straight to the browser's own print
  // dialog - no new backend page needed for what's just a one-off record.
  function handlePrintPurchase(purchase: LedgerPurchase) {
    const printWindow = window.open('', '_blank', 'width=420,height=600');
    if (!printWindow) {
      toast.error('Could not open the print window - check your browser\'s popup blocker.');
      return;
    }
    const purchaseDate = new Date(purchase.purchaseDate).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    // See writeDuesEntryToWindow's own comment on the @page/80mm-width/
    // auto-height recipe - same endless-blank-feed fix, same reason.
    printWindow.document.write(`<!DOCTYPE html><html><head><title>${purchase.purchaseOrderNumber}</title>
      <style>
        @page { margin: 0; }
        html, body { width: 80mm; margin: 0; padding: 0; height: auto; min-height: 0; font-family: sans-serif; color: #111; }
        .receipt-inner { width: 70mm; margin: 0 auto; padding: 10px 8px; box-sizing: border-box; }
        h1{font-size:16px;margin:0 0 6px}
        p{margin:2px 0;font-size:12px}table{width:100%;margin-top:10px;border-collapse:collapse}
        td{padding:3px 0;font-size:12px}td:last-child{text-align:right;font-weight:bold}
        .total{border-top:1px solid #ccc;margin-top:6px;padding-top:6px;font-size:13px}
      </style>
      </head><body>
      <div class="receipt-inner">
      <h1>${purchase.purchaseOrderNumber}</h1>
      <p>${purchaseDate}</p>
      <p>${purchase.status === 'cancelled' ? 'CANCELLED PURCHASE' : ''}</p>
      <table>
        <tr><td>Ingredient</td><td>${purchase.ingredientName}</td></tr>
        <tr><td>Quantity</td><td>${purchase.quantity} ${purchase.unit}</td></tr>
        <tr><td>Paid</td><td>Rs ${purchase.paidAmount ?? 0}</td></tr>
        <tr><td>Remaining</td><td>Rs ${purchase.remainingAmount ?? 0}</td></tr>
        <tr class="total"><td>Total</td><td>Rs ${purchase.totalAmount}</td></tr>
      </table>
      </div>
      </body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  // Same instant direct-cancel as handleDeleteOrderClick above, just
  // against IngredientPurchase (reverses this batch's stock effect if it
  // had been received, flips status to cancelled - see
  // ingredientPurchaseController.cancelPurchase).
  async function handleDeletePurchaseClick(purchaseId: string) {
    const key = `purchase-${purchaseId}`;
    if (busyKeys.has(key)) return;
    setBusy(key, true);
    try {
      await cancelIngredientPurchase(purchaseId, {});
      toast.success('Purchase cancelled.');
      onOrderCancelled();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not cancel this purchase.');
    } finally {
      setBusy(key, false);
    }
  }

  // Fills an already-open window with this entry's slip and prints it -
  // split out from handlePrintDuesEntry below so the auto-print effect can
  // reuse a window it opened earlier (synchronously, at click time - see
  // pendingPrintWindowRef's own comment) instead of opening a fresh one.
  //
  // Thermal-Printer Endless-Feed Fix: this used to have no @page rule and
  // no fixed width at all, so it inherited whatever paper size the
  // printer driver last had (often a very tall "continuous" default) -
  // fine on a normal office printer (just a mostly-blank A4 page), but on
  // a thermal receipt printer that meant it kept feeding blank roll paper
  // until it hit that huge default page length instead of stopping right
  // after the content. Matching the same @page{margin:0}/80mm-wide/
  // auto-height recipe PrintOrderPage.tsx's own receipt print already
  // uses (which the shop owner confirmed prints correctly) fixes that -
  // the page is exactly as tall as the content, so the printer stops
  // there instead of continuing to feed.
  function writeDuesEntryToWindow(printWindow: Window, entry: DuesHistoryEntry) {
    const date = new Date(entry.createdAt).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    printWindow.document.open();
    printWindow.document.write(`<!DOCTYPE html><html><head><title>Dues Entry</title>
      <style>
        @page { margin: 0; }
        html, body { width: 80mm; margin: 0; padding: 0; height: auto; min-height: 0; font-family: sans-serif; color: #111; }
        .receipt-inner { width: 70mm; margin: 0 auto; padding: 10px 8px; box-sizing: border-box; }
        h1{font-size:16px;margin:0 0 6px}
        p{margin:2px 0;font-size:12px}
      </style>
      </head><body>
      <div class="receipt-inner">
      <h1>${customer.name}</h1>
      <p>${date}</p>
      <p>${entry.type === 'add' ? 'Dues Added' : 'Dues Paid'}: Rs ${entry.amount}</p>
      <p>Balance After: Rs ${entry.balanceAfter}</p>
      <p>Note: ${entry.note || 'No note'}</p>
      <p>By: ${entry.createdBy || '—'}</p>
      </div>
      </body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  function handlePrintDuesEntry(entry: DuesHistoryEntry) {
    const printWindow = window.open('', '_blank', 'width=380,height=500');
    if (!printWindow) {
      toast.error('Could not open the print window - check your browser\'s popup blocker.');
      return;
    }
    writeDuesEntryToWindow(printWindow, entry);
  }

  // See pendingPrintWindowRef's own comment - fires once the customer
  // prop actually reflects the new dues entry (duesHistory grew by one),
  // and prints it into whichever window a Paid/Received Amount/Clear
  // click pre-opened just before its own async call.
  useEffect(() => {
    const newLength = customer.duesHistory.length;
    if (pendingPrintWindowRef.current && newLength > previousDuesHistoryLengthRef.current) {
      const newest = customer.duesHistory[newLength - 1];
      if (!pendingPrintWindowRef.current.closed) {
        writeDuesEntryToWindow(pendingPrintWindowRef.current, newest);
      }
      pendingPrintWindowRef.current = null;
    }
    previousDuesHistoryLengthRef.current = newLength;
  }, [customer.duesHistory]);

  // Opens a (momentarily blank) print window RIGHT NOW, synchronously,
  // still inside the click that's about to kick off an async Paid/
  // Received Amount/Clear action - see pendingPrintWindowRef's own
  // comment for why the timing matters. Shows a quick "Preparing..."
  // placeholder so it doesn't just look broken for the second it takes
  // the real entry to arrive. Callers must clear pendingPrintWindowRef
  // (closing this window) if the action ends up failing, since no new
  // entry will ever arrive to fill it in.
  function openPendingPrintWindow() {
    const printWindow = window.open('', '_blank', 'width=380,height=500');
    if (!printWindow) {
      toast.error('Could not open the print window - check your browser\'s popup blocker.');
      return;
    }
    printWindow.document.write('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">Preparing receipt...</body></html>');
    pendingPrintWindowRef.current = printWindow;
  }

  // Delete-a-manual-dues-entry: the one History row type that never had
  // ANY delete path before - see backend's own
  // customerController.deleteDuesHistoryEntry comment for exactly how it
  // reverses this entry's effect (undoing the previousDues move, and any
  // order payment it made) before removing it.
  async function handleDeleteDuesEntry(entry: DuesHistoryEntry) {
    const key = `dues-${entry.createdAt}-${entry.amount}`;
    if (busyKeys.has(key)) return;
    setBusy(key, true);
    try {
      await deleteDuesHistoryEntry(customer.phone, { createdAt: entry.createdAt, amount: entry.amount, type: entry.type });
      toast.success('Dues entry deleted.');
      onOrderCancelled();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete this dues entry.');
    } finally {
      setBusy(key, false);
    }
  }

  // Shared by both the Download and Send buttons below - one
  // <ReportPdfDocument> (same building block Ledger/Record's own PDF
  // exports use) listing this one customer's current balance and full
  // historyEntries trail. Built fresh on every click (never cached) so it
  // always reflects whatever's on screen right now, and dynamically
  // imported the same way LedgerPage.tsx's own downloadLedgerPdf does -
  // react-pdf is a sizeable chunk of code no card needs to pull in until
  // one of these buttons is actually pressed.
  // Running Pay/Add/Balance columns for the Statement below - replayed
  // oldest-first (historyEntries itself is newest-first, for the on-screen
  // list) so each row's Balance is the running total right after it, in
  // the same minus-if-they-owe-you/plus-if-you-owe-them convention as this
  // card's own headline balance above. Approximated from each row's
  // CURRENT total/paid/remaining (there's no separate ledger of every
  // partial payment's own date), which still reconciles exactly to
  // totalDue/totalPurchaseBalance by the most recent row.
  function computeRunningBalances() {
    const chronological = [...historyEntries].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const balanceByKey = new Map<string, number>();
    let running = 0;
    for (const entry of chronological) {
      if (entry.duesEntry) {
        // OLD "- Pay Dues" entries (before the fix that stopped Pay Dues
        // from ever touching orders) both wrote "Applied to orders: #N
        // (Rs X)" on this entry AND reduced that order's own
        // remainingAmount by the same amount. That order's row (below)
        // already subtracts its (now-lower) remainingAmount, so counting
        // this entry too would subtract the same payment a second time -
        // skip it here; its effect is already reflected in the order row.
        const isLegacyOrderLinkedSettle = entry.duesEntry.type === 'settle' && /applied to orders/i.test(entry.duesEntry.note || '');
        if (!isLegacyOrderLinkedSettle) {
          // "add" = customer's due to the shop went up (bad for them, so
          // this display balance moves down); "settle" is the reverse.
          running += entry.duesEntry.type === 'add' ? -entry.duesEntry.amount : entry.duesEntry.amount;
        }
      } else if (entry.orderAmounts) {
        running -= entry.orderAmounts.remaining;
      } else if (entry.purchaseAmounts) {
        running += entry.purchaseAmounts.remaining;
      }
      balanceByKey.set(entry.key, running);
    }
    return balanceByKey;
  }

  function formatBalanceCell(balance: number) {
    if (balance > 0) return `+Rs ${balance}`;
    if (balance < 0) return `-Rs ${Math.abs(balance)}`;
    return 'Rs 0';
  }

  async function buildDuesStatementDoc() {
    const { ReportPdfDocument } = await import('@/lib/pdf-export');
    const balanceByKey = computeRunningBalances();
    return (
      <ReportPdfDocument
        title="Customer Dues Statement"
        subtitle={`${customer.name} · ${customer.phone} · ${historyRangeLabel}`}
        stats={[
          { label: 'Current Dues', value: `Rs ${totalDue}` },
          { label: 'From Unpaid Orders', value: `Rs ${fromOrders}` },
          { label: 'Manual Adjustments', value: `Rs ${fromLumpSum}` },
        ]}
        tables={[
          {
            title: 'Dues History',
            columns: [
              { label: 'Date', width: 1 },
              { label: 'Entry', width: 1.7 },
              { label: 'Detail', width: 2 },
              { label: 'By', width: 0.8 },
              { label: 'Pay', width: 0.9 },
              { label: 'Add', width: 0.9 },
              { label: 'Balance', width: 1.1 },
            ],
            rows: filteredHistoryEntries.map((entry) => {
              // Pay = money that reduced what the customer owes (a "- Pay
              // Dues" entry, or what's already been paid on an order).
              // Add = money that increased it (a "+ Add Dues" entry, or a
              // new sale's own total). A purchase FROM this contact isn't
              // one of "their" pay/add moves - its own Detail column
              // already spells out what was paid/still owed on it, and
              // its effect still lands in the running Balance column.
              let payCell = '—';
              let addCell = '—';
              if (entry.duesEntry) {
                if (entry.duesEntry.type === 'add') addCell = `Rs ${entry.duesEntry.amount}`;
                else payCell = `Rs ${entry.duesEntry.amount}`;
              } else if (entry.orderAmounts) {
                addCell = `Rs ${entry.orderAmounts.total}`;
                if (entry.orderAmounts.paid > 0) payCell = `Rs ${entry.orderAmounts.paid}`;
              }
              const balance = balanceByKey.get(entry.key) ?? 0;
              return [
                new Date(entry.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                entry.label,
                entry.detail,
                entry.by || '—',
                payCell,
                addCell,
                formatBalanceCell(balance),
              ];
            }),
            emptyMessage: `No dues activity recorded for this customer in ${historyRangeLabel}.`,
          },
        ]}
      />
    );
  }

  async function handleDownloadDuesPdf() {
    const { downloadPdfDocument } = await import('@/lib/pdf-export');
    const doc = await buildDuesStatementDoc();
    await downloadPdfDocument(doc, `${customer.name.replace(/\s+/g, '_')}_dues_statement_${historyRangeFilenameSuffix()}.pdf`);
  }

  async function handleSendDuesPdf() {
    if (!whatsappConnected) {
      toast.error('WhatsApp is not connected. Please connect it in the WhatsApp settings first.');
      return;
    }
    try {
      setIsSendingPdf(true);
      const { pdfDocumentToBase64 } = await import('@/lib/pdf-export');
      const doc = await buildDuesStatementDoc();
      const base64 = await pdfDocumentToBase64(doc);
      const response = await sendWhatsappDocument(customer.phone, base64, `${customer.name.replace(/\s+/g, '_')}_dues_statement_${historyRangeFilenameSuffix()}.pdf`);
      if (response?.success) {
        toast.success(`Dues statement sent to ${customer.name} on WhatsApp.`);
      } else {
        toast.error('Failed to send dues statement.');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send dues statement.');
    } finally {
      setIsSendingPdf(false);
    }
  }

  return (
    <div className={`p-6 rounded-[28px] border ${isPending ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200 bg-white'} shadow-sm flex flex-col gap-4`}>
      <div>
        <h3 className="font-black text-lg text-slate-900">{customer.name}</h3>
        <p className="text-sm font-bold text-slate-500 flex items-center gap-1 mt-1"><Phone size={14} /> {customer.phone}</p>
      </div>

      <div className="flex justify-between items-end border-y border-slate-100 py-3">
        <div>
          <p className="text-xs font-black uppercase text-slate-400 tracking-wider">Net Outstanding Balance</p>
          {/* Khata convention the shop owner asked for: money still to be
              COLLECTED from this contact is shown as "Due ₨..." in red
              (unka humpar udhaar), money the shop itself owes them is
              shown as "Adv ₨..." in green (an advance) - the opposite of
              netBalance's own raw sign (see LedgerCustomer.netBalance's
              own comment: positive netBalance = they owe the shop), so
              this deliberately negates it purely for display. Previously
              a bare "-"/"+" prefix - "Due"/"Adv" per the owner's own
              request, since a lone sign alone wasn't clear enough. */}
          <p className={`text-2xl font-black ${netBalance > 0 ? 'text-red-600' : netBalance < 0 ? 'text-green-600' : 'text-slate-800'}`}>
            {netBalance > 0 ? `Due ₨${netBalance}` : netBalance < 0 ? `Adv ₨${Math.abs(netBalance)}` : 'Settled'}
          </p>
          {fromOrders > 0 || fromLumpSum > 0 ? (
            <p className="text-[11px] font-bold text-slate-400 mt-1">
              ₨{totalDue} from sales{customer.totalPurchaseBalance ? ` - ₨${customer.totalPurchaseBalance} from purchases` : ''}
            </p>
          ) : customer.totalPurchaseBalance ? (
            <p className="text-[11px] font-bold text-slate-400 mt-1">
              ₨{customer.totalPurchaseBalance} owed to them from purchases
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {totalDue > 0 && (
            // Gated on totalDue (sales-side), not the new netBalance-based
            // isPending below - handleSendReminder's message is hardcoded to
            // "pending dues of totalDue", which would misleadingly read "₨0"
            // for a contact whose only outstanding balance is purchase-side
            // (the shop owes THEM, not the other way round). Reminding a
            // supplier-side due is out of scope for this feature anyway -
            // see this page's own comment on why Add/Pay Dues stay
            // sales-only.
            <button
              onClick={onRemind}
              className="flex items-center gap-2 bg-green-500 hover:bg-green-600 text-white px-3 py-1.5 rounded-xl font-bold text-xs transition-colors shadow-sm"
            >
              <MessageCircle size={14} /> Remind
            </button>
          )}
          {/* PDF/Send PDF stay available regardless of whether this
              contact currently owes the shop or is in credit (an
              advance) - a shop owner still wants their full statement
              either way, so these are never gated on totalDue > 0 the
              way Remind above is. */}
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => void handleDownloadDuesPdf()}
              title="Download this customer's dues statement for the selected range as a PDF"
              className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-1.5 rounded-xl font-bold text-[11px] transition-colors shadow-sm"
            >
              <Download size={13} /> PDF
            </button>
            <button
              type="button"
              onClick={() => void handleSendDuesPdf()}
              disabled={isSendingPdf}
              title="Send this customer's dues statement for the selected range as a PDF on WhatsApp"
              className="flex items-center gap-1.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-xl font-bold text-[11px] transition-colors shadow-sm"
            >
              <FileText size={13} /> {isSendingPdf ? 'Sending...' : 'Send PDF'}
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-2 pt-2">
        {isPending ? (
          <p className="text-[11px] font-bold text-slate-400 leading-snug">
            "+ Add Dues" charges something new. "- Pay Dues" / "Clear" record an actual payment - it settles the manual balance first, then any unpaid orders, and marks an order paid off if it covers one fully.
          </p>
        ) : null}
        <input
          type="number"
          placeholder="Enter amount..."
          value={amount}
          onChange={e => setAmount(e.target.value)}
          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:border-indigo-500"
        />
        <input
          type="text"
          placeholder="Note (e.g. damaged item, cash payment...)"
          value={note}
          onChange={e => setNote(e.target.value)}
          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold outline-none focus:border-indigo-500"
        />

        {/* Cash vs Bank vs Grain Stock vs Labour vs Munshi - only shows the
            relevant picker once "Bank"/"Grain Stock" is chosen, and only if
            the shop has added at least one bank/grain. Defaults back to
            Cash whenever none is available, so this never blocks Add/Pay
            Dues for a shop that hasn't set one up yet. Labour/Munshi need
            no such picker - each shop only has ONE of each (see
            LabourPage.tsx/MunshiPage.tsx) - and unlike Bank/Grain Stock,
            picking them still moves Cash in Hand too (see
            customerController.js's own comment on why).  */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => { setPaymentMethod('cash'); setBankId(''); setGrainId(''); setGrainKg(''); }}
            className={`flex-1 min-w-[64px] py-2 rounded-xl font-bold text-xs transition-colors ${paymentMethod === 'cash' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
          >
            Cash
          </button>
          <button
            type="button"
            onClick={() => { setPaymentMethod('bank'); setGrainId(''); setGrainKg(''); }}
            disabled={banks.length === 0}
            title={banks.length === 0 ? 'Add a bank on the Bank page first' : 'This payment goes through a bank'}
            className={`flex-1 min-w-[64px] py-2 rounded-xl font-bold text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${paymentMethod === 'bank' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
          >
            Bank
          </button>
          <button
            type="button"
            onClick={() => { setPaymentMethod('grain'); setBankId(''); }}
            disabled={grains.length === 0}
            title={grains.length === 0 ? 'Add a grain on the Grain Stock page first' : 'This payment goes through grain stock (kg + amount)'}
            className={`flex-1 min-w-[64px] py-2 rounded-xl font-bold text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${paymentMethod === 'grain' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
          >
            Grain Stock
          </button>
          <button
            type="button"
            onClick={() => { setPaymentMethod('labour'); setBankId(''); setGrainId(''); setGrainKg(''); }}
            title="This payment also moves the Labour Khata, on top of Cash in Hand"
            className={`flex-1 min-w-[64px] py-2 rounded-xl font-bold text-xs transition-colors ${paymentMethod === 'labour' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
          >
            Labour
          </button>
          <button
            type="button"
            onClick={() => { setPaymentMethod('munshi'); setBankId(''); setGrainId(''); setGrainKg(''); }}
            title="This payment also moves the Munshi Khata, on top of Cash in Hand"
            className={`flex-1 min-w-[64px] py-2 rounded-xl font-bold text-xs transition-colors ${paymentMethod === 'munshi' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
          >
            Munshi
          </button>
        </div>
        {paymentMethod === 'bank' ? (
          <select
            value={bankId}
            onChange={e => setBankId(e.target.value)}
            className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:border-indigo-500"
          >
            <option value="">Select bank...</option>
            {banks.map(b => (
              <option key={b.id} value={b.id}>{b.name} (₨{b.balance.toLocaleString()})</option>
            ))}
          </select>
        ) : null}
        {paymentMethod === 'grain' ? (
          <div className="space-y-2">
            <select
              value={grainId}
              onChange={e => setGrainId(e.target.value)}
              className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:border-amber-500"
            >
              <option value="">Select grain...</option>
              {grains.map(g => (
                <option key={g.id} value={g.id}>{g.name} ({g.totalKg.toLocaleString()} kg)</option>
              ))}
            </select>
            <input
              type="number"
              placeholder="Kg of grain..."
              value={grainKg}
              onChange={e => setGrainKg(e.target.value)}
              className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:border-amber-500"
            />
          </div>
        ) : null}

        <div className="flex gap-2">
          <button
            onClick={async () => {
              openPendingPrintWindow();
              setSaving(true);
              const ok = await onAddManual(customer.phone, amountValue, note.trim(), paymentOption);
              setSaving(false);
              if (ok) {
                setAmount(''); setNote(''); setGrainKg('');
              } else {
                pendingPrintWindowRef.current?.close();
                pendingPrintWindowRef.current = null;
              }
            }}
            disabled={saving || amountValue <= 0 || paymentIncomplete}
            className="flex-1 flex items-center justify-center gap-1.5 bg-red-100 hover:bg-red-200 text-red-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {saving ? 'Saving...' : '+ Paid Amount'}
          </button>
          <button
            onClick={async () => {
              openPendingPrintWindow();
              setSaving(true);
              const ok = await onSettlePayment(customer.phone, amountValue, note.trim(), paymentOption);
              setSaving(false);
              if (ok) {
                setAmount(''); setNote(''); setGrainKg('');
              } else {
                pendingPrintWindowRef.current?.close();
                pendingPrintWindowRef.current = null;
              }
            }}
            disabled={saving || amountValue <= 0 || paymentIncomplete}
            className="flex-1 flex items-center justify-center gap-1.5 bg-green-100 hover:bg-green-200 text-green-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
            title={amountValue > totalDue ? `More than the ₨${totalDue} owed - the extra becomes an advance` : 'Record a payment against everything owed'}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {saving ? 'Saving...' : '- Received Amount'}
          </button>
          <button
            onClick={async () => {
              const confirmed = await confirm(`Record a full payment of ₨${totalDue} for this customer?`, { title: 'Clear dues', confirmText: 'Clear', tone: 'danger' });
              if (!confirmed) return;
              openPendingPrintWindow();
              setSaving(true);
              const ok = await onSettlePayment(customer.phone, totalDue, note.trim(), paymentOption);
              setSaving(false);
              if (ok) {
                setAmount(''); setNote(''); setGrainKg('');
              } else {
                pendingPrintWindowRef.current?.close();
                pendingPrintWindowRef.current = null;
              }
            }}
            disabled={saving || totalDue <= 0 || paymentIncomplete}
            className="px-3 flex items-center justify-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 py-2 rounded-xl font-bold text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Record a full payment, clearing everything this customer owes"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : 'Clear'}
          </button>
        </div>

        {historyEntries.length > 0 ? (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowHistory((previous) => !previous)}
              className="w-full flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-100 transition-colors"
            >
              <span>History ({filteredHistoryEntries.length})</span>
              <span className="text-slate-400">{showHistory ? '▲' : '▼'}</span>
            </button>
            {/* Today/This Month/Custom - always visible (not gated on
                showHistory) since the Download/Send PDF buttons above
                follow whatever's picked here even without expanding the
                list itself. Defaults to 'month' - see HistoryRangeMode. */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {(['today', 'month', 'custom'] as HistoryRangeMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setHistoryRangeMode(mode)}
                  className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-wider transition-colors ${historyRangeMode === mode ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                >
                  {mode === 'today' ? 'Today' : mode === 'month' ? 'This Month' : 'Custom'}
                </button>
              ))}
              {historyRangeMode === 'custom' ? (
                <>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold outline-none focus:border-slate-400"
                  />
                  <span className="text-[10px] font-black text-slate-400">to</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold outline-none focus:border-slate-400"
                  />
                </>
              ) : null}
            </div>
            {showHistory ? (
              <div className="mt-2 max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-100 p-2">
                {filteredHistoryEntries.length === 0 ? (
                  <p className="px-1 py-3 text-center text-[11px] font-bold text-slate-400">No dues activity in {historyRangeLabel}.</p>
                ) : null}
                {filteredHistoryEntries.map((entry) => (
                  <div key={entry.key} className="rounded-lg bg-slate-50 px-2.5 py-2 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`font-black ${entry.tone}`}>{entry.label}</span>
                      <span className="shrink-0 text-slate-400">{new Date(entry.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
                    </div>
                    <p className="mt-0.5 text-slate-500 font-semibold">{entry.detail}</p>
                    {entry.by ? <p className="mt-0.5 text-slate-400">by {entry.by}</p> : null}
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {entry.viewOrderId ? (
                        <button
                          type="button"
                          onClick={() => void handleViewOrder(entry.viewOrderId as string)}
                          disabled={busyKeys.has(`view-order-${entry.viewOrderId}`)}
                          className="flex items-center gap-1 text-[10px] font-black text-slate-500 hover:text-slate-700 disabled:opacity-50"
                          title="View this order"
                        >
                          <Eye size={11} /> {busyKeys.has(`view-order-${entry.viewOrderId}`) ? 'Loading...' : 'View'}
                        </button>
                      ) : null}
                      {entry.viewOrderId ? (
                        <button
                          type="button"
                          onClick={() => handlePrintOrder(entry.viewOrderId as string)}
                          className="flex items-center gap-1 text-[10px] font-black text-slate-500 hover:text-slate-700"
                          title="Print this order's receipt"
                        >
                          <Printer size={11} /> Print
                        </button>
                      ) : null}
                      {entry.orderId ? (
                        <button
                          type="button"
                          onClick={() => void handleDeleteOrderClick(entry.orderId as string)}
                          disabled={busyKeys.has(`order-${entry.orderId}`)}
                          className="flex items-center gap-1 text-[10px] font-black text-rose-500 hover:text-rose-700 disabled:opacity-50"
                          title="Cancel this order and restore its stock"
                        >
                          <Trash2 size={11} />
                          {busyKeys.has(`order-${entry.orderId}`) ? 'Loading...' : 'Delete'}
                        </button>
                      ) : null}
                      {entry.viewPurchase ? (
                        <button
                          type="button"
                          onClick={() => handleViewPurchase((entry.viewPurchase as LedgerPurchase).id)}
                          className="flex items-center gap-1 text-[10px] font-black text-slate-500 hover:text-slate-700"
                          title="View this purchase"
                        >
                          <Eye size={11} /> View
                        </button>
                      ) : null}
                      {entry.viewPurchase ? (
                        <button
                          type="button"
                          onClick={() => handlePrintPurchase(entry.viewPurchase as LedgerPurchase)}
                          className="flex items-center gap-1 text-[10px] font-black text-slate-500 hover:text-slate-700"
                          title="Print this purchase"
                        >
                          <Printer size={11} /> Print
                        </button>
                      ) : null}
                      {entry.purchaseId ? (
                        <button
                          type="button"
                          onClick={() => void handleDeletePurchaseClick(entry.purchaseId as string)}
                          disabled={busyKeys.has(`purchase-${entry.purchaseId}`)}
                          className="flex items-center gap-1 text-[10px] font-black text-rose-500 hover:text-rose-700 disabled:opacity-50"
                          title="Cancel this purchase and reverse its stock"
                        >
                          <Trash2 size={11} />
                          {busyKeys.has(`purchase-${entry.purchaseId}`) ? 'Loading...' : 'Delete'}
                        </button>
                      ) : null}
                      {entry.duesEntry ? (
                        <button
                          type="button"
                          onClick={() => setViewDuesEntry(entry.duesEntry as DuesHistoryEntry)}
                          className="flex items-center gap-1 text-[10px] font-black text-slate-500 hover:text-slate-700"
                          title="View this dues entry"
                        >
                          <Eye size={11} /> View
                        </button>
                      ) : null}
                      {entry.duesEntry ? (
                        <button
                          type="button"
                          onClick={() => handlePrintDuesEntry(entry.duesEntry as DuesHistoryEntry)}
                          className="flex items-center gap-1 text-[10px] font-black text-slate-500 hover:text-slate-700"
                          title="Print this dues entry"
                        >
                          <Printer size={11} /> Print
                        </button>
                      ) : null}
                      {entry.duesEntry ? (
                        <button
                          type="button"
                          onClick={() => void handleDeleteDuesEntry(entry.duesEntry as DuesHistoryEntry)}
                          disabled={busyKeys.has(`dues-${entry.duesEntry.createdAt}-${entry.duesEntry.amount}`)}
                          className="flex items-center gap-1 text-[10px] font-black text-rose-500 hover:text-rose-700 disabled:opacity-50"
                          title="Delete this dues entry"
                        >
                          <Trash2 size={11} />
                          {busyKeys.has(`dues-${entry.duesEntry.createdAt}-${entry.duesEntry.amount}`) ? 'Loading...' : 'Delete'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {viewOrder ? <OrderDetailModal order={viewOrder} onClose={() => setViewOrder(null)} /> : null}
      {viewPurchase ? <PurchaseDetailModal purchase={viewPurchase} onClose={() => setViewPurchase(null)} /> : null}
      {viewDuesEntry ? <DuesHistoryDetailModal customerName={customer.name} entry={viewDuesEntry} onClose={() => setViewDuesEntry(null)} /> : null}
      {printReadyUrl ? <iframe src={printReadyUrl} className="hidden" title="Auto Print Frame" onLoad={() => window.setTimeout(() => setPrintReadyUrl(null), 4000)} /> : null}
    </div>
  );
}
