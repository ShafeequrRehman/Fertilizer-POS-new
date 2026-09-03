import React, { useEffect, useState } from 'react';
import {
  Users2, UserCircle2, Star, History, UserPlus,
  Search, UserCheck, Clock, Zap,
  ShieldCheck, MoreVertical, ChevronRight, UserRoundCheck, UserRoundX
} from 'lucide-react';
import { fetchWaiters } from '@/lib/pos-api';
import { Waiter } from '@/lib/pos-types';

// --- MOCK DATA ---
const CUSTOMERS = [
  { id: "C-101", name: "Emma Thompson", email: "emma.t@gmail.com", visits: 24, spent: 1250.00, points: 450, tier: "Gold" },
  { id: "C-102", name: "Marcus Holloway", email: "m.holloway@outlook.com", visits: 12, spent: 420.50, points: 120, tier: "Silver" },
  { id: "C-103", name: "Sophia Loren", email: "sophia.l@icloud.com", visits: 8, spent: 180.00, points: 50, tier: "Bronze" },
];

const EMPLOYEES = [
  { id: "E-01", name: "Jordan Smith", role: "Store Manager", status: "On-Duty", shift: "Morning", performance: 98 },
  { id: "E-02", name: "Lila Vance", role: "Cashier", status: "Break", shift: "Morning", performance: 92 },
  { id: "E-03", name: "Terry Fox", role: "Inventory Lead", status: "Off-Duty", shift: "Evening", performance: 85 },
];

export default function PeopleManagementPage() {
  const [activeTab, setActiveTab] = useState<'customers' | 'hr'>('customers');

  return (
    <div className="min-h-screen p-4 lg:p-8 space-y-8">

      {/* Header with Integrated Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            {activeTab === 'customers' ? "Customer Relations" : "Team Management"}
            {activeTab === 'customers' ?
              <UserCircle2 className="text-teal-500" size={32} /> :
              <Users2 className="text-amber-500" size={32} />
            }
          </h1>
          <p className="text-slate-500 font-bold">
            {activeTab === 'customers' ? "Track loyalty and lifetime value." : "Monitor staff performance and attendance."}
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="glass-pill flex p-1.5 rounded-[20px]">
          <button
            onClick={() => setActiveTab('customers')}
            className={`px-6 py-2.5 rounded-2xl text-sm font-black transition-all ${activeTab === 'customers' ? "border-[0.5px] border-white/40 bg-gradient-to-b from-teal-400 to-teal-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(19,78,74,0.45)]" : "text-slate-400 hover:text-slate-600"}`}
          >
            Customers
          </button>
          <button
            onClick={() => setActiveTab('hr')}
            className={`px-6 py-2.5 rounded-2xl text-sm font-black transition-all ${activeTab === 'hr' ? "border-[0.5px] border-white/40 bg-gradient-to-b from-amber-400 to-amber-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(120,53,15,0.4)]" : "text-slate-400 hover:text-slate-600"}`}
          >
            Staff & HR
          </button>
        </div>
      </div>

      {/* Dynamic Content Section */}
      {activeTab === 'customers' ? (
        <CustomerView />
      ) : (
        <HRView />
      )}
    </div>
  );
}

// --- SUB-COMPONENTS ---

