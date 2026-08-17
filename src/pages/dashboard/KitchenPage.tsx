
import { useEffect, useState } from 'react';
import { ChefHat, Clock, Printer, RefreshCcw, Settings, XCircle } from 'lucide-react';
import { fetchOrders } from '@/lib/pos-api';
import { SavedOrder } from '@/lib/pos-types';
import { isDesktopApp } from '@/lib/api';
import { useNetworkStatus } from '@/lib/network-status';
import { pushOrdersCache } from '@/lib/local-hub-api';
import { loadOrdersFromLocalHub } from '@/lib/offline-order-helpers';
import { listenForPrintSentMessages } from '@/lib/print-notify';
import { useToast } from '@/lib/toast';

export default function KitchenPage() {
  const { toast } = useToast();
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [printReadyUrl, setPrintReadyUrl] = useState<string | null>(null);

  const [kitchenPrinter, setKitchenPrinter] = useState(() => typeof window === 'undefined' ? '' : (window.localStorage.getItem('preferred-kitchen-printer') ?? ''));
  const [cashierPrinter, setCashierPrinter] = useState(() => typeof window === 'undefined' ? '' : (window.localStorage.getItem('preferred-cashier-printer') ?? ''));
  const { isOnline } = useNetworkStatus();

  // This page always prints via the hidden auto-print iframe (see
  // handlePrint/printReadyUrl below) - it has no direct Electron IPC print
  // call of its own. That iframe loads PrintOrderPage.tsx in a separate,
  // invisible React tree, so it posts a message up here once it's actually
  // called window.print() - see print-notify.ts.
  useEffect(() => listenForPrintSentMessages(toast), [toast]);

  useEffect(() => {
    window.localStorage.setItem('preferred-kitchen-printer', kitchenPrinter);
  }, [kitchenPrinter]);

  useEffect(() => {
    window.localStorage.setItem('preferred-cashier-printer', cashierPrinter);
  }, [cashierPrinter]);

  // Polling for live orders every 10 seconds (in a real app this would be
  // WebSockets). Always reads the Local Hub's cache first (instant, never
  // a live cloud call up front - see offline-order-helpers.ts's
  // loadOrdersFromLocalHub) so this never depends on connectivity or a
  // possibly-stale isOnline reading; the real cloud fetch below still runs
  // whenever online, in the background, to stay current and refresh that
  // cache for next time.
  async function loadOrders() {
    if (isDesktopApp()) {
      try {
        setOrders(await loadOrdersFromLocalHub());
      } catch {
        // Local Hub itself unreachable - leave whatever was last shown.
      } finally {
        setLoading(false);
      }
      if (!isOnline) return;
    }

    try {
      // Only ever displays currently-pending tickets - bounding the fetch
      // to the last 2 days (generous margin for anything genuinely stuck
      // pending) keeps this 10-second poll fast regardless of how much
      // order history this shop has accumulated overall. See getOrders'
      // `since` handling in orderController.js.
      const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const data = await fetchOrders({ since });
      setOrders(data || []);
      if (isDesktopApp() && data) void pushOrdersCache(data).catch(() => {});
    } catch {
      // Suppress polling errors
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOrders();
    const interval = setInterval(loadOrders, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  const pendingOrders = orders.filter(o => o.status === 'pending');

  function age(createdAt: string) { 
    const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000); 
    if (mins < 0) return 'Just now';
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`; 
  }

  function handlePrint(id: string) {
    setPrintReadyUrl(null); // Reset
    setTimeout(() => {
      setPrintReadyUrl(`/dashboard/sales/print/${id}?auto=true&type=kitchen`);
    }, 50);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            Kitchen Display <ChefHat size={24} className="text-orange-500" />
          </h1>
          <p className="text-gray-400 text-xs">Live ticket queue for pending orders.</p>
        </div>
        <div className="flex gap-2">
           <button onClick={() => loadOrders()} className="rounded-2xl bg-white shadow-sm px-4 py-3 text-sm font-black text-gray-700 hover:bg-gray-50 flex items-center gap-2">
             <RefreshCcw size={16} /> Refresh
           </button>
           <button onClick={() => setShowSettings(true)} className="rounded-2xl bg-white shadow-sm px-4 py-3 text-sm font-black text-gray-700 hover:bg-gray-50 flex items-center gap-2">
             <Settings size={16} /> Print Configuration
           </button>
        </div>
      </div>

      {loading && orders.length === 0 ? (
         <div className="rounded-[32px] bg-white p-8 text-sm text-gray-500 shadow-sm">Loading tickets...</div>
      ) : null}

      {!loading && pendingOrders.length === 0 ? (
         <div className="flex flex-col items-center justify-center p-12 text-center text-gray-400 min-h-[400px] bg-white rounded-[32px] shadow-sm">
           <ChefHat size={64} className="mb-4 opacity-50" strokeWidth={1} />
           <p className="font-bold text-lg text-gray-500">No active tickets</p>
           <p className="text-sm">Kitchen is clear! Wait for new orders from the POS.</p>
         </div>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 items-start">
         {pendingOrders.map(order => (
           <div key={order.id} className="bg-white rounded-[24px] shadow-sm overflow-hidden flex flex-col border border-transparent transition hover:border-gray-200">
             {/* Ticket Header */}
             <div className="bg-[#F8F9FB] p-4 border-b border-gray-100 flex justify-between items-start">
               <div>
                 <p className="text-[10px] font-black uppercase text-gray-400">Order #{order.id.slice(-4)}</p>
                 <h3 className="font-bold text-gray-900 mt-0.5">{order.orderType === 'DineIn' ? `Table ${order.table || '?'}` : order.orderType}</h3>
               </div>
               <div className="flex flex-col items-end gap-1">
                 <span className="bg-orange-100 text-orange-700 text-[10px] font-black uppercase px-2 py-0.5 rounded-full flex items-center gap-1">
                   <Clock size={10} /> {age(order.createdAt)}
                 </span>
               </div>
             </div>

             {/* Ticket Items */}
             <div className="p-4 space-y-3 flex-1">
               {order.items.map((item, idx) => (
                 <div key={idx} className="flex gap-3 text-sm">
                   <div className="font-black text-gray-900 min-w-4">{item.quantity}x</div>
                   <div>
                     <p className="font-bold text-gray-800">{item.name}</p>
                     {item.variation && <p className="text-xs text-gray-500">- {item.variation}</p>}
                   </div>
                 </div>
               ))}
               
               {order.note && (
                 <div className="mt-4 bg-yellow-50 text-yellow-800 text-xs p-3 rounded-xl border border-yellow-200">
                   <strong>Note:</strong> {order.note}
                 </div>
               )}
             </div>

             {/* Ticket Footer / Actions */}
             <div className="p-3 bg-white border-t border-gray-50">
                <button onClick={() => handlePrint(order.id)} className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-black text-white text-xs font-black uppercase tracking-wider hover:bg-gray-800 transition">
                  <Printer size={14} /> Print Ticket
                </button>
             </div>
           </div>
         ))}
      </div>

      {showSettings ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm sm:p-6">
          <div className="flex w-full max-w-md flex-col rounded-[32px] bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-100 p-6">
              <h2 className="text-xl font-black text-gray-900">Printer Configuration</h2>
              <button onClick={() => setShowSettings(false)} className="rounded-full bg-[#F6F7FB] p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"><XCircle size={18} /></button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="mb-1 block text-sm font-semibold text-gray-700">Kitchen Printer Label</label>
                <input value={kitchenPrinter} onChange={(event) => setKitchenPrinter(event.target.value)} placeholder="Example: Kitchen Epson" className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none focus:border-black" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-semibold text-gray-700">Cashier Printer Label</label>
                <input value={cashierPrinter} onChange={(event) => setCashierPrinter(event.target.value)} placeholder="Example: Front Counter POS" className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none focus:border-black" />
              </div>
              <p className="rounded-[20px] bg-[#F8F9FB] p-4 text-xs leading-relaxed text-gray-600">
                These settings sync across the entire app. The chosen labels will appear on the top of printed tickets so staff know which physical printer to choose from the browser print dialog.
              </p>
              <button type="button" onClick={() => setShowSettings(false)} className="w-full rounded-[20px] bg-black px-4 py-3 text-sm font-black text-white">Save Settings</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Invisible auto-print frame */}
      {printReadyUrl ? <iframe src={printReadyUrl} className="hidden" title="Kitchen Print Auto Frame" /> : null}
    </div>
  );
}
