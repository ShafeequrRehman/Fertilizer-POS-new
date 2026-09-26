// Shared "print an order receipt straight into a plain window" builder -
// used by DuesPage.tsx's History "Print" button and RecordPage.tsx's row
// Print icon, so reprinting an old order's slip doesn't have to navigate
// to the full in-app Manual Print Center page (PrintOrderPage.tsx) in a
// brand new tab. That route works, but a fresh tab means the WHOLE app
// boots from scratch in it first (Redux store, auth, HashRouter, the
// "Starting POS System" splash) before the receipt itself ever renders -
// slow, and not what "click Print, get a slip" should feel like. This
// builds the same information directly as one plain HTML document
// (same document.write + window.print() technique already proven for the
// Dues Entry/Purchase receipts), so the print happens the instant the
// order's own data has loaded - no app boot involved.
//
// This is deliberately NOT a pixel-identical copy of ThermalReceipt.tsx
// (the POS's own live receipt component) - it's a simpler, static render
// of the same underlying fields for the "reprint an old order later"
// case, not the primary at-checkout receipt path (which keeps using
// ThermalReceipt/PrintOrderPage as before, unchanged).
import { SavedOrder } from '@/lib/pos-types';
import { getStoreSettings } from '@/lib/pos-settings';

// Same shop-header/bordered-title-block/footer shell DuesPage.tsx's own
// Dues Entry and Purchase receipts use (buildReceiptHtml there) - kept
// here too so an order receipt printed from either page looks like it
// belongs to the same till. `titleSub`, when given, renders as a large
// bold line under the title (e.g. the order number) - the same "ORDER
// NO. / 018" look the live Complete Order receipt already uses.
export function buildReceiptShellHtml(title: string, bodyHtml: string, titleSub?: string) {
  const settings = getStoreSettings();
  return `<!DOCTYPE html><html><head><title>${title}</title>
    <style>
      @page { margin: 0; }
      html, body { width: 80mm; margin: 0; padding: 0; height: auto; min-height: 0; background: #fff; }
      .receipt { width: 70mm; margin: 0 auto; padding: 6px 8px 12px; box-sizing: border-box; font-family: 'Courier New', Courier, monospace; color: #000; font-size: 12px; line-height: 15px; }
      .receipt * { box-sizing: border-box; }
      .center { text-align: center; }
      .shop-name { font-size: 18px; line-height: 20px; font-weight: 800; text-transform: uppercase; margin: 0 0 5px; }
      .title-block { border-top: 4px solid #000; border-bottom: 4px solid #000; padding: 8px 0; margin: 10px 0; text-align: center; }
      .title-block h2 { font-size: 16px; font-weight: 800; text-transform: uppercase; margin: 0; }
      .title-block .title-sub { font-size: 40px; line-height: 40px; font-weight: 900; margin-top: 4px; }
      .dashed { border-top: 1px dashed #000; margin: 8px 0; }
      .row { display: flex; justify-content: space-between; gap: 6px; }
      .row.bold { font-weight: 800; font-size: 13px; }
      p { margin: 2px 0; }
    </style>
    </head><body>
    <div class="receipt">
      <div class="center">
        <p class="shop-name">${settings.receiptHeader || 'Store Name'}</p>
        ${settings.receiptSubHeader ? `<p>${settings.receiptSubHeader}</p>` : ''}
        ${settings.receiptAddress ? `<p>${settings.receiptAddress}</p>` : ''}
        ${settings.receiptContact ? `<p>${settings.receiptContact}</p>` : ''}
        ${settings.receiptPaymentInfo ? `<p>${settings.receiptPaymentInfo}</p>` : ''}
      </div>
      <div class="title-block"><h2>${title}</h2>${titleSub ? `<div class="title-sub">${titleSub}</div>` : ''}</div>
      ${bodyHtml}
      <div class="center" style="margin-top:16px">
        ${settings.receiptFooterMessage ? `<p style="font-weight:800">${settings.receiptFooterMessage}</p>` : ''}
        <p>Shafeeq Developer&apos;s Creation</p>
        <p>03400-586000</p>
      </div>
    </div>
    </body></html>`;
}

