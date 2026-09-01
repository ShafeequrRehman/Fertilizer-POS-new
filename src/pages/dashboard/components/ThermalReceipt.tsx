import React, { useEffect, useState } from 'react';
import { SavedOrder } from '@/lib/pos-types';
import { getStoreSettings, defaultSettings } from '@/lib/pos-settings';

export default function ThermalReceipt({
  order,
  type,
  logoSrc,
  previousDues = 0,
}: {
  order: SavedOrder;
  type: 'kitchen' | 'cashier';
  logoSrc?: string | null;
  // Dues carried forward from the customer's OTHER unpaid orders, not this
  // one - passed in by whoever renders this receipt (see PrintOrderPage.tsx
  // / ReceiptPrintPage.tsx, which fetch it via fetchCustomerOutstanding).
  previousDues?: number;
}) {
  const [settings, setSettings] = useState(defaultSettings);
  useEffect(() => {
    setSettings(getStoreSettings());
  }, []);

  const itemsTotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  // order.total is the real, backend-computed total - once a discount has
  // been applied (see SalesPage.tsx's completeOrder) that's already
  // subtracted out of it, unlike itemsTotal above which is always the raw,
  // pre-discount sum of the item lines. Falling back to itemsTotal only
  // covers an order printed before order.total was ever set (shouldn't
  // happen for a completed order, but matches ItemizedBillReceipt.tsx's
  // same defensive fallback).
  const billTotal = order.total ?? itemsTotal;
  const discountAmount = order.discount?.amount || 0;
  const amountTendered = order.paidAmount !== undefined ? Math.min(order.paidAmount, billTotal) : undefined;
  const dueAmount = Math.max(billTotal - (amountTendered ?? 0), 0);
  const date = order.createdAt ? new Date(order.createdAt) : null;
  const dateString = date
    ? date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
    : '--';
  const timeString = date
    ? date.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--';
  const orderNumber = String(order.dailyOrderNumber ?? order.id.slice(-3)).padStart(3, '0');

  // Scoped to this one shop only, per an explicit request not to change
  // anything for other shops - see KitchenKotReceipt.tsx's matching
  // comment for why left-flush instead of centered. Checks
  // loginUsername/shopName, not businessEmail - see pos-settings.ts's
  // comment on those fields for why.
  const shopHaystack = `${settings.loginUsername || ''} ${settings.shopName || ''} ${settings.businessEmail || ''}`.toLowerCase();
  const isHeavenSlice = shopHaystack.includes('heavenslice') || shopHaystack.includes('heaven slice');
  const receiptMargin = isHeavenSlice ? '0 8mm 0 2mm' : '0 auto';

  return (
    <div className="thermal-receipt w-[70mm] max-w-[70mm] bg-white text-black font-mono text-[12px] leading-[14px] pb-2">
      {/* 70mm content inside an 80mm page (5mm margin each side) - widened
          from the old 72mm/4mm to leave headroom for bold text rendering a
          touch wider than regular weight (synthetic bold glyph widening),
          which was clipping the rightmost digit of bold right-aligned
          totals on a real thermal printout even though it looked fine
          on-screen. See ItemizedBillReceipt.tsx's matching comment. */}
      <style dangerouslySetInnerHTML={{ __html: `
        .thermal-receipt {
          box-sizing: border-box;
          color: #000;
          overflow: visible;
          padding-top: 0;
        }

        .thermal-receipt * {
          box-sizing: border-box;
        }

        @media print {
          @page { margin: 0; size: 80mm auto; }
          html, body {
            width: 80mm;
            margin: 0;
            padding: 0;
            background: #fff;
          }

          .thermal-receipt {
            width: 70mm !important;
            max-width: 70mm !important;
            margin: ${receiptMargin} !important;
          }
        }
      ` }} />
      {type === 'cashier' && logoSrc ? (
        <div className="flex justify-center">
          <img
            src={logoSrc}
            alt="Print logo"
            className="max-h-[100px] w-auto max-w-[220px] object-contain"
          />
        </div>
      ) : null}

      {/* Header */}
      <div className="text-center mb-2">
        <h1 className="text-[18px] leading-[20px] font-bold uppercase mb-[5px]">{settings.receiptHeader || 'Store Name'}</h1>
        {settings.receiptSubHeader && <p>{settings.receiptSubHeader}</p>}
        {settings.receiptAddress && <p>{settings.receiptAddress}</p>}
        {settings.receiptContact && <p>{settings.receiptContact}</p>}
        {settings.receiptPaymentInfo && <p>{settings.receiptPaymentInfo}</p>}
      </div>

      {/* Order Block - the giant number matters most on the customer-facing
          cashier receipt; the kitchen ticket renders it smaller since staff
          there care more about the item list than a huge number. */}
      <div className="border-y-4 border-black py-2 my-2 text-center">
        <h2 className="text-[16px] font-bold uppercase mb-0.5">Order No.</h2>
        <h2 className={`font-black uppercase tracking-normal ${type === 'kitchen' ? 'text-[40px] leading-[40px]' : 'text-[68px] leading-[68px]'}`}>
          {orderNumber}
        </h2>
        {type === 'kitchen' && <p className="text-sm font-bold uppercase mt-2">*** KITCHEN TICKET ***</p>}
      </div>

      {/* Metadata */}
      <div className="mb-2">
        <p>DATE: {dateString}</p>
        <p>TIME: {timeString}</p>
        <p>TYPE: {order.orderType.toUpperCase()}</p>
        {order.customer && order.customer.name && order.customer.name !== 'Walk-in Customer' && (
          <p>CUSTOMER: {order.customer.name.toUpperCase()}</p>
        )}
        {/* Phone/address only belong on the customer's own copy, not the
            kitchen ticket. Phone stays gated on a real (non-Walk-in) name -
            validateOrderForm in POSPage.tsx never lets a phone through
            without a name alongside it, so this is always consistent - plus
            the walk-in placeholder phone (03000000000) is excluded since it
            was never a real number the customer gave. Address is
            DELIBERATELY NOT gated on name being present: a Delivery order
            can be placed with an address but no typed name (name/phone are
            optional there too), and the address is exactly the information
            the delivery needs - it must still print even then. */}
        {type === 'cashier' && order.customer && order.customer.name && order.customer.name !== 'Walk-in Customer' && order.customer.phone && order.customer.phone !== '03000000000' && (
          <p>PHONE: {order.customer.phone}</p>
        )}
        {type === 'cashier' && order.customer?.address && (
          <p>ADDRESS: {order.customer.address}</p>
        )}
      </div>

      {/* Dashed Separator */}
      <div className="border-t border-dashed border-black my-2" />

      {/* Items */}
      <div className="mb-2">
        <p>Items:</p>
        {order.items.map((item, idx) => {
          const itemTotal = (item.price * item.quantity).toFixed(2);
          const priceLine = type === 'cashier' ? `@ Rs ${item.price.toFixed(2)}` : '';
          
          return (
            <div key={idx} className="mb-1">
              <div className="flex justify-between items-start">
                <span className="flex-1 pr-1">{item.quantity}x {item.name.toUpperCase()} {priceLine}</span>
                {type === 'cashier' && <span className="text-right pr-[1mm] shrink-0">Rs {itemTotal}</span>}
              </div>
              {item.variation && <p className="ml-4 text-[10px] text-gray-700 uppercase">- {item.variation}</p>}
            </div>
          );
        })}
      </div>

      {/* Dashed Separator */}
      <div className="border-t border-dashed border-black my-2" />

      {/* Financials (Cashier Only) */}
      {type === 'cashier' && (
        <div className="mb-2">
          <div className="flex justify-between">
            <span>Items Total:</span>
            <span>Rs {itemsTotal.toFixed(2)}</span>
          </div>
          {/* This used to print itemsTotal again here too, meaning a
              discount never showed up anywhere on this receipt - the
              customer just saw the same figure twice with no explanation
              for why it was less than the item lines added up to. */}
          {discountAmount > 0 && (
            <div className="flex justify-between">
              <span>Discount {order.discount?.type === 'percent' ? `(${order.discount.value}% - Percentage)` : '(Fixed Value)'}:</span>
              <span>-Rs {discountAmount.toFixed(2)}</span>
            </div>
          )}
          <div className="flex justify-between gap-2 font-bold text-[13px] mt-1">
            <span>TOTAL:</span>
            <span className="shrink-0 pr-[1mm]">Rs {billTotal.toFixed(2)}</span>
          </div>

          <div className="mt-3">
            <p>PAID: {order.paymentMethod?.toUpperCase() || 'CASH'}</p>
            {amountTendered !== undefined && (
              <p>AMOUNT TENDERED: Rs {amountTendered.toFixed(2)}</p>
            )}
            {dueAmount > 0 && (
              <p>DUE: Rs {dueAmount.toFixed(2)}</p>
            )}
            {previousDues > 0 && (
              // Full arrears breakdown - only for a customer who actually
              // has previous dues (see this component's own doc comment
              // on `previousDues`); a customer with none never sees any
              // of this, everything else on the receipt stays exactly as
              // it was.
              <>
                <p className="mt-1">ARREARS: Rs {previousDues.toFixed(2)}</p>
                <div className="flex justify-between">
                  <span>ARREARS+INV BALANCE:</span>
                  <span className="pr-[1mm]">Rs {(previousDues + billTotal).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>INVOICE BALANCE:</span>
                  <span className="pr-[1mm]">Rs {dueAmount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-bold">
                  <span>ACCOUNT BALANCE:</span>
                  <span className="pr-[1mm]">Rs {(previousDues + dueAmount).toFixed(2)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="text-center mt-5 mb-2">
        {settings.receiptFooterMessage && <p className="font-bold">{settings.receiptFooterMessage}</p>}
        <p>Haider&apos;s Creation</p>
        <p>0315-0707167</p>
        
        {/* QR Code - Only for Cashier Receipt */}
        {/* {type !== 'kitchen' && (
          <div className="w-[100px] h-[100px] mx-auto border-4 border-black p-1 mt-3">
            <div className="w-full h-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-black via-black to-white opacity-90" style={{ backgroundImage: 'repeating-linear-gradient(45deg, black 25%, transparent 25%, transparent 75%, black 75%, black), repeating-linear-gradient(45deg, black 25%, white 25%, white 75%, black 75%, black)', backgroundPosition: '0 0, 4px 4px', backgroundSize: '8px 8px' }} />
          </div>
        )} */}
      </div>
    </div>
  );
}
