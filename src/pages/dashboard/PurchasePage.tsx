import React, { useState } from 'react';
import { 
  Truck, ShoppingCart, PackagePlus, Clock, 
  ChevronRight, Search, Filter, AlertCircle,
  CheckCircle2, Box, ArrowRight
} from 'lucide-react';

const PURCHASE_ORDERS = [
  { id: "PO-5501", supplier: "Global Tech Distrib.", date: "Mar 23, 2026", items: 12, total: 14200.00, status: "Pending" },
  { id: "PO-5502", supplier: "Fresh Farms Ltd.", date: "Mar 22, 2026", items: 45, total: 840.50, status: "Received" },
  { id: "PO-5503", supplier: "Eco Packaging Co.", date: "Mar 21, 2026", items: 100, total: 210.00, status: "Shipped" },
  { id: "PO-5504", supplier: "Beverage World", date: "Mar 20, 2026", items: 24, total: 3100.00, status: "Delayed" },
];

export default function PurchasePage() {
  const [view, setView] = useState("Orders");

  return (
    <div className="min-h-screen bg-[#F1F5F9] p-4 lg:p-8 space-y-8">
      
      {/* Header & Main Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            Procurement <Truck className="text-indigo-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">Manage supply chain and stock replenishment.</p>
        </div>
        
        <div className="flex gap-3">
          <div className="relative hidden xl:block">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input 
              type="text" 
              placeholder="Track PO number..." 
              className="pl-12 pr-4 py-3 bg-white border-none rounded-2xl shadow-sm focus:ring-2 focus:ring-indigo-500 w-64 text-sm outline-none"
            />
          </div>
          <button className="flex items-center gap-2 px-6 py-4 border-[0.5px] border-white/30 bg-indigo-600 text-white rounded-[20px] font-black text-sm hover:bg-indigo-700 transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-3px_7px_rgba(49,46,129,0.5)]">
            <PackagePlus size={18} /> New Purchase Order
          </button>
        </div>
      </div>

      {/* Critical Stock Alerts */}
      <div className="bg-orange-50 border border-orange-100 p-6 rounded-[32px] flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-orange-500 text-white rounded-2xl animate-pulse">
            <AlertCircle size={24}/>
          </div>
          <div>
            <h4 className="font-black text-orange-900">Low Stock Warning</h4>
            <p className="text-orange-700 text-sm font-medium">12 items are below safety threshold. Restock recommended.</p>
          </div>
        </div>
        <button className="px-6 py-2 bg-orange-500 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-orange-600 transition-colors">
          Auto-Generate PO
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        
        {/* Sidebar: Supplier Quick Access */}
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-[32px] shadow-sm border border-slate-200">
            <h3 className="font-black text-slate-900 mb-4 flex items-center justify-between">
              Suppliers <span className="text-[10px] text-indigo-500">View All</span>
            </h3>
            <div className="space-y-3">
              {["Global Tech", "Fresh Farms", "Eco Pack", "Bev World"].map((sup, i) => (
                <div key={i} className="flex items-center justify-between p-3 hover:bg-slate-50 rounded-2xl cursor-pointer transition-colors group">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center font-black text-slate-400 group-hover:bg-indigo-100 group-hover:text-indigo-600 transition-colors">
                      {sup[0]}
                    </div>
                    <span className="text-sm font-bold text-slate-700">{sup}</span>
                  </div>
                  <ChevronRight size={14} className="text-slate-300" />
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-900 p-8 rounded-[32px] text-white overflow-hidden relative">
            <Box className="absolute -right-4 -bottom-4 text-white/10" size={120} />
            <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500 mb-2">Monthly Spend</h4>
            <div className="text-3xl font-black">Rs 24,102</div>
            <p className="text-[10px] text-indigo-400 font-bold mt-4 flex items-center gap-1">
               Active POs: 14 <ArrowRight size={10}/>
            </p>
          </div>
        </div>

        {/* Main: Purchase Order List */}
        <div className="lg:col-span-3 bg-white rounded-[40px] shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-8 border-b border-slate-50 flex items-center justify-between">
            <div className="flex gap-6">
              {["Orders", "Returns", "Invoices"].map((tab) => (
                <button 
                  key={tab}
                  onClick={() => setView(tab)}
                  className={`text-sm font-black transition-all relative pb-2 ${
                    view === tab ? "text-indigo-600" : "text-slate-400"
                  }`}
                >
                  {tab}
                  {view === tab && <div className="absolute bottom-0 left-0 w-full h-1 bg-indigo-600 rounded-full" />}
                </button>
              ))}
            </div>
            <button className="p-2 bg-slate-50 text-slate-400 rounded-xl hover:text-indigo-600 transition-colors">
              <Filter size={18} />
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-slate-400 text-[10px] uppercase tracking-widest font-black">
                  <th className="px-8 py-6">Order Info</th>
                  <th className="px-8 py-6">Supplier</th>
                  <th className="px-8 py-6">Items</th>
                  <th className="px-8 py-6">Status</th>
                  <th className="px-8 py-6 text-right">Total Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {PURCHASE_ORDERS.map((po) => (
                  <tr key={po.id} className="group hover:bg-slate-50/50 transition-colors cursor-pointer">
                    <td className="px-8 py-6">
                      <div className="flex items-center gap-4">
                        <div className="w-2 h-2 rounded-full bg-indigo-500" />
                        <div>
                          <div className="text-sm font-black text-slate-900">{po.id}</div>
                          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{po.date}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-8 py-6">
                      <span className="text-sm font-bold text-slate-600">{po.supplier}</span>
                    </td>
                    <td className="px-8 py-6">
                      <span className="text-sm font-black text-slate-900">{po.items} units</span>
                    </td>
                    <td className="px-8 py-6">
                      <span className={`flex items-center gap-1.5 text-[10px] font-black uppercase px-3 py-1.5 rounded-lg w-fit ${
                        po.status === 'Received' ? "bg-emerald-50 text-emerald-600" : 
                        po.status === 'Delayed' ? "bg-rose-50 text-rose-600" : "bg-blue-50 text-blue-600"
                      }`}>
                        {po.status === 'Received' ? <CheckCircle2 size={12}/> : <Clock size={12}/>}
                        {po.status}
                      </span>
                    </td>
                    <td className="px-8 py-6 text-right">
                      <div className="text-sm font-black text-slate-900">Rs {po.total.toLocaleString()}</div>
                      <div className="text-[10px] font-bold text-indigo-500 uppercase">Net 30</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
