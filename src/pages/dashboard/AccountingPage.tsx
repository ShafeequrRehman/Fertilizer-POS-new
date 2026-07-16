import React, { useState } from 'react';
import { 
  BarChart3, PieChart, Receipt, Wallet, 
  ArrowUpCircle, ArrowDownCircle, Scale, 
  ChevronRight, Download, Plus, FileText
} from 'lucide-react';

const LEDGER_DATA = [
  { id: "TX-9920", Date: "Mar 23, 2026", Description: "Supplier: Fresh Greens Co.", Category: "Inventory", Amount: -450.00, Type: "Expense" },
  { id: "TX-9921", Date: "Mar 23, 2026", Description: "Daily POS Settlement", Category: "Sales", Amount: 2840.50, Type: "Income" },
  { id: "TX-9922", Date: "Mar 22, 2026", Description: "Monthly Store Rent", Category: "Fixed Costs", Amount: -1200.00, Type: "Expense" },
  { id: "TX-9923", Date: "Mar 22, 2026", Description: "Cloud Infrastructure", Category: "Software", Amount: -49.99, Type: "Expense" },
];

export default function AccountingPage() {
  return (
    <div className="min-h-screen bg-[#F8FAFC] p-4 lg:p-8 space-y-8 text-slate-900">
      
      {/* Header: Financial Summary */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Financial Ledger</h1>
          <p className="text-slate-500 font-medium">Fiscal Year 2026 • Period Q1</p>
        </div>
        
        <div className="flex gap-3">
          <button className="flex items-center gap-2 px-6 py-3 bg-white border border-slate-200 rounded-2xl font-bold text-sm hover:bg-slate-50 transition-all shadow-sm">
            <Download size={18} /> Export PDF
          </button>
          <button className="flex items-center gap-2 px-6 py-3 bg-black text-white rounded-2xl font-bold text-sm hover:scale-105 transition-all shadow-lg shadow-slate-200">
            <Plus size={18} /> Add Entry
          </button>
        </div>
      </div>

      {/* Financial Health Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm relative overflow-hidden group">
            <div className="flex justify-between items-center mb-6">
                <div className="p-3 bg-emerald-50 text-emerald-600 rounded-2xl"><Wallet size={24}/></div>
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total Balance</span>
            </div>
            <h2 className="text-4xl font-black">Rs 42,890.00</h2>
            <p className="text-emerald-500 text-sm font-bold mt-2 flex items-center gap-1">
                <ArrowUpCircle size={14}/> +Rs 2,400 this week
            </p>
        </div>

        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm">
            <div className="flex justify-between items-center mb-6">
                <div className="p-3 bg-blue-50 text-blue-600 rounded-2xl"><BarChart3 size={24}/></div>
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total Revenue</span>
            </div>
            <h2 className="text-4xl font-black">Rs 124,500.00</h2>
            <div className="w-full bg-slate-100 h-1.5 rounded-full mt-4">
                <div className="bg-blue-600 h-full w-[75%] rounded-full"/>
            </div>
        </div>

        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm">
            <div className="flex justify-between items-center mb-6">
                <div className="p-3 bg-rose-50 text-rose-600 rounded-2xl"><Scale size={24}/></div>
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Op. Expenses</span>
            </div>
            <h2 className="text-4xl font-black">Rs 18,240.00</h2>
            <p className="text-rose-500 text-sm font-bold mt-2 flex items-center gap-1">
                <ArrowDownCircle size={14}/> 14.6% of gross
            </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Transaction Ledger */}
        <div className="lg:col-span-2 bg-white rounded-[40px] shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-8 border-b border-slate-50 flex justify-between items-center bg-white/50 backdrop-blur-md sticky top-0">
            <h3 className="font-black text-xl">General Ledger</h3>
            <div className="flex gap-2">
                <button className="p-2 hover:bg-slate-100 rounded-xl transition-colors"><Receipt size={20} className="text-slate-400"/></button>
                <button className="p-2 hover:bg-slate-100 rounded-xl transition-colors"><FileText size={20} className="text-slate-400"/></button>
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-slate-400 text-[10px] uppercase tracking-[0.2em] font-black">
                  <th className="px-8 py-6">Date</th>
                  <th className="px-8 py-6">Description</th>
                  <th className="px-8 py-6">Category</th>
                  <th className="px-8 py-6 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {LEDGER_DATA.map((row) => (
                  <tr key={row.id} className="group hover:bg-slate-50/80 transition-all cursor-default">
                    <td className="px-8 py-6">
                        <span className="text-sm font-bold text-slate-400">{row.Date}</span>
                    </td>
                    <td className="px-8 py-6">
                        <div className="flex flex-col">
                            <span className="text-sm font-extrabold text-slate-800">{row.Description}</span>
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{row.id}</span>
                        </div>
                    </td>
                    <td className="px-8 py-6">
                        <span className="px-3 py-1.5 bg-slate-100 rounded-lg text-[10px] font-black text-slate-500 uppercase italic">
                            {row.Category}
                        </span>
                    </td>
                    <td className={`px-8 py-6 text-right font-black text-sm ${row.Amount > 0 ? "text-emerald-600" : "text-rose-500"}`}>
                        {row.Amount > 0 ? `+ Rs ${row.Amount.toFixed(2)}` : `- Rs ${Math.abs(row.Amount).toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Expense Breakdown / Insight Sidebar */}
        <div className="space-y-6">
            <div className="bg-black rounded-[40px] p-8 text-white shadow-2xl shadow-slate-300">
                <h3 className="text-xl font-black mb-6 flex items-center gap-2">
                    <PieChart className="text-emerald-400" size={24}/> Budgeting
                </h3>
                <div className="space-y-6">
                    {[
                        { label: "Inventory", value: 65, color: "bg-emerald-400" },
                        { label: "Staffing", value: 25, color: "bg-blue-400" },
                        { label: "Marketing", value: 10, color: "bg-rose-400" },
                    ].map((item, i) => (
                        <div key={i} className="space-y-2">
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
                <button className="w-full mt-10 py-4 bg-white/10 hover:bg-white/20 border border-white/10 rounded-[20px] text-xs font-black transition-all flex items-center justify-center gap-2">
                    Adjust Budgets <ChevronRight size={14}/>
                </button>
            </div>

            <div className="bg-emerald-500 rounded-[40px] p-8 text-white relative overflow-hidden">
                <div className="relative z-10">
                    <h4 className="text-lg font-black mb-2">Profit Target</h4>
                    <p className="text-emerald-100 text-sm font-medium mb-6">You are 82% towards your monthly goal.</p>
                    <div className="text-4xl font-black">Rs 8,200.00 <span className="text-lg opacity-50">/ 10k</span></div>
                </div>
                {/* Visual Flair */}
                <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-white/20 rounded-full blur-3xl" />
            </div>
        </div>

      </div>
    </div>
  );
}