function CustomerView() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard label="Total Members" value="1,240" color="text-teal-600" />
        <StatCard label="Avg. Loyalty Points" value="850" color="text-purple-600" />
        <StatCard label="Retention Rate" value="92%" color="text-blue-600" />
      </div>

      <div className="glass rounded-[40px] overflow-hidden">
        <div className="p-8 flex flex-col md:flex-row gap-4 justify-between items-center border-b border-white/40">
          <SearchBar placeholder="Search customers..." focusColor="focus:ring-teal-500" />
          <button className="flex items-center gap-2 px-6 py-3 border-[0.5px] border-white/40 bg-gradient-to-b from-teal-400 to-teal-600 text-white rounded-2xl font-black text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(19,78,74,0.45)] hover:brightness-105 hover:scale-105 transition-all">
            <UserPlus size={18} /> New Customer
          </button>
        </div>
        <table className="w-full text-left">
          <thead className="bg-white/30 text-[10px] font-black text-slate-400 uppercase tracking-widest">
            <tr>
              <th className="px-8 py-4">Customer</th>
              <th className="px-8 py-4">Tier</th>
              <th className="px-8 py-4">Spent</th>
              <th className="px-8 py-4">Points</th>
              <th className="px-8 py-4"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/40">
            {CUSTOMERS.map((c) => (
              <tr key={c.id} className="group hover:bg-teal-50/30 transition-colors">
                <td className="px-8 py-6 flex items-center gap-3">
                  <div className="w-10 h-10 bg-teal-100/80 text-teal-600 rounded-full flex items-center justify-center font-black shadow-inner">{c.name[0]}</div>
                  <div>
                    <div className="text-sm font-black text-slate-900">{c.name}</div>
                    <div className="text-[10px] font-bold text-slate-400">{c.email}</div>
                  </div>
                </td>
                <td className="px-8 py-6">
                  <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase shadow-inner ${c.tier === 'Gold' ? 'bg-amber-100/80 text-amber-600' : 'bg-slate-100/80 text-slate-600'}`}>
                    {c.tier}
                  </span>
                </td>
                <td className="px-8 py-6 text-sm font-black text-slate-900">PKR {c.spent.toFixed(2)}</td>
                <td className="px-8 py-6 text-teal-600 font-black text-sm flex items-center gap-1">
                  <Star size={14} fill="currentColor"/> {c.points}
                </td>
                <td className="px-8 py-6 text-right">
                  <button className="glass-pill rounded-full p-2 text-slate-300 hover:text-teal-600"><History size={18}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HRView() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <StatusCard icon={<UserCheck size={20}/>} label="Clocked In" value="12/15" color="border-emerald-500" iconColor="text-emerald-500" />
        <StatusCard icon={<Clock size={20}/>} label="On Break" value="2" color="border-amber-500" iconColor="text-amber-500" />
        <StatusCard icon={<Zap size={20}/>} label="Efficiency" value="94%" color="border-purple-500" iconColor="text-purple-500" />
        <div className="glass-dark p-6 rounded-[32px] flex flex-col justify-center">
          <p className="text-[10px] font-black uppercase text-slate-400 mb-1">Payroll Date</p>
          <div className="text-xl font-black">March 31st</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 glass rounded-[40px] overflow-hidden">
          <div className="p-8 border-b border-white/40 font-black text-xl flex justify-between items-center">
            Staff Directory
            <button className="glass-pill text-xs px-4 py-2 rounded-xl">View Schedule</button>
          </div>
          <div className="p-4 space-y-2">
            {EMPLOYEES.map((emp) => (
              <div key={emp.id} className="flex items-center justify-between p-4 hover:bg-white/50 rounded-3xl transition-all group cursor-pointer">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-white/50 rounded-2xl overflow-hidden shadow-inner">
                    <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${emp.name}`} alt="avatar" />
                  </div>
                  <div>
                    <h4 className="font-black text-slate-900">{emp.name}</h4>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{emp.role}</p>
                  </div>
                </div>
                <div className="flex items-center gap-6">
                  <span className={`text-[10px] font-black px-3 py-1 rounded-lg shadow-inner ${emp.status === 'On-Duty' ? 'bg-emerald-100/80 text-emerald-600' : 'bg-slate-100/80 text-slate-400'}`}>
                    {emp.status}
                  </span>
                  <div className="text-right hidden sm:block">
                    <div className="text-xs font-black">{emp.performance}%</div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase">KPI</div>
                  </div>
                  <button className="glass-pill rounded-full p-2 text-slate-300 hover:text-slate-900"><MoreVertical size={20}/></button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass rounded-[40px] p-8 flex flex-col">
          <h3 className="font-black text-lg mb-6 flex items-center gap-2">
            <ShieldCheck className="text-indigo-500" size={20}/> Permissions
          </h3>
          <div className="space-y-4 flex-1">
            {['Admin', 'Manager', 'Cashier'].map((role) => (
              <div key={role} className="flex items-center justify-between p-4 bg-white/40 rounded-2xl shadow-inner hover:bg-indigo-50/60 transition-all cursor-pointer group">
                <span className="text-sm font-bold text-slate-600 group-hover:text-indigo-600">{role}</span>
                <ChevronRight size={16} className="text-slate-300 group-hover:text-indigo-400" />
              </div>
            ))}
          </div>
          <button className="glass-dark w-full mt-6 py-4 rounded-[20px] font-black text-xs hover:brightness-110 transition-all">
            Process Payroll
          </button>
        </div>
      </div>

      <WaiterRosterReadOnly />
    </div>
  );
}

