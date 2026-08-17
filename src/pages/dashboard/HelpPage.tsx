import React from 'react';
import { 
  Search, BookOpen, MessageCircle, Video, 
  LifeBuoy, ChevronRight, ExternalLink, 
  FileQuestion, Lightbulb, PlayCircle,
  Headphones, Mail
} from 'lucide-react';

const CATEGORIES = [
  { title: "Getting Started", icon: <PlayCircle className="text-blue-500" />, articles: 12 },
  { title: "POS Operations", icon: <BookOpen className="text-teal-500" />, articles: 24 },
  { title: "Accounting & Tax", icon: <FileQuestion className="text-purple-500" />, articles: 18 },
  { title: "Inventory Help", icon: <Lightbulb className="text-amber-500" />, articles: 15 },
];

const POPULAR_QUESTIONS = [
  "How do I process a refund?",
  "Setting up a new thermal printer",
  "Exporting year-end tax reports",
  "Adding multiple staff roles",
];

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-[#FDFDFF] p-4 lg:p-8 space-y-12">
      
      {/* Hero Search Section */}
      <div className="relative bg-slate-900 rounded-[48px] p-12 lg:p-20 overflow-hidden text-center shadow-2xl shadow-slate-200">
        <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/10 blur-[100px] -mr-48 -mt-48" />
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-teal-500/10 blur-[80px] -ml-32 -mb-32" />
        
        <div className="relative z-10 max-w-2xl mx-auto space-y-6">
          <h1 className="text-4xl md:text-5xl font-black text-white tracking-tight">How can we help?</h1>
          <p className="text-slate-400 font-medium text-lg">Search our knowledge base or browse categories below.</p>
          
          <div className="relative mt-8">
            <Search className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400" size={24} />
            <input 
              type="text" 
              placeholder="Search for articles, guides, and more..." 
              className="w-full pl-16 pr-8 py-6 bg-white/10 border border-white/10 rounded-[28px] text-white placeholder-slate-500 text-lg outline-none focus:ring-4 focus:ring-indigo-500/30 backdrop-blur-md transition-all"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-12 max-w-7xl mx-auto">
        
        {/* Left: Content Area */}
        <div className="lg:col-span-2 space-y-12">
          
          {/* Categories Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {CATEGORIES.map((cat, i) => (
              <div key={i} className="group bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm hover:shadow-md transition-all cursor-pointer hover:-translate-y-1">
                <div className="flex items-center justify-between mb-4">
                  <div className="p-4 bg-slate-50 rounded-2xl group-hover:bg-white group-hover:shadow-inner transition-colors">
                    {cat.icon}
                  </div>
                  <ChevronRight size={18} className="text-slate-300 group-hover:text-slate-900 transition-colors" />
                </div>
                <h3 className="text-xl font-black text-slate-900">{cat.title}</h3>
                <p className="text-slate-400 text-sm font-bold mt-1 uppercase tracking-tighter">{cat.articles} Articles</p>
              </div>
            ))}
          </div>

          {/* Popular Questions */}
          <div className="space-y-6">
            <h3 className="text-2xl font-black text-slate-900 flex items-center gap-3">
              Popular Questions <LifeBuoy className="text-indigo-600" size={24} />
            </h3>
            <div className="grid grid-cols-1 gap-3">
              {POPULAR_QUESTIONS.map((q, i) => (
                <button key={i} className="flex items-center justify-between p-6 bg-white border border-slate-100 rounded-2xl hover:bg-slate-50 transition-colors group">
                  <span className="text-slate-700 font-bold text-left">{q}</span>
                  <ExternalLink size={16} className="text-slate-300 group-hover:text-indigo-600" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Sidebar Support */}
        <div className="space-y-8">
          
          {/* Contact Support Card */}
          <div className="bg-indigo-600 rounded-[40px] p-8 text-white relative overflow-hidden group">
            <div className="relative z-10">
              <h3 className="text-2xl font-black mb-2">Can't find it?</h3>
              <p className="text-indigo-100 text-sm font-medium mb-8">Our support team is available 24/7 via live chat.</p>
              
              <div className="space-y-3">
                <button className="w-full flex items-center justify-center gap-2 py-4 bg-white text-indigo-600 rounded-2xl font-black text-sm hover:bg-indigo-50 transition-all">
                  <MessageCircle size={18} /> Start Live Chat
                </button>
                <button className="w-full flex items-center justify-center gap-2 py-4 bg-white/10 text-white rounded-2xl font-black text-sm hover:bg-white/20 transition-all border border-white/10">
                  <Mail size={18} /> Email Support
                </button>
              </div>
            </div>
            <Headphones size={120} className="absolute -bottom-10 -right-10 text-white/10 group-hover:rotate-12 transition-transform" />
          </div>

          {/* Video Tutorials */}
          <div className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm">
            <h3 className="font-black text-lg text-slate-900 mb-6 flex items-center gap-2">
              <Video className="text-rose-500" size={20}/> Video Guides
            </h3>
            <div className="space-y-4">
              {[1, 2].map((v) => (
                <div key={v} className="relative aspect-video bg-slate-100 rounded-2xl overflow-hidden group cursor-pointer">
                  <div className="absolute inset-0 bg-slate-900/20 group-hover:bg-slate-900/40 transition-all flex items-center justify-center">
                    <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                      <PlayCircle size={24} className="text-rose-500 ml-0.5" />
                    </div>
                  </div>
                  <img src={`https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=400&q=80&idx=${v}`} alt="tutorial" className="w-full h-full object-cover" />
                </div>
              ))}
            </div>
          </div>

          {/* System Status Indicator */}
          <div className="flex items-center gap-3 px-6 py-4 bg-emerald-50 border border-emerald-100 rounded-2xl">
            <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-xs font-black text-emerald-700 uppercase tracking-widest">All Systems Operational</span>
          </div>

        </div>

      </div>
    </div>
  );
}