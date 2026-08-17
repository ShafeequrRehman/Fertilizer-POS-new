
import React, { useState, useEffect } from 'react';
import { fetchCustomerLedger, createCustomer, updateCustomerDues, settleCustomerDues, sendWhatsappMessage, fetchWhatsappStatus } from '@/lib/pos-api';
import { LedgerCustomer } from '@/lib/pos-types';
import { Plus, User, Phone, DollarSign, MessageCircle, AlertCircle, Save, X, RefreshCcw, Search } from 'lucide-react';
import { useToast } from '@/lib/toast';

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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', address: '', previousDues: 0 });
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

  const loadCustomers = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchCustomerLedger();
      if (data) {
        setCustomers(data);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load customers.');
    } finally {
      setLoading(false);
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
      toast.error(error instanceof Error ? error.message : 'Could not add customer.');
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
  const handleAddManualDue = async (phone: string, amount: number): Promise<boolean> => {
    const customer = customers.find(c => c.phone === phone);
    if (!customer || amount <= 0) return false;

    try {
      const updated = await updateCustomerDues(phone, (customer.previousDues || 0) + amount);
      if (!updated) {
        toast.error('Could not update dues.');
        return false;
      }
      await loadCustomers();
      toast.success('Dues updated.');
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update dues.');
      return false;
    }
  };

  // "- Pay Dues" / "Clear" are a real payment actually collected from the
  // customer - unlike Add Dues above, this has to be able to reach
  // whichever unpaid ORDERS make up the rest of totalDue, not just the
  // manual lump-sum, or a cash payment for an order-based due would have
  // nowhere to go (that used to be exactly this bug - see
  // customerController.settleCustomerDues for the same oldest-debt-first
  // distribution completeAndSettle's cascade already uses elsewhere).
  // amount is capped at totalDue before this is ever called (see
  // CustomerCard) - defensively re-checked here too.
  const handleSettlePayment = async (phone: string, amount: number): Promise<boolean> => {
    const customer = customers.find(c => c.phone === phone);
    if (!customer) return false;
    const cappedAmount = Math.min(amount, customer.totalDue || 0);
    if (cappedAmount <= 0) return false;

    try {
      const result = await settleCustomerDues(phone, cappedAmount);
      if (!result) {
        toast.error('Could not record payment.');
        return false;
      }
      await loadCustomers();
      toast.success(`₨${result.appliedAmount} recorded.`);
      return true;
    } catch (error) {
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

  const customersWithDues = searchedCustomers.filter(c => (c.totalDue || 0) > 0).sort(byRecent);
  const customersWithoutDues = searchedCustomers.filter(c => !(c.totalDue || 0)).sort(byRecent);

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
            Customer Dues <DollarSign className="text-indigo-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">Manage customer outstanding balances and send reminders.</p>
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
            className="flex items-center gap-2 px-6 py-3 bg-black text-white rounded-2xl font-black hover:bg-slate-800 transition-all shadow-lg"
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
          <button onClick={handleAddCustomer} className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700">
            <Save size={16} /> Save Customer
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
                  onAddManual={handleAddManualDue}
                  onSettlePayment={handleSettlePayment}
                  onRemind={() => handleSendReminder(c)}
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
                  onAddManual={handleAddManualDue}
                  onSettlePayment={handleSettlePayment}
                  onRemind={() => handleSendReminder(c)}
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

function CustomerCard({ customer, onAddManual, onSettlePayment, onRemind }: { customer: LedgerCustomer, onAddManual: (phone: string, amount: number) => Promise<boolean>, onSettlePayment: (phone: string, amount: number) => Promise<boolean>, onRemind: () => void }) {
  const { confirm } = useToast();
  const [amount, setAmount] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const isPending = (customer.totalDue || 0) > 0;
  const fromOrders = customer.totalOrderBalance || 0;
  const fromLumpSum = customer.previousDues || 0;
  const totalDue = customer.totalDue || 0;
  const amountValue = Number(amount) || 0;

  return (
    <div className={`p-6 rounded-[28px] border ${isPending ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200 bg-white'} shadow-sm flex flex-col gap-4`}>
      <div>
        <h3 className="font-black text-lg text-slate-900">{customer.name}</h3>
        <p className="text-sm font-bold text-slate-500 flex items-center gap-1 mt-1"><Phone size={14} /> {customer.phone}</p>
      </div>

      <div className="flex justify-between items-end border-y border-slate-100 py-3">
        <div>
          <p className="text-xs font-black uppercase text-slate-400 tracking-wider">Current Dues</p>
          <p className={`text-2xl font-black ${isPending ? 'text-amber-600' : 'text-slate-800'}`}>
            ₨{customer.totalDue || 0}
          </p>
          {isPending && fromOrders > 0 ? (
            <p className="text-[11px] font-bold text-amber-600/80 mt-1">
              ₨{fromOrders} from unpaid orders{fromLumpSum > 0 ? ` + ₨${fromLumpSum} manual` : ''}
            </p>
          ) : null}
        </div>
        {isPending && (
          <button 
            onClick={onRemind}
            className="flex items-center gap-2 bg-green-500 hover:bg-green-600 text-white px-3 py-1.5 rounded-xl font-bold text-xs transition-colors shadow-sm"
          >
            <MessageCircle size={14} /> Remind
          </button>
        )}
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
        <div className="flex gap-2">
          <button
            onClick={async () => {
              setSaving(true);
              const ok = await onAddManual(customer.phone, amountValue);
              setSaving(false);
              if (ok) setAmount('');
            }}
            disabled={saving || amountValue <= 0}
            className="flex-1 bg-red-100 hover:bg-red-200 text-red-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
          >
            {saving ? 'Saving...' : '+ Add Dues'}
          </button>
          <button
            onClick={async () => {
              setSaving(true);
              const ok = await onSettlePayment(customer.phone, amountValue);
              setSaving(false);
              if (ok) setAmount('');
            }}
            disabled={saving || amountValue <= 0 || amountValue > totalDue}
            className="flex-1 bg-green-100 hover:bg-green-200 text-green-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
            title={amountValue > totalDue ? `Can't exceed the ₨${totalDue} owed` : 'Record a payment against everything owed'}
          >
            {saving ? 'Saving...' : '- Pay Dues'}
          </button>
          <button
            onClick={async () => {
              const confirmed = await confirm(`Record a full payment of ₨${totalDue} for this customer?`, { title: 'Clear dues', confirmText: 'Clear', tone: 'danger' });
              if (!confirmed) return;
              setSaving(true);
              await onSettlePayment(customer.phone, totalDue);
              setSaving(false);
            }}
            disabled={saving || totalDue <= 0}
            className="px-3 bg-slate-100 hover:bg-slate-200 text-slate-600 py-2 rounded-xl font-bold text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Record a full payment, clearing everything this customer owes"
          >
            {saving ? '...' : 'Clear'}
          </button>
        </div>
      </div>
    </div>
  );
}