// Read-only view of who currently qualifies as a waiter/order taker in the
// POS dropdown (see backend/controllers/waiterController.js). Waiters are
// now added and edited exclusively from Manage Staff - designation
// "Waiter" or "Order Taker" - not here.
function WaiterRosterReadOnly() {
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchWaiters()
      .then(setWaiters)
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <div className="rounded-[40px] border border-slate-100 bg-white p-8 shadow-sm">
      <div className="flex items-center gap-2">
        <Users2 size={18} className="text-indigo-600" />
        <h3 className="text-lg font-black text-slate-900">Waiter & Floor Team</h3>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-slate-500">
        Waiters and order takers are added from <span className="font-bold text-slate-700">Manage Staff</span>.
        Add a staff member there with designation <span className="font-bold text-slate-700">"Waiter"</span> or{' '}
        <span className="font-bold text-slate-700">"Order Taker"</span> and they'll automatically show up here and in the POS waiter dropdown.
      </p>

      <div className="mt-6 space-y-2">
        {isLoading ? (
          <div className="rounded-2xl bg-slate-50 px-4 py-4 text-sm text-slate-500">Loading...</div>
        ) : waiters.length === 0 ? (
          <div className="rounded-2xl bg-slate-50 px-4 py-4 text-sm text-slate-500">No waiters or order takers yet.</div>
        ) : (
          waiters.map((waiter) => (
            <div key={waiter.id} className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${waiter.isActive ? "bg-emerald-100 text-emerald-600" : "bg-slate-200 text-slate-500"}`}>
                  {waiter.isActive ? <UserRoundCheck size={16} /> : <UserRoundX size={16} />}
                </div>
                <p className="text-sm font-bold text-slate-900">{waiter.name}</p>
              </div>
              <span className="text-xs font-bold uppercase text-slate-400">{waiter.isActive ? "Available in POS" : "Hidden"}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// --- SHARED UI ATOMS ---

function StatCard({ label, value, color }: { label: string, value: string, color: string }) {
  return (
    <div className="glass p-6 rounded-[32px]">
      <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest mb-1">{label}</p>
      <h3 className={`text-3xl font-black ${color}`}>{value}</h3>
    </div>
  );
}

function StatusCard({ icon, label, value, color, iconColor }: { icon: React.ReactNode; label: string; value: string; color: string; iconColor: string }) {
  return (
    <div className={`glass p-6 rounded-[32px] border-b-4 ${color} transition-transform hover:-translate-y-1`}>
      <div className={`${iconColor} mb-2`}>{icon}</div>
      <div className="text-2xl font-black text-slate-900">{value}</div>
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</p>
    </div>
  );
}

function SearchBar({ placeholder, focusColor }: { placeholder: string, focusColor: string }) {
  return (
    <div className="relative w-full md:w-96">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
      <input
        type="text"
        placeholder={placeholder}
        className={`w-full pl-12 pr-4 py-3 bg-white/50 shadow-inner rounded-2xl border border-white/60 text-sm outline-none focus:ring-2 ${focusColor}`}
      />
    </div>
  );
}
