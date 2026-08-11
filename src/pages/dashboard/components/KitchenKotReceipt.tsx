import { useEffect, useState } from 'react';
import { SavedOrder } from '@/lib/pos-types';
import { getStoreSettings, defaultSettings } from '@/lib/pos-settings';
import { getAuthUser } from '@/lib/auth';

// Kitchen-facing "KOT" (Kitchen Order Ticket) template - modeled directly
// on a real kitchen printout the shop provided (no prices, just what to
// cook and for which table/order). ALTERNATIVE to ThermalReceipt.tsx's
// original kitchen layout - see ReceiptRenderer.tsx for how a shop picks
// between them (Settings > Manage Receipt > Kitchen Ticket Template) and
// pos-settings.ts's kitchenReceiptTemplate for where the choice lives.
export default function KitchenKotReceipt({ order }: { order: SavedOrder }) {
  const [settings, setSettings] = useState(defaultSettings);
  useEffect(() => {
    setSettings(getStoreSettings());
  }, []);

  const date = order.createdAt ? new Date(order.createdAt) : null;
  const dateString = date
    ? date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
    : '--';
  const timeString = date
    ? date.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' }).toLowerCase()
    : '--:--';
  const orderNumber = String(order.dailyOrderNumber ?? order.id.slice(-3)).padStart(3, '0');
  const trNumber = order.id.replace(/[^0-9a-z]/gi, '').slice(-6).toUpperCase();
  const totalQty = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const cashierName = getAuthUser()?.name || getAuthUser()?.username || '';

  return (
    <div className="thermal-receipt w-[72mm] max-w-[72mm] bg-white text-black font-mono text-[12px] leading-[15px] pb-2">
      <style dangerouslySetInnerHTML={{ __html: `
        .thermal-receipt { box-sizing: border-box; color: #000; overflow: visible; padding-top: 0; }
        .thermal-receipt * { box-sizing: border-box; }
        @media print {
          @page { margin: 0; size: 80mm auto; }
          html, body { width: 80mm; margin: 0; padding: 0; background: #fff; }
          .thermal-receipt { width: 72mm !important; max-width: 72mm !important; margin: 0 auto !important; }
        }
      ` }} />

      {/* Header */}
      <div className="text-center mb-2">
        <h1 className="text-[17px] leading-[19px] font-bold uppercase mb-0.5">{settings.receiptHeader || 'Store Name'}</h1>
        {settings.receiptSubHeader && <p className="uppercase">{settings.receiptSubHeader}</p>}
      </div>

      <div className="border border-black text-center py-1 mb-2">
        <span className="font-bold uppercase tracking-widest">{order.orderType}</span>
      </div>

      {/* Metadata */}
      <div className="mb-2 space-y-0.5">
        <p>Tr#: {trNumber}</p>
        <div className="flex justify-between"><span>DATE: {dateString}</span><span>{timeString}</span></div>
        <p>M/S: {(order.paymentMethod || 'Cash').toUpperCase()}</p>
        <div className="flex justify-between">
          <span>Order#: {orderNumber}</span>
          {order.orderType === 'DineIn' && order.table && <span>Table: {order.table}</span>}
        </div>
        {order.waiter && <p>Waiter: {order.waiter}</p>}
        {cashierName && <p>User: {cashierName}</p>}
      </div>

      <div className="border-t-2 border-black my-1.5" />
      <p className="text-center font-bold text-[15px] mb-2">*** KOT ***</p>

      {/* Items */}
      <div>
        <div className="flex justify-between font-bold border-b border-black pb-0.5 mb-1">
          <span className="w-5">#</span>
          <span className="flex-1">Item Detail</span>
          <span className="w-10 text-right">Qty</span>
        </div>
        {order.items.map((item, idx) => (
          <div key={idx} className="mb-1.5">
            <div className="flex justify-between">
              <span className="w-5">{idx + 1}</span>
              <span className="flex-1 pr-1 uppercase">{item.name}{item.variation ? ` (${item.variation})` : ''}</span>
              <span className="w-10 text-right font-bold">{item.quantity}</span>
            </div>
          </div>
        ))}
        <div className="border-t border-black mt-1 pt-1 flex justify-between font-bold">
          <span>Total:</span>
          <span>{totalQty}</span>
        </div>
      </div>

      {order.note && (
        <div className="mt-3 border border-black p-2">
          <p className="font-bold">Note:</p>
          <p>{order.note}</p>
        </div>
      )}
    </div>
  );
}
