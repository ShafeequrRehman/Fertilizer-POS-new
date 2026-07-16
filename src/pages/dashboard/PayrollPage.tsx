import React, { useState } from 'react';
import { 
  Banknote, Landmark, Receipt, Calendar, 
  ArrowUpRight, Download, CheckCircle2, 
  AlertCircle, CreditCard, ChevronRight,
  Calculator, History
} from 'lucide-react';

const PAYROLL_HISTORY = [
  { id: "PR-2026-03", period: "March 01 - March 15", total: 18450.00, employees: 12, status: "Paid", date: "Mar 16, 2026" },
  { id: "PR-2026-02", period: "Feb 15 - Feb 28", total: 17200.00, employees: 12, status: "Paid", date: "Mar 01, 2026" },
  { id: "PR-2026-01", period: "Feb 01 - Feb 14", total: 17800.00, employees: 11, status: "Paid", date: "Feb 15, 2026" },
];

export default function PayrollPage() {
  const [isProcessing, setIsProcessing] = useState(false);

  return (
    <div className="min-h-screen bg-[#F9FAFB] p-4 lg:p-8 space-y-8">
      
      {/* Header Area */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            Payroll Processing <Landmark className="text-purple-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">Manage employee compensation and tax compliance.</p>
        </div>
        
        <div className="flex gap-3">
          <button className="flex items-center gap-2 px-6 py-4 bg-white border border-slate-200 rounded-[20px] font-black text-sm hover:bg-slate-50 transition-all">
            <History size={18} /> View History
          </button>
          <button 
            onClick={() => setIsProcessing(true)}
            className="flex items-center gap-2 px-6 py-4 bg-purple-600 text-white rounded-[20px] font-black text-sm hover:bg-purple-700 transition-all shadow-lg shadow-purple-200"
          >
            <Calculator size={18} /> Run Payroll
          </button>
        </div>
      </div>

      {/* Payroll Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm relative overflow-hidden group">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2">Next Pay Date</p>
            <h2 className="text-3xl font-black text-slate-900 flex items-center gap-2">
                March 31, 2026 <Calendar className="text-purple-500" size={20}/>
            </h2>
            <div className="mt-4 flex items-center gap-2 text-xs font-bold text-amber-600 bg-amber-50 w-fit px-3 py-1 rounded-full">
                <AlertCircle size={14}/> 8 days remaining
            </div>
        </div>

        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2">Estimated Total</p>
            <h2 className="text-3xl font-black text-slate-900">Rs 19,250.00</h2>
            <p className="text-slate-400 text-xs font-bold mt-2 italic">Including taxes & benefits</p>
        </div>

        <div className="bg-purple-900 p-8 rounded-[32px] text-white shadow-xl shadow-purple-100">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-purple-300 mb-2">YTD Disbursement</p>
            <h2 className="text-3xl font-black">Rs 108,400.00</h2>
            <p className="text-purple-400 text-xs font-bold mt-2 flex items-center gap-1">
                <ArrowUpRight size={14}/> 4.2% increase from 2025
            </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Main: Payment History Table */}
        <div className="lg:col-span-2 bg-white rounded-[40px] shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-8 border-b border-slate-50 flex items-center justify-between bg-white/50 backdrop-blur-md">
            <h3 className="font-black text-xl text-slate-900">Recent Disbursements</h3>
            <button className="p-2 text-slate-400 hover:text-purple-600 transition-colors">
              <Download size={20} />
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-slate-400 text-[10px] uppercase tracking-widest font-black">
                  <th className="px-8 py-6">Reference ID</th>
                  <th className="px-8 py-6">Pay Period</th>
                  <th className="px-8 py-6">Total Amount</th>
                  <th className="px-8 py-6">Status</th>
                  <th className="px-8 py-6"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {PAYROLL_HISTORY.map((pr) => (
                  <tr key={pr.id} className="group hover:bg-slate-50/50 transition-colors">
                    <td className="px-8 py-6">
                      <div className="text-sm font-black text-slate-900">{pr.id}</div>
                      <div className="text-[10px] font-bold text-slate-400 uppercase">{pr.date}</div>
                    </td>
                    <td className="px-8 py-6">
                      <span className="text-sm font-bold text-slate-600">{pr.period}</span>
                    </td>
                    <td className="px-8 py-6">
                      <span className="text-sm font-black text-slate-900">Rs {pr.total.toLocaleString()}</span>
                      <div className="text-[10px] text-slate-400 font-bold uppercase">{pr.employees} Employees</div>
                    </td>
                    <td className="px-8 py-6">
                      <span className="flex items-center gap-1.5 text-[10px] font-black uppercase px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg w-fit">
                        <CheckCircle2 size={12}/> {pr.status}
                      </span>
                    </td>
                    <td className="px-8 py-6 text-right">
                      <button className="p-2 text-slate-300 hover:text-purple-600">
                        <ChevronRight size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Sidebar: Cost Breakdown */}
        <div className="space-y-6">
            <div className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm">
                <h3 className="text-lg font-black text-slate-900 mb-6 flex items-center gap-2">
                    <Receipt className="text-purple-600" size={20}/> Cost Breakdown
                </h3>
                <div className="space-y-4">
                    {[
                        { label: "Net Salaries", amount: 14200.00, color: "bg-purple-600" },
                        { label: "Tax & Social Security", amount: 3200.00, color: "bg-blue-500" },
                        { label: "Benefits & Bonuses", amount: 1850.00, color: "bg-emerald-500" },
                    ].map((item, i) => (
                        <div key={i} className="group">
                            <div className="flex justify-between text-xs font-bold text-slate-500 mb-2">
                                <span>{item.label}</span>
                                <span className="text-slate-900">Rs {item.amount.toLocaleString()}</span>
                            </div>
                            <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                                <div className={`h-full ${item.color} transition-all duration-1000`} style={{ width: `${(item.amount / 19250) * 100}%` }} />
                            </div>
                        </div>
                    ))}
                </div>
                
                <div className="mt-8 pt-6 border-t border-slate-50">
                    <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                        <div className="p-2 bg-white rounded-xl shadow-sm">
                            <Banknote className="text-slate-400" size={20}/>
                        </div>
                        <div>
                            <p className="text-[10px] font-black uppercase text-slate-400 leading-tight">Primary Account</p>
                            <p className="text-sm font-black text-slate-900">Chase Business ...9920</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="bg-indigo-600 rounded-[40px] p-8 text-white relative overflow-hidden group hover:scale-[1.02] transition-transform cursor-pointer">
                <CreditCard className="absolute -right-6 -top-6 text-white/10 group-hover:rotate-12 transition-transform" size={120} />
                <h4 className="text-sm font-black mb-1">Quick Pay: Hourly Staff</h4>
                <p className="text-indigo-100 text-xs font-medium mb-6">Process payments for part-time workers.</p>
                <div className="flex items-center gap-2 text-xs font-black uppercase bg-white/10 w-fit px-4 py-2 rounded-xl backdrop-blur-md">
                    Execute <ArrowUpRight size={14}/>
                </div>
            </div>
        </div>

      </div>
    </div>
  );
}
