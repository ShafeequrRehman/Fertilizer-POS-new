
import React, { useState, useEffect } from 'react';
import { fetchAllCustomers, createCustomer, updateCustomerDues, sendWhatsappMessage, fetchWhatsappStatus } from '@/lib/pos-api';
import { Customer } from '@/lib/pos-types';
import { Plus, User, Phone, DollarSign, MessageCircle, AlertCircle, Save, X, RefreshCcw } from 'lucide-react';
import { useToast } from '@/lib/toast';

export default function CustomerDuesPage() {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', address: '', previousDues: 0 });
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
      const data = await fetchAllCustomers();
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
    const created = await createCustomer(newCustomer);
    if (created) {
      setCustomers(prev => [...prev, created]);
      setShowAddCustomer(false);
      setNewCustomer({ name: '', phone: '', address: '', previousDues: 0 });
      toast.success(`"${created.name}" added.`);
    }
  };

  const handleUpdateDues = async (phone: string, amount: number, type: 'add' | 'subtract' | 'null') => {
    const customer = customers.find(c => c.phone === phone);
    if (!customer) return;

    let newDues = customer.previousDues || 0;
    if (type === 'add') newDues += amount;
    else if (type === 'subtract') newDues = Math.max(0, newDues - amount);
    else if (type === 'null') newDues = 0;

    const updated = await updateCustomerDues(phone, newDues);
    if (updated) {
      setCustomers(prev => prev.map(c => c.phone === phone ? updated : c));
    }
  };

  const handleSendReminder = async (customer: Customer) => {
    if (!whatsappConnected) {
      toast.error('WhatsApp is not connected. Please connect it in the WhatsApp settings first.');
      return;
    }
    if (!customer.previousDues || customer.previousDues <= 0) {
      toast.info('Customer has no dues.');
      return;
    }

    const message = `Hello ${customer.name},\nThis is a gentle reminder that you have pending dues of ₨${customer.previousDues}. Please clear them at your earliest convenience.\nThank you!`;
    const response = await sendWhatsappMessage(customer.phone, message);
    if (response?.success) {
      toast.success('Reminder sent successfully!');
    } else {
      toast.error('Failed to send reminder.');
    }
  };

  const customersWithDues = customers.filter(c => (c.previousDues || 0) > 0);
  const customersWithoutDues = customers.filter(c => !(c.previousDues || 0));

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
            className="flex items-center gap-2 px-6 py-3 border-[0.5px] border-white/20 bg-black text-white rounded-2xl font-black hover:bg-slate-800 transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_-3px_7px_rgba(0,0,0,0.5)]"
          >
            <Plus size={18} /> Add Customer
          </button>
        </div>
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
              {customersWithDues.map(c => (
                <CustomerCard 
                  key={c.id} 
                  customer={c} 
                  onUpdate={handleUpdateDues} 
                  onRemind={() => handleSendReminder(c)} 
                />
              ))}
              {customersWithDues.length === 0 && (
                <p className="text-slate-400 font-bold col-span-full">No customers have pending dues. Great!</p>
              )}
            </div>
          </div>

          <div>
            <h2 className="text-xl font-black text-slate-800 mb-4 flex items-center gap-2">
              <User size={20} className="text-green-500" /> All Other Customers
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-6">
              {customersWithoutDues.map(c => (
                <CustomerCard 
                  key={c.id} 
                  customer={c} 
                  onUpdate={handleUpdateDues} 
                  onRemind={() => handleSendReminder(c)} 
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerCard({ customer, onUpdate, onRemind }: { customer: Customer, onUpdate: (phone: string, amount: number, type: 'add'|'subtract'|'null') => void, onRemind: () => void }) {
  const { confirm } = useToast();
  const [amount, setAmount] = useState<string>('');

  const isPending = (customer.previousDues || 0) > 0;

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
            ₨{customer.previousDues || 0}
          </p>
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
        <input 
          type="number" 
          placeholder="Enter amount..." 
          value={amount}
          onChange={e => setAmount(e.target.value)}
          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:border-indigo-500"
        />
        <div className="flex gap-2">
          <button 
            onClick={() => { onUpdate(customer.phone, Number(amount), 'add'); setAmount(''); }}
            disabled={!amount || Number(amount) <= 0}
            className="flex-1 bg-red-100 hover:bg-red-200 text-red-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
          >
            + Add Dues
          </button>
          <button 
            onClick={() => { onUpdate(customer.phone, Number(amount), 'subtract'); setAmount(''); }}
            disabled={!amount || Number(amount) <= 0}
            className="flex-1 bg-green-100 hover:bg-green-200 text-green-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-xl font-bold text-xs transition-colors"
          >
            - Pay Dues
          </button>
          <button
            onClick={async () => {
              const confirmed = await confirm('Clear all dues for this customer?', { title: 'Clear dues', confirmText: 'Clear', tone: 'danger' });
              if (confirmed) onUpdate(customer.phone, 0, 'null');
            }}
            className="px-3 bg-slate-100 hover:bg-slate-200 text-slate-600 py-2 rounded-xl font-bold text-xs transition-colors"
            title="Clear all dues"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
