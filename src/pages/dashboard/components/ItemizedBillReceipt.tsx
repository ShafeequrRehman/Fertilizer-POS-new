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

  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const scPercent = Number(settings.serviceChargePercent) || 0;
  const scAmount = scPercent > 0 ? Math.round((subtotal * scPercent) / 100) : 0;
  const discountAmount = order.discount?.amount || 0;
  const billTotal = order.total ?? Math.max(subtotal + scAmount - discountAmount, 0);
  const amountTendered = order.paidAmount !== undefined ? Math.min(order.paidAmount, billTotal) : undefined;
  const dueAmount = Math.max(billTotal - (amountTendered ?? billTotal), 0);
  // Change-Return Calculation - see ThermalReceipt.tsx's matching comment;
  // same idea here, just laid out to match this template's own style.
  const cashReceived = order.cashReceived || 0;
  const changeReturned = Math.max(cashReceived - billTotal, 0);

  const cashierName = getAuthUser()?.name || getAuthUser()?.username || '';

  // Scoped to this one shop only, per an explicit request not to change
  // anything for other shops on the same shared codebase - see
  // KitchenKotReceipt.tsx's matching comment for why left-flush instead of
  // centered, and pos-settings.ts's comment on loginUsername/shopName for
  // why those fields (not businessEmail) are what's checked.
  const shopHaystack = `${settings.loginUsername || ''} ${settings.shopName || ''} ${settings.businessEmail || ''}`.toLowerCase();
  const isHeavenSlice = shopHaystack.includes('heavenslice') || shopHaystack.includes('heaven slice');
  const receiptMargin = isHeavenSlice ? '0 8mm 0 2mm' : '0 auto';

  return (
    <div className="thermal-receipt w-[70mm] max-w-[70mm] bg-white text-black font-mono text-[12px] leading-[15px] pb-2">
      {/* Content is 70mm inside an 80mm page (5mm margin each side, not the
          old 4mm) - a real shop printout (see the "misprints from right
          side" report against this exact template) showed the rightmost
          digit of bold
          right-aligned totals getting clipped on the physical paper, even
          though on-screen/PDF preview looked fine. Bold text in a
          monospace webfont commonly renders a touch wider per character
          than regular weight (synthetic/faux-bold glyph widening), which is
          invisible with room to overflow into (a screen, a PDF) but fatal
          on a thermal printer that hard-cuts at its physical paper edge
          with zero tolerance. Widening the margin gives that extra bold
          width somewhere to go without reaching the edge. */}
      <style dangerouslySetInnerHTML={{ __html: `
        .thermal-receipt { box-sizing: border-box; color: #000; overflow: visible; padding-top: 0; }
        .thermal-receipt * { box-sizing: border-box; }
        @media print {
          @page { margin: 0; size: 80mm auto; }
          html, body { width: 80mm; margin: 0; padding: 0; background: #fff; }
          .thermal-receipt { width: 70mm !important; max-width: 70mm !important; margin: ${receiptMargin} !important; }
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
      <div className="mt-3 mb-3 space-y-2">
        <div className="flex justify-between"><span>Order#: {orderNumber}</span><span>DATE: {dateString} {timeString}</span></div>
        {order.orderType === 'DineIn' && order.table && <p>Table: {order.table}</p>}
        <p>M/S: {(order.paymentMethod || 'Cash').toUpperCase()}</p>
        {order.waiter && <p>Waiter: {order.waiter}</p>}
        {cashierName && <p>User: {cashierName}</p>}
        {order.customer?.name && order.customer.name !== 'Walk-in Customer' && <p>Customer: {order.customer.name}</p>}
        {/* Phone stays gated on a real (non-Walk-in) name - validateOrderForm
            in POSPage.tsx never lets a phone through without a name
            alongside it, so this is always consistent - plus the walk-in
            placeholder phone (03000000000) is excluded since it was never a
            real number the customer gave. Address is DELIBERATELY NOT gated
            on name: a Delivery order can be placed with an address but no
            typed name (both are optional now), and the address is exactly
            what the delivery needs - it must still print even then. */}
        {order.customer?.name && order.customer.name !== 'Walk-in Customer' && order.customer.phone && order.customer.phone !== '03000000000' && <p>Phone: {order.customer.phone}</p>}
        {order.customer?.address && <p>Address: {order.customer.address}</p>}
        {/* Electricity Bill / Cash special-product details - only ever set
            on an order whose cart had the matching special item in it (see
            POSPage.tsx's hasElectricityBillItem/hasCashItem). */}
        {order.billTid && <p>TID: {order.billTid}</p>}
        {order.billName && <p>Bill Name: {order.billName}</p>}
        {order.cashRecipientName && <p>Cash Given To: {order.cashRecipientName}</p>}
      </div>

      <div className="border-t border-dashed border-black my-1.5" />

      {/* Items */}
      <div>
        <div className="flex justify-between font-bold border-b border-black pb-0.5 mb-1">
          <span className="flex-[3]">Item</span>
          <span className="flex-1 text-right">Qty</span>
          <span className="flex-1 text-right">Price</span>
          <span className="flex-1 text-right pr-[1mm]">Amount</span>
        </div>
        {order.items.map((item, idx) => (
          <div key={idx} className="mb-1">
            <div className="flex justify-between">
              <span className="flex-[3] pr-1">{item.name}</span>
              <span className="flex-1 text-right">{item.quantity}</span>
              <span className="flex-1 text-right">{item.price.toFixed(0)}</span>
              <span className="flex-1 text-right pr-[1mm]">{(item.price * item.quantity).toFixed(0)}</span>
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

      {/* Two-column flex rows, value in its own non-bold span with a small
          right-inset - matches the item table's Amount column (which never
          clipped on the real printout) instead of a single bold string
          forced flush against the container's right edge (which did). The
          label alone carries the bold emphasis now; the bolded VALUE was
          the actual thing getting clipped before. */}
      <div className="flex justify-between font-bold">
        <span>Total:</span>
        <span className="pr-[1mm]">{(subtotal + scAmount).toFixed(0)}</span>
      </div>

      {/* discountAmount was already being computed above (as a fallback for
          billTotal when order.total was missing) but never actually shown
          on the printout - the customer had no way to see a discount was
          applied at all, only a smaller final number. */}
      {discountAmount > 0 && (
        <div className="flex justify-between">
          <span>Discount {order.discount?.type === 'percent' ? `(${order.discount.value}% - Percentage)` : '(Fixed Value)'}:</span>
          <span className="pr-[1mm]">-{discountAmount.toFixed(0)}</span>
        </div>
      )}

      <div className="flex justify-between font-bold mt-2">
        <span>Bill Total:</span>
        <span className="pr-[1mm]">{billTotal.toFixed(0)}</span>
      </div>

      {(amountTendered !== undefined || cashReceived > 0 || dueAmount > 0 || previousDues > 0) && (
        <div className="mt-2 space-y-0.5">
          {/* Change-Return Calculation: the exact Total Bill / Cash
              Tendered-Received / Change Returned rows, same as a standard
              supermarket/fast-food till receipt - only when a real cash-
              tendered figure was actually recorded (see SalesPage.tsx's
              Complete Payment modal). Falls back to the original single
              "Amount Tendered" line for anything else (card/e-wallet, or
              an older order saved before this feature existed). */}
          {cashReceived > 0 ? (
            <>
              <div className="flex justify-between font-bold">
                <span>Total Bill:</span>
                <span className="pr-[1mm]">{billTotal.toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span>Cash Tendered/Received:</span>
                <span className="pr-[1mm]">{cashReceived.toFixed(0)}</span>
              </div>
              <div className="flex justify-between font-bold">
                <span>Change Returned:</span>
                <span className="pr-[1mm]">{changeReturned.toFixed(0)}</span>
              </div>
            </>
          ) : (
            amountTendered !== undefined && <p>Amount Tendered: {amountTendered.toFixed(0)}</p>
          )}
          {dueAmount > 0 && <p>Due: {dueAmount.toFixed(0)}</p>}
          {previousDues > 0 && (
            // Full arrears breakdown - only for a customer who actually
            // has previous dues (see this component's own doc comment on
            // `previousDues`); a customer with none never sees any of
            // this, everything else on the receipt stays exactly as it
            // was.
            <>
              <p>Arrears: {previousDues.toFixed(0)}</p>
              <div className="flex justify-between">
                <span>Arrears+Inv Balance:</span>
                <span className="pr-[1mm]">{(previousDues + billTotal).toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span>Invoice Balance:</span>
                <span className="pr-[1mm]">{dueAmount.toFixed(0)}</span>
              </div>
              <div className="flex justify-between font-bold">
                <span>Account Balance:</span>
                <span className="pr-[1mm]">{(previousDues + dueAmount).toFixed(0)}</span>
              </div>
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
        <p>Shafeeq Developer&apos;s Creation</p>
        <p>03400-586000</p>
      </div>
    </div>
  );
}