// Same field set/order as ThermalReceipt.tsx's cashier copy (items,
// discount, total, paid/tendered/change, due, arrears) - see that
// component's own comments for why each one is computed the way it is;
// this mirrors it rather than re-deriving its own rules.
function buildOrderReceiptBodyHtml(order: SavedOrder, previousDues: number) {
  const itemsTotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const billTotal = order.total ?? itemsTotal;
  const discountAmount = order.discount?.amount || 0;
  const amountTendered = order.paidAmount !== undefined ? Math.min(order.paidAmount, billTotal) : undefined;
  const dueAmount = Math.max(billTotal - (amountTendered ?? 0), 0);
  const cashReceived = order.cashReceived || 0;
  const changeReturned = Math.max(cashReceived - billTotal, 0);
  const date = order.createdAt ? new Date(order.createdAt) : null;
  const dateString = date ? date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase() : '--';
  const timeString = date ? date.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--';

  const itemRows = order.items.map((item) => {
    const itemTotal = (item.price * item.quantity).toFixed(2);
    return `
      <div class="row"><span>${item.quantity}x ${item.name.toUpperCase()} @ Rs ${item.price.toFixed(2)}</span><span>Rs ${itemTotal}</span></div>
      ${item.variation ? `<p style="margin-left:12px;font-size:10px;color:#444">- ${item.variation}</p>` : ''}
    `;
  }).join('');

  const hasRealCustomer = order.customer && order.customer.name && order.customer.name !== 'Walk-in Customer';
  const hasRealPhone = hasRealCustomer && order.customer.phone && order.customer.phone !== '03000000000';

  return `
    <p>DATE: ${dateString}</p>
    <p>TIME: ${timeString}</p>
    <p>TYPE: ${order.orderType.toUpperCase()}</p>
    ${hasRealCustomer ? `<p>CUSTOMER: ${order.customer.name.toUpperCase()}</p>` : ''}
    ${hasRealPhone ? `<p>PHONE: ${order.customer.phone}</p>` : ''}
    ${order.customer?.address ? `<p>ADDRESS: ${order.customer.address}</p>` : ''}
    ${order.billTid ? `<p>TID: ${order.billTid}</p>` : ''}
    ${order.billName ? `<p>BILL NAME: ${order.billName}</p>` : ''}
    ${order.cashRecipientName ? `<p>CASH GIVEN TO: ${order.cashRecipientName}</p>` : ''}
    <div class="dashed"></div>
    <p>Items:</p>
    ${itemRows}
    <div class="dashed"></div>
    <div class="row"><span>Items Total:</span><span>Rs ${itemsTotal.toFixed(2)}</span></div>
    ${discountAmount > 0 ? `<div class="row"><span>Discount:</span><span>-Rs ${discountAmount.toFixed(2)}</span></div>` : ''}
    <div class="row bold"><span>TOTAL:</span><span>Rs ${billTotal.toFixed(2)}</span></div>
    <p style="margin-top:8px">PAID: ${(order.paymentMethod || 'CASH').toUpperCase()}</p>
    ${cashReceived > 0 ? `
      <div class="row bold"><span>TOTAL BILL:</span><span>Rs ${billTotal.toFixed(2)}</span></div>
      <div class="row"><span>CASH TENDERED/RECEIVED:</span><span>Rs ${cashReceived.toFixed(2)}</span></div>
      <div class="row bold"><span>CHANGE RETURNED:</span><span>Rs ${changeReturned.toFixed(2)}</span></div>
    ` : amountTendered !== undefined ? `<p>AMOUNT TENDERED: Rs ${amountTendered.toFixed(2)}</p>` : ''}
    ${dueAmount > 0 ? `<p>DUE (THIS ORDER): Rs ${dueAmount.toFixed(2)}</p>` : ''}
    ${previousDues !== 0 ? `<p>OTHER DUES/ADVANCE: Rs ${previousDues.toFixed(2)}</p>` : ''}
    <div class="dashed"></div>
    ${(() => {
      // Same Due (customer owes the shop)/Advance (shop owes the
      // customer) convention DuesPage.tsx's own Dues Entry slip and Net
      // Outstanding Balance label use - this is the customer's WHOLE
      // account balance (this order's own remaining PLUS whatever they
      // separately owe/are owed), not just this one order, so a cashier
      // reprinting an old receipt sees the same "how do we stand overall"
      // figure the Dues Entry slip already gives.
      const overallBalance = previousDues + dueAmount;
      const label = overallBalance > 0
        ? `Due: Rs ${overallBalance.toFixed(2)}`
        : overallBalance < 0
          ? `Advance: Rs ${Math.abs(overallBalance).toFixed(2)}`
          : 'Settled';
      return `<div class="row bold"><span>ACCOUNT BALANCE:</span><span>${label}</span></div>`;
    })()}
  `;
}

// Writes a full order receipt into an already-open window and prints it.
// Callers open the window THEMSELVES, synchronously at click time (see
// each call site's own comment) so the popup blocker never gets a chance
// to kill it while the order/previousDues data is still being fetched.
export function writeOrderReceiptToWindow(printWindow: Window, order: SavedOrder, previousDues: number) {
  const orderNumber = String(order.dailyOrderNumber ?? order.id.slice(-3)).padStart(3, '0');
  const bodyHtml = buildOrderReceiptBodyHtml(order, previousDues);
  printWindow.document.open();
  printWindow.document.write(buildReceiptShellHtml('Order No.', bodyHtml, orderNumber));
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}
