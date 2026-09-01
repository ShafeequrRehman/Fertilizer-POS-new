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
  // Shop-lifetime, never-resetting order count (backend/models/Order.js's
  // shopSequenceNumber) - starts at 1 on this shop's very first order ever
  // and keeps counting up forever, unlike Order# above which resets every
  // shift. Falls back to the old id-derived value only for orders placed
  // before this field existed.
  const trNumber = order.shopSequenceNumber
    ? String(order.shopSequenceNumber).padStart(6, '0')
    : order.id.replace(/[^0-9a-z]/gi, '').slice(-6).toUpperCase();
  const totalQty = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const cashierName = getAuthUser()?.name || getAuthUser()?.username || '';

  // Scoped to this one shop only, per an explicit request not to change
  // anything for other shops on the same shared codebase. Centering
  // (margin: 0 auto) splits the 10mm of leftover width evenly on both
  // sides, which pushes the whole content block 5mm rightward - on a
  // printer narrower than expected that's 5mm of real content lost off
  // the right edge for no reason. Left-flush keeps content as close to
  // the paper's true left edge as possible, so a narrow printer only
  // loses unused blank margin, never real content.
  // Checks loginUsername/shopName, not businessEmail - see
  // pos-settings.ts's comment on those fields for why (businessEmail
  // defaults to a placeholder most shops never edit, so a check keyed on
  // it silently never matched).
  const shopHaystack = `${settings.loginUsername || ''} ${settings.shopName || ''} ${settings.businessEmail || ''}`.toLowerCase();
  const isHeavenSlice = shopHaystack.includes('heavenslice') || shopHaystack.includes('heaven slice');
  const receiptMargin = isHeavenSlice ? '0 8mm 0 2mm' : '0 auto';

  return (
    <div className="thermal-receipt w-[70mm] max-w-[70mm] bg-white text-black font-mono text-[12px] leading-[15px] pb-2">
      {/* 70mm content inside an 80mm page - see ItemizedBillReceipt.tsx's
          matching comment for why (bold text right up against the old
          72mm edge was clipping on a real printout). */}
      <style dangerouslySetInnerHTML={{ __html: `
        .thermal-receipt { box-sizing: border-box; color: #000; overflow: visible; padding-top: 0; }
        .thermal-receipt * { box-sizing: border-box; }
        @media print {
          @page { margin: 0; size: 80mm auto; }
          html, body { width: 80mm; margin: 0; padding: 0; background: #fff; }
          .thermal-receipt { width: 70mm !important; max-width: 70mm !important; margin: ${receiptMargin} !important; }
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

      {/* Metadata - space-y-2 gives each individual line (Tr#, Date, M/S,
          Order#, Waiter) breathing room from the one above/below it, on
          top of the block's own margin from the boxed order type above and
          the KOT rule below. */}
      <div className="mt-3 mb-3 space-y-2">
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
          <span className="w-5 shrink-0">#</span>
          <span className="min-w-0 flex-1">Item Detail</span>
          <span className="w-10 shrink-0 text-right pr-[1mm]">Qty</span>
        </div>
        {order.items.map((item, idx) => (
          <div key={idx} className="mb-1.5">
            <div className="flex justify-between">
              <span className="w-5 shrink-0">{idx + 1}</span>
              <span className="min-w-0 flex-1 break-words pr-1 uppercase">{item.name}{item.variation ? ` (${item.variation})` : ''}</span>
              <span className="w-10 shrink-0 text-right font-bold pr-[1mm]">{item.quantity}</span>
            </div>
          </div>
        ))}
        <div className="border-t border-black mt-1 pt-1 flex justify-between font-bold">
          <span>Total:</span>
          <span className="pr-[1mm]">{totalQty}</span>
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
