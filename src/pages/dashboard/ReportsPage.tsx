import React, { useState } from 'react';
import { 
  BarChart, LineChart, PieChart, Calendar, 
  Download, Share2, Filter, ArrowUpRight, 
  ArrowDownRight, FileSpreadsheet, FileText,
  TrendingUp, Target, Layers
} from 'lucide-react';

export default function ReportsPage() {
  const [range, setRange] = useState("Last 30 Days");

  return (
    <div className="min-h-screen bg-[#F4F7FA] p-4 lg:p-8 space-y-8 text-slate-900">
      
      {/* Strategic Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black tracking-tight flex items-center gap-3">
            Intelligence Hub <BarChart className="text-indigo-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">Comprehensive performance analytics and growth forecasting.</p>
        </div>
        
        <div className="flex bg-white p-1.5 rounded-[20px] shadow-sm border border-slate-100">
          {["7D", "30D", "3M", "1Y", "All"].map((item) => (
            <button 
              key={item}
              onClick={() => setRange(item)}
              className={`px-5 py-2 rounded-xl text-xs font-black transition-all ${
                range === item ? "bg-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),inset_0_-2px_5px_rgba(0,0,0,0.4)]" : "text-slate-400 hover:text-slate-600"
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      {/* High-Level KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <KPICard label="Net Profit Margin" value="24.2%" growth="+2.1%" upbeat={true} />
        <KPICard label="Customer LTV" value="Rs 1,420" growth="+12.5%" upbeat={true} />
        <KPICard label="Churn Rate" value="1.8%" growth="-0.4%" upbeat={true} />
        <KPICard label="Inventory Turnover" value="4.2x" growth="-1.2%" upbeat={false} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Main Analytics: Revenue vs Expenses Chart Placeholder */}
        <div className="lg:col-span-2 space-y-8">
          <div className="bg-white p-8 rounded-[40px] shadow-sm border border-slate-100 min-h-[450px] relative flex flex-col">
            <div className="flex justify-between items-start mb-12">
              <div>
                <h3 className="font-black text-xl">Financial Growth</h3>
                <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mt-1">Revenue vs. Cost of Goods</p>
              </div>
              <div className="flex gap-2">
                <button className="p-2 bg-slate-50 rounded-xl text-slate-400 hover:text-indigo-600 transition-colors"><Share2 size={18}/></button>
                <button className="p-2 bg-slate-50 rounded-xl text-slate-400 hover:text-indigo-600 transition-colors"><Filter size={18}/></button>
              </div>
            </div>
            
            {/* Visual Placeholder for a Chart */}
            <div className="flex-1 w-full bg-slate-50 rounded-[32px] border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400 group cursor-pointer hover:bg-slate-100/50 transition-colors">
              <LineChart size={48} className="mb-4 opacity-20 group-hover:scale-110 transition-transform" />
              <p className="font-black text-sm">Revenue Visualization Area</p>
              <p className="text-[10px] font-bold uppercase tracking-tighter">Integration: Recharts / Chart.js</p>
            </div>
          </div>

          {/* Breakdown Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white p-6 rounded-[32px] border border-slate-100 flex items-center gap-6">
              <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600">
                <Target size={32} />
              </div>
              <div>
                <h4 className="font-black text-lg">Sales Goal</h4>
                <p className="text-xs text-slate-400 font-bold mb-2">85% of Monthly Target</p>
                <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-600 w-[85%]" />
                </div>
              </div>
            </div>
            <div className="bg-white p-6 rounded-[32px] border border-slate-100 flex items-center gap-6">
              <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center text-emerald-600">
                <TrendingUp size={32} />
              </div>
              <div>
                <h4 className="font-black text-lg">Top Region</h4>
                <p className="text-xs text-slate-400 font-bold">North Metropolitan</p>
                <p className="text-[10px] text-emerald-600 font-black uppercase">+Rs 12k this week</p>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar: Automated Reports & Export */}
        <div className="space-y-6">
          <div className="bg-slate-900 rounded-[40px] p-8 text-white shadow-2xl shadow-slate-200">
            <Layers className="text-indigo-400 mb-4" size={32} />
            <h3 className="text-xl font-black mb-1">Export Center</h3>
            <p className="text-slate-400 text-sm font-medium mb-8">Generate official documents for stakeholders.</p>
            
            <div className="space-y-3">
              <ExportItem icon={<FileSpreadsheet size={16}/>} label="Full P&L Statement" type="XLSX" />
              <ExportItem icon={<FileText size={16}/>} label="Tax Compliance Report" type="PDF" />
              <ExportItem icon={<PieChart size={16}/>} label="Market Share Analysis" type="CSV" />
            </div>

            <button className="w-full mt-8 py-4 border-[0.5px] border-white/20 bg-indigo-600 hover:bg-indigo-500 rounded-[24px] text-xs font-black transition-all uppercase tracking-widest shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_-3px_7px_rgba(0,0,0,0.35)]">
              Schedule Auto-Email
            </button>
          </div>

          <div className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm">
            <h3 className="font-black text-lg text-slate-900 mb-6 flex items-center gap-2">
              <Calendar className="text-indigo-600" size={20}/> Insights
            </h3>
            <div className="space-y-6">
              <div className="relative pl-6 border-l-2 border-indigo-100">
                <div className="absolute -left-1.5 top-0 w-3 h-3 bg-indigo-600 rounded-full" />
                <p className="text-xs font-black text-slate-900 mb-1">Peak Sales Prediction</p>
                <p className="text-[10px] text-slate-400 font-bold">Data suggests a 20% spike next Tuesday due to seasonal trends.</p>
              </div>
              <div className="relative pl-6 border-l-2 border-slate-100">
                <div className="absolute -left-1.5 top-0 w-3 h-3 bg-slate-300 rounded-full" />
                <p className="text-xs font-black text-slate-900 mb-1">Inventory Optimization</p>
                <p className="text-[10px] text-slate-400 font-bold">Lower 'Beverage' stock levels by 5% to reduce holding costs.</p>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

// --- UI ATOMS ---

function KPICard({ label, value, growth, upbeat }: { label: string, value: string, growth: string, upbeat: boolean }) {
  return (
    <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm group hover:border-indigo-200 transition-colors">
      <div className="flex justify-between items-start mb-4">
        <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest leading-tight">{label}</p>
        <div className={`flex items-center gap-0.5 text-[10px] font-black px-2 py-0.5 rounded-md ${upbeat ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"}`}>
          {upbeat ? <ArrowUpRight size={10}/> : <ArrowDownRight size={10}/>} {growth}
        </div>
      </div>
      <h2 className="text-3xl font-black text-slate-900 group-hover:text-indigo-600 transition-colors">{value}</h2>
    </div>
  );
}

function ExportItem({ icon, label, type }: { icon: any, label: string, type: string }) {
  return (
    <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5 hover:border-white/20 hover:bg-white/10 transition-all cursor-pointer group">
      <div className="flex items-center gap-3">
        <div className="text-slate-500 group-hover:text-indigo-400 transition-colors">{icon}</div>
        <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors">{label}</span>
      </div>
      <span className="text-[8px] font-black bg-white/10 px-2 py-1 rounded text-slate-500">{type}</span>
    </div>
  );
}
