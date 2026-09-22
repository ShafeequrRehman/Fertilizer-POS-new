import React, { useEffect, useState } from 'react';
import { fetchBanks, createBank, addBankTransaction } from '@/lib/pos-api';
import { Bank } from '@/lib/pos-types';
import { Landmark, Plus, RefreshCcw, Save, X, ArrowDownCircle, ArrowUpCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useToast } from '@/lib/toast';

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

  const amountValue = Number(amount) || 0;

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
      <div>
        <p className="text-lg font-black text-slate-900">{bank.name}</p>
        <p className={`text-2xl font-black ${bank.balance < 0 ? 'text-red-600' : 'text-emerald-600'}`}>₨{bank.balance.toLocaleString()}</p>
        <p className="text-[11px] font-bold text-slate-400">Current balance</p>
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
            <div className="mt-2 space-y-2 max-h-64 overflow-y-auto pr-1">
              {bank.history.map((entry, index) => {
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
