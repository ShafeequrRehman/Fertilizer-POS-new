import { useEffect, useState } from 'react';
import { SavedOrder } from '@/lib/pos-types';
import { getStoreSettings, defaultSettings } from '@/lib/pos-settings';
import { getAuthUser } from '@/lib/auth';
import { amountInWords } from '@/lib/number-to-words';

// Customer-facing "Bill" template - modeled directly on a real till
// printout the shop provided (itemized rows with Qty/Price/Amount, an
// optional Service Charge line, Total Sold/Total Return/Total, Bill Total,
// and an "In Words" spelled-out amount). This is an ALTERNATIVE to
// ThermalReceipt.tsx's original cashier layout, not a replacement - see
// ReceiptRenderer.tsx for how a shop picks between them (Settings > Manage
// Receipt > Customer Receipt Template), and pos-settings.ts's
// cashierReceiptTemplate for where the choice is stored. Every field below
// is real order/shop data - nothing here is hardcoded from the reference
// photo.
export default function ItemizedBillReceipt({
  order,
  logoSrc,
  previousDues = 0,
}: {
  order: SavedOrder;
  logoSrc?: string | null;
  previousDues?: number;
}) {
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

  const totalQty = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const scPercent = Number(settings.serviceChargePercent) || 0;
  const scAmount = scPercent > 0 ? Math.round((subtotal * scPercent) / 100) : 0;
  const discountAmount = order.discount?.amount || 0;
  const billTotal = order.total ?? Math.max(subtotal + scAmount - discountAmount, 0);
  const amountTendered = order.paidAmount !== undefined ? Math.min(order.paidAmount, billTotal) : undefined;
  const dueAmount = Math.max(billTotal - (amountTendered ?? billTotal), 0);

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

      {logoSrc ? (
        <div className="flex justify-center mb-1">
          <img src={logoSrc} alt="Print logo" className="max-h-[90px] w-auto max-w-[200px] object-contain" />
        </div>
      ) : null}

      {/* Header */}
      <div className="text-center mb-2">
        <h1 className="text-[16px] leading-[18px] font-bold uppercase mb-0.5">{settings.receiptHeader || 'Store Name'}</h1>
        {settings.receiptSubHeader && <p>{settings.receiptSubHeader}</p>}
        {settings.receiptAddress && <p className="whitespace-pre-line">{settings.receiptAddress}</p>}
        {settings.receiptContact && <p className="font-bold whitespace-pre-line">{settings.receiptContact}</p>}
      </div>

      <h2 className="text-center text-[15px] font-bold uppercase mb-2">Bill</h2>

      <div className="border border-black text-center py-1 mb-2">
        <span className="font-bold uppercase tracking-widest">{order.orderType}</span>
      </div>

      {/* Metadata - two-column rows, DATE: kept as its own line so the
          print-readiness check in PrintOrderPage.tsx/ReceiptPrintPage.tsx
          (which waits for this text to appear before printing) still works
          regardless of which template a shop has picked. */}
      <div className="mb-2 space-y-0.5">
        <div className="flex justify-between"><span>Order#: {orderNumber}</span><span>DATE: {dateString} {timeString}</span></div>
        {order.orderType === 'DineIn' && order.table && <p>Table: {order.table}</p>}
        <p>M/S: {(order.paymentMethod || 'Cash').toUpperCase()}</p>
        {order.waiter && <p>Waiter: {order.waiter}</p>}
        {cashierName && <p>User: {cashierName}</p>}
        {order.customer?.name && order.customer.name !== 'Walk-in Customer' && <p>Customer: {order.customer.name}</p>}
      </div>

      <div className="border-t border-dashed border-black my-1.5" />

      {/* Items */}
      <div>
        <div className="flex justify-between font-bold border-b border-black pb-0.5 mb-1">
          <span className="flex-[3]">Item</span>
          <span className="flex-1 text-right">Qty</span>
          <span className="flex-1 text-right">Price</span>
          <span className="flex-1 text-right">Amount</span>
        </div>
        {order.items.map((item, idx) => (
          <div key={idx} className="mb-1">
            <div className="flex justify-between">
              <span className="flex-[3] pr-1">{item.name}</span>
              <span className="flex-1 text-right">{item.quantity}</span>
              <span className="flex-1 text-right">{item.price.toFixed(0)}</span>
              <span className="flex-1 text-right">{(item.price * item.quantity).toFixed(0)}</span>
            </div>
            {item.variation && <p className="ml-1 text-[10px] text-gray-700 uppercase">- {item.variation}</p>}
          </div>
        ))}
      </div>

      {scAmount > 0 && (
        <div className="flex justify-between mt-1">
          <span>SC {scPercent}%</span>
          <span>{scAmount.toFixed(0)}</span>
        </div>
      )}

      <div className="border-t border-black my-1.5" />

      <div className="space-y-0.5">
        <div className="flex justify-between font-bold">
          <span>Total Sold:</span>
          <span>{totalQty.toFixed(2)}    {subtotal.toFixed(0)}</span>
        </div>
        <div className="flex justify-between">
          <span>Total Return:</span>
          <span>0.00</span>
        </div>
        <div className="border-t border-black my-1" />
        <div className="flex justify-between font-bold">
          <span>Total:</span>
          <span>{totalQty.toFixed(2)}    {(subtotal + scAmount).toFixed(0)}</span>
        </div>
      </div>

      <div className="text-right mt-2">
        <p className="font-bold">Bill Total: {billTotal.toFixed(0)}</p>
      </div>

      {(amountTendered !== undefined || dueAmount > 0 || previousDues > 0) && (
        <div className="mt-2 space-y-0.5">
          {amountTendered !== undefined && <p>Amount Tendered: {amountTendered.toFixed(0)}</p>}
          {dueAmount > 0 && <p>Due: {dueAmount.toFixed(0)}</p>}
          {previousDues > 0 && (
            <>
              <p>Previous Dues: {previousDues.toFixed(0)}</p>
              <p className="font-bold">Total Outstanding: {(billTotal + previousDues).toFixed(0)}</p>
            </>
          )}
        </div>
      )}

      <div className="mt-3">
        <p className="font-bold">In Words:</p>
        <p className="uppercase">{amountInWords(billTotal)}</p>
      </div>

      {/* Footer */}
      <div className="text-center mt-4 mb-2">
        {settings.receiptFooterMessage && <p className="font-bold">{settings.receiptFooterMessage}</p>}
        <p>Haider&apos;s Creation</p>
        <p>0315-0707167</p>
      </div>
    </div>
  );
}
