import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, PackagePlus, Phone, Printer, RefreshCcw, Search, ShoppingBag, UserRound, XCircle } from 'lucide-react';
import { ApiError, claimKitchenUpdatePrint, claimReceiptPrint, fetchCustomerOutstanding, fetchOrder, fetchOrders, fetchProducts, fetchShopSessionHistory, isAuthenticated, updateOrder, sendWhatsappMessage, sendWhatsappDocument } from '@/lib/pos-api';
import { Discount, Product, SavedOrder, ShopSession } from '@/lib/pos-types';
import { StoreSettings, getStoreSettings } from '@/lib/pos-settings';
import { hasPermission } from '@/lib/auth';
import { getBusinessWindow, filterOrdersInBusinessWindow } from '@/lib/shop-session';
import AddItemsManager from '@/pages/dashboard/sales/components/AddItemsManager';
import CancelOrderModal from '@/components/CancelOrderModal';

const filters = ['All', 'Dine In', 'Take Away', 'Delivery', 'Fariha', 'Ahsan Raza', 'Rehman', 'Rehan'];

type ElectronWindow = Window & typeof globalThis & {
  require?: (moduleName: 'electron') => {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  };
};

type ReceiptPdfResult = {
  success: boolean;
  pdfPath?: string;
  fileBase64?: string;
  error?: string;
};

function isReceiptPdfResult(value: unknown): value is ReceiptPdfResult {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

export default function SalesPage() {
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<SavedOrder | null>(null);
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPayment, setShowPayment] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showAddItems, setShowAddItems] = useState(false);
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [shopSession, setShopSession] = useState<ShopSession | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  // Discount now lives here, not in POS checkout - the cashier applies it
  // when actually completing/collecting payment on an order, using either a
  // flat PKR amount or a percent of the subtotal (Amount wins if both are
  // filled). Cleared every time the Complete Payment modal is opened so it
  // never bleeds from one order into the next.
  const [discountAmountInput, setDiscountAmountInput] = useState('');
  const [discountPercentInput, setDiscountPercentInput] = useState('');
  const [customerDue, setCustomerDue] = useState(0);
  const [printReadyUrl, setPrintReadyUrl] = useState<string | null>(null);
  const [isSendingWA, setIsSendingWA] = useState(false);
  // Order list shows 10, "Load More" grows it by 10 - same pattern as
  // Record/Ledger/Dues.
  const [visibleOrderCount, setVisibleOrderCount] = useState(10);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const storeSettings = getStoreSettings();
        setSettings(storeSettings);

        // We use refresh to populate orders and set state seamlessly
        await refresh();
        const productData = await fetchProducts();
        if (productData) {
          setProducts(productData.products);
        }
      } catch (error) {
        setStatus({ tone: 'error', text: error instanceof Error ? error.message : 'Failed to load sales data.' });
      } finally {
        setLoading(false);
      }
    }
    if (!isAuthenticated()) setStatus({ tone: 'info', text: 'Login token not found. Sales updates will not sync to MongoDB until you log in again.' });
    void load();
    // Shop status can change (someone closes the shop) while this page is
    // sitting open, so the shift window is kept in sync the same way
    // RecordPage.tsx and the Dashboard do.
    const intervalId = setInterval(() => void refresh(), 45000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A customer can have more than one order open at once now, so "Previous
  // Dues" here means the customer's TRUE outstanding balance - every other
  // non-cancelled order's unpaid amount, plus the older previousDues
  // lump-sum - not just that old lump-sum on its own. This is what makes an
  // earlier pending bill actually show up as part of the current one.
  useEffect(() => {
    async function loadDue() {
      if (!selectedOrder?.customer.phone || selectedOrder.customer.phone === '03000000000') return setCustomerDue(0);
      try {
        const result = await fetchCustomerOutstanding(selectedOrder.customer.phone, selectedOrder.id);
        setCustomerDue(Number(result?.outstanding ?? 0));
      } catch {
        setCustomerDue(0);
      }
    }
    void loadDue();
  }, [selectedOrder]);

  // "Today" here is exactly the current/most recent shop shift - same
  // definition used on the Dashboard and Record page - not a fixed
  // calendar date. While a shift is open the window is [openedAt, now)
  // and keeps growing across midnight instead of splitting into two
  // separate "days"; once closed it freezes at [openedAt, closedAt).
  const sessionWindow = useMemo(() => getBusinessWindow(shopSession, new Date()), [shopSession]);

  const shiftOrders = useMemo(
    () => filterOrdersInBusinessWindow(orders, sessionWindow),
    [orders, sessionWindow],
  );

  const visibleOrders = useMemo(() => shiftOrders.filter((order) => {
    const byFilter = filter === 'All'
      || (filter === 'Dine In' && order.orderType === 'DineIn')
      || (filter === 'Take Away' && order.orderType === 'TakeAway')
      || (filter === 'Delivery' && order.orderType === 'Delivery')
      || order.waiter === filter;
    const haystack = `${order.id} ${order.dailyOrderNumber ?? ''} ${label(order)} ${phoneLabel(order)}`.toLowerCase();
    return byFilter && haystack.includes(search.toLowerCase());
  }), [filter, shiftOrders, search]);

  // A new filter/search re-derives the whole list, so a stale "load more"
  // position would otherwise leave the grid showing an arbitrary/
  // inconsistent slice - always restart at 10 when they change.
  useEffect(() => {
    setVisibleOrderCount(10);
  }, [filter, search, shiftOrders]);

  const pagedOrders = visibleOrders.slice(0, visibleOrderCount);

  const orderSubtotal = selectedOrder?.subtotal ?? selectedOrder?.total ?? 0;
  const orderTax = selectedOrder?.tax ?? 0;
  const discountAmountValue = Number(discountAmountInput) || 0;
  const discountPercentValue = Number(discountPercentInput) || 0;
  const discountType: Discount['type'] = discountAmountValue > 0 ? 'value' : 'percent';
  const discountRawValue = discountAmountValue > 0 ? discountAmountValue : discountPercentValue;
  const discountAmount = discountRawValue > 0 && orderSubtotal > 0
    ? Math.min(discountType === 'percent' ? Math.round((orderSubtotal * discountRawValue) / 100) : Math.round(discountRawValue), orderSubtotal)
    : 0;
  const discountForOrder: Discount | null = discountAmount > 0 ? { type: discountType, value: discountRawValue, amount: discountAmount } : null;
  const adjustedTotal = Math.max(orderSubtotal + orderTax - discountAmount, 0);
  const payable = adjustedTotal + customerDue;

  async function refresh() {
    try {
      const [data, history] = await Promise.all([fetchOrders(), fetchShopSessionHistory()]);
      const latestSession = history && history.length > 0 ? history[0] : null;
      setShopSession(latestSession);

      if (data) {
        setOrders(data);

        // Default selection should come from THIS shift's orders, not just
        // "the newest order overall" - otherwise the very first thing shown
        // on load could be a stale order from a previous shift that isn't
        // even in the visible list below it. A selection the user already
        // made is left alone as long as the order still exists at all.
        const scoped = filterOrdersInBusinessWindow(data, getBusinessWindow(latestSession, new Date()));

        setSelectedOrder((current) => current ? data.find((order) => order.id === current.id) ?? scoped[0] ?? null : scoped[0] ?? null);
      }
    } catch (err) {
      console.error('Failed to load orders', err);
      // Let's not wipe out the current orders if it's just a transient error,
      // but we could setStatus here. For now, just catch it safely.
    }
  }

  async function refreshProducts() {
    const productData = await fetchProducts();
    setProducts(productData.products);
  }

  async function refreshOne(id: string) {
    const updated = await fetchOrder(id);
    setOrders((previous) => previous.map((order) => order.id === id ? updated : order));
    setSelectedOrder(updated);
  }

  async function saveUpdate(payload: Parameters<typeof updateOrder>[1]) {
    if (!selectedOrder) return null;
    const updated = await updateOrder(selectedOrder.id, payload);
    setOrders((previous) => previous.map((order) => order.id === updated.id ? updated : order));
    setSelectedOrder(updated);

    // Fire only the receipt that belongs to this workflow.
    const targetPrintType = payload.status === 'completed'
      ? 'cashier'
      : payload.action === 'addItems'
        ? 'kitchen'
        : null;

    if (!targetPrintType) {
      return updated;
    }

    // Claim-before-print, same invariant used everywhere else a receipt or
    // kitchen ticket gets auto-printed (see POSPage.tsx / DashboardShell.tsx's
    // watchers). This is what makes completing an order - or adding items
    // to one - from the mobile app work the same as doing it here: the
    // phone has no printer of its own, so DashboardShell's watchers poll
    // for completed/updated, unclaimed orders and print them on this till -
    // and this claim is what stops BOTH a watcher and this same tick here
    // from printing two copies when the till itself makes the edit. A
    // TakeAway order that already printed its receipt at placement will
    // simply fail the cashier claim (409) and print nothing a second time.
    let receiptOrder = updated;
    let kitchenUpdateItems: SavedOrder['items'] | null = null;

    if (targetPrintType === 'cashier') {
      try {
        receiptOrder = await claimReceiptPrint(updated.id);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) {
          console.error('Receipt print claim failed:', err);
        }
        // Either already printed elsewhere, or the claim itself failed - in
        // either case DashboardShell's ReceiptPrintWatcher will pick this
        // order up and print it within a few seconds anyway, so there is
        // no local fallback here (avoids risking a duplicate).
        return updated;
      }
    } else {
      try {
        const claimed = await claimKitchenUpdatePrint(updated.id);
        if (!claimed || claimed.items.length === 0) return updated;
        kitchenUpdateItems = claimed.items;
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) {
          console.error('Kitchen update claim failed:', err);
        }
        // Same reasoning as the cashier branch - DashboardShell's
        // KitchenUpdateWatcher is the safety net, no local fallback here.
        return updated;
      }
    }

    // Browser/no-printer fallback goes through PrintOrderPage.tsx, which
    // fetches the order fresh (full merged item list) - so for an
    // addItems kitchen ticket, stash just the claimed new items here for
    // that page to pick up, same reasoning as kitchenReceiptData below.
    function printPageUrl(type: 'kitchen' | 'cashier') {
      if (type === 'kitchen' && kitchenUpdateItems) {
        try {
          sessionStorage.setItem(`kitchen-add-items-${updated.id}`, JSON.stringify(kitchenUpdateItems));
        } catch {
          // sessionStorage unavailable - the fallback page will just show
          // the full item list instead, which is an acceptable degradation.
        }
      }
      return `/dashboard/sales/print/${updated.id}?auto=true&type=${type}`;
    }

    const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
    if (isElectron && settings) {
      try {
        const electronRequire = (window as ElectronWindow).require;
        const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
        if (!ipcRenderer) throw new Error('Electron IPC is unavailable.');

        const printLogo = localStorage.getItem('preferred-print-logo');
        // customerDue is whatever "Previous Dues" was showing in the
        // Complete Payment panel for this order - carried onto the printed
        // receipt so the customer sees the same combined total they were
        // actually charged.
        // Only the claimed delta ever goes to the kitchen - reprinting the
        // whole order's items would have the kitchen re-cook stuff they
        // already started (or finished) on the original ticket.
        const kitchenReceiptData = { ...updated, items: kitchenUpdateItems || [] };
        const receiptData = targetPrintType === 'cashier' ? { ...receiptOrder, previousDues: customerDue } : kitchenReceiptData;

        if (targetPrintType === 'cashier' && settings.counterPrinter) {
          ipcRenderer.invoke('print-cashier-receipt-data', receiptData, settings.counterPrinter, printLogo, settings).catch(console.error);
        } else if (targetPrintType === 'kitchen' && settings.kitchenPrinter) {
          ipcRenderer.invoke('print-kitchen-receipt-data', kitchenReceiptData, settings.kitchenPrinter, printLogo, settings).catch(console.error);
        } else {
          setPrintReadyUrl(printPageUrl(targetPrintType));
        }
      } catch {
        setPrintReadyUrl(printPageUrl(targetPrintType));
      }
    } else {
      setPrintReadyUrl(printPageUrl(targetPrintType));
    }

    return updated;
  }

  async function completeOrder(full: boolean) {
    if (!selectedOrder) return;
    const paid = full ? payable : Number(paymentAmount || 0);
    if (!full && (paid <= 0 || paid > payable)) return setStatus({ tone: 'error', text: 'Enter a valid payment amount.' });
    // `paid` here is the FULL amount actually collected right now - this
    // order's own bill plus whatever of the customer's other outstanding
    // dues (Previous Dues, above) the cashier chose to collect alongside
    // it. The backend's completeAndSettle action pays down the customer's
    // older dues/pending orders first with it, oldest first, and only
    // applies what's left to this order - see orderController.updateOrder.
    const updated = await saveUpdate({ status: 'completed', action: 'completeAndSettle', paidAmount: paid, discount: discountForOrder });
    if (!updated) return;
    await sendCompletedReceiptOnWhatsApp(updated);
    setShowPayment(false);
    setPaymentAmount('');
    setDiscountAmountInput('');
    setDiscountPercentInput('');
    setStatus({ tone: 'success', text: `Order ${updated.id} completed successfully.` });
  }

  async function sendCompletedReceiptOnWhatsApp(order: SavedOrder) {
    if (!hasCustomerPhone(order)) return;

    const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
    if (!isElectron) {
      console.warn('Customer receipt PDF WhatsApp send requires the Electron app.');
      return;
    }

    try {
      const electronRequire = (window as ElectronWindow).require;
      const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
      if (!ipcRenderer) throw new Error('Electron IPC is unavailable.');

      const printLogo = localStorage.getItem('preferred-print-logo');
      const receiptNumber = orderNumber(order);
      // Same "Previous Dues" figure the cashier saw in the Complete Payment
      // panel when they completed this order - see saveUpdate above.
      // settings must be passed through here too, exactly like the
      // print-cashier/print-kitchen calls above - without it this PDF's
      // ReceiptPdf() has no receiptHeader to read and silently falls back
      // to a hardcoded store name instead of whatever was configured in
      // Settings -> Manage Receipt.
      const result = await ipcRenderer.invoke('create-customer-receipt-pdf-data', { ...order, previousDues: customerDue }, `customer_receipt_${receiptNumber}`, printLogo, settings);
      if (!isReceiptPdfResult(result) || !result.success || !result.fileBase64) {
        throw new Error(isReceiptPdfResult(result) ? result.error || 'Customer receipt PDF was not created.' : 'Invalid receipt PDF response.');
      }

      await sendWhatsappDocument(order.customer.phone, result.fileBase64, `receipt-${receiptNumber}.pdf`);
    } catch (error) {
      console.error('Failed to send completed receipt PDF on WhatsApp:', error);
      setStatus({ tone: 'error', text: 'Order completed, but WhatsApp PDF receipt could not be sent.' });
    }
  }

  function handleOrderCancelled(updated: SavedOrder) {
    setOrders((previous) => previous.map((order) => (order.id === updated.id ? updated : order)));
    setSelectedOrder(updated);
    setShowCancel(false);
    setStatus({ tone: 'success', text: `Order ${updated.dailyOrderNumber ?? updated.id} cancelled successfully.` });
  }

  async function addItems(items: Array<{ name: string; price: number; quantity: number; variation: string }>) {
    if (items.length === 0) return setStatus({ tone: 'error', text: 'Select at least one item.' });
    const updated = await saveUpdate({ action: 'addItems', items });
    if (!updated) return;
    setShowAddItems(false);
    setStatus({ tone: 'success', text: `Added ${items.length} item(s) to ${updated.id}.` });
  }

  async function handleSendWhatsAppReciept(order: SavedOrder) {
    if (!order.customer.phone || order.customer.phone === '03000000000') {
      return setStatus({ tone: 'error', text: 'No valid phone number for this customer.' });
    }

    setIsSendingWA(true);
    try {
      const lines = [];
      lines.push(`*The Heaven Slice* 🍕`);
      lines.push(`Order No: *${orderNumber(order)}*`);
      lines.push(`Total: *PKR ${order.total}*`);
      lines.push(`--------------------`);
      order.items.forEach((item) => {
        lines.push(`${item.quantity}x ${item.name} @ PKR ${item.price}`);
      });
      lines.push(`--------------------`);
      lines.push(`Thank you for your order!`);

      const message = lines.join('\n');
      const res = await sendWhatsappMessage(order.customer.phone, message);

      if (res?.success) {
        setStatus({ tone: 'success', text: `Receipt sent via WhatsApp to ${order.customer.phone}` });
      } else {
        setStatus({ tone: 'error', text: res?.error || 'Failed to send WhatsApp message. Is it connected?' });
      }
    } catch (err) {
      setStatus({ tone: 'error', text: 'WhatsApp send failed: ' + (err instanceof Error ? err.message : '') });
    } finally {
      setIsSendingWA(false);
    }
  }

  return (
    <div className="space-y-6">
      {status ? <Banner tone={status.tone} text={status.text} /> : null}
      {/* Fixed 4-up grid (not auto-fit) so these always sit in a single
          compact row instead of wrapping to 2 across on narrower windows. */}
      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Pending Orders" value={String(visibleOrders.filter((order) => order.status === 'pending').length)} />
        <StatCard label="Completed" value={String(visibleOrders.filter((order) => order.status === 'completed').length)} />
        <StatCard label="Cancelled" value={String(visibleOrders.filter((order) => order.status === 'cancelled').length)} />
        <StatCard label="Open Value" value={`Rs ${visibleOrders.filter((order) => order.status === 'pending').reduce((sum, order) => sum + order.total, 0)}`} />
      </div>

      {/* Order detail must always sit to the right of the order list, at
          every window size - never stack below - matching the POS
          checkout panel behavior. The list column shrinks instead of
          collapsing to a single stacked column on narrower windows. */}
      <div className="grid grid-cols-[minmax(0,1fr)_260px] gap-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-4 lg:min-h-[calc(100vh-14rem)] lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,26%)] lg:gap-6 lg:items-stretch">
        <section className="min-w-0 space-y-5 lg:flex lg:min-h-0 lg:flex-col">
          <div className="rounded-[24px] bg-white p-3.5 shadow-sm">
            <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-md">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search orders, tables, customers, waiters" className="w-full rounded-full border border-transparent bg-[#F6F7FB] py-2.5 pl-10 pr-4 text-sm outline-none focus:border-[#D6E332]" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="max-w-xs text-[11px] font-bold text-gray-400">
                  {shopSession
                    ? `Showing orders for ${shopSession.status === 'open' ? 'the current open shift' : "this shop's last shift"} - not split by calendar date.`
                    : 'No shift recorded yet. Open the shop to start taking orders.'}
                </p>
                <button type="button" onClick={() => void refresh()} className="shrink-0 rounded-2xl bg-black px-3 py-2 text-xs font-black text-white"><RefreshCcw size={13} className="mr-1.5 inline" />Refresh</button>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {filters.map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${filter === item ? 'bg-black text-white' : 'bg-[#F6F7FB] text-gray-500'}`}>{item}</button>)}
            </div>
          </div>

          {loading ? <Surface text="Loading orders..." /> : null}
          {!loading && visibleOrders.length === 0 ? <Surface text="No orders matched the current filters." /> : null}
          {!loading && visibleOrders.length > 0 ? (
            // auto-fill/minmax instead of fixed breakpoint columns - order
            // cards resize fluidly with the available width (which now
            // varies since the detail panel is always pinned to the right)
            // instead of ever needing a horizontal scrollbar.
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2.5 lg:min-h-0 lg:flex-1 lg:content-start lg:overflow-y-auto lg:pr-2">
              {pagedOrders.map((order) => (
                <button key={order.id} type="button" onClick={() => setSelectedOrder(order)} className={`min-w-0 overflow-hidden rounded-[18px] border p-2.5 text-left shadow-sm transition hover:-translate-y-0.5 ${selectedOrder?.id === order.id ? 'border-[#D6E332] bg-[#FBFDEB]' : 'border-transparent bg-white'}`}>
                  {/* The order # is the single most important thing on this
                      card - it shares its own full-width line instead of
                      competing with the status badge for space, so it never
                      gets clipped ("Order #0..."), and gets a bit of extra
                      top margin so it reads as clearly separate from the
                      age/status row above it, not squeezed together. */}
                  <div className="flex items-center justify-between gap-1.5">
                    <p className="truncate text-[9px] font-black uppercase tracking-[0.14em] text-gray-400">{age(order.createdAt)}</p>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-black uppercase ${order.status === 'pending' ? 'bg-amber-100 text-amber-700' : order.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{order.status}</span>
                  </div>
                  <h3 className="mt-2 break-words text-sm font-black text-gray-900">Order #{orderNumber(order)}</h3>
                  <p className="mt-0.5 truncate text-[10px] font-semibold text-gray-500">{formatOrderDateTime(order.createdAt)}</p>
                  <div className="mt-2 space-y-0.5 text-[11px] text-gray-600">
                    <Line icon={<UserRound size={11} />} text={label(order)} />
                    <Line icon={<Phone size={11} />} text={phoneLabel(order)} />
                    <Line icon={<ShoppingBag size={11} />} text={`${prettyType(order)} • ${order.items.length} items`} />
                  </div>
                  <div className="mt-2 truncate rounded-[12px] bg-[#F8F9FB] px-2.5 py-1.5 text-xs font-black text-gray-900">Rs {order.total}</div>
                </button>
              ))}
            </div>
          ) : null}
          {!loading && visibleOrders.length > pagedOrders.length ? (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => setVisibleOrderCount((previous) => previous + 10)}
                className="rounded-full bg-white px-6 py-2.5 text-xs font-black text-gray-700 shadow-sm transition hover:bg-gray-50"
              >
                Load More ({visibleOrders.length - pagedOrders.length} more)
              </button>
            </div>
          ) : null}
        </section>

        <aside className="min-w-0 rounded-[32px] bg-white shadow-sm lg:self-start">
          {selectedOrder ? (
            <div className="flex flex-col">
              <div className="shrink-0 border-b border-gray-100 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div><p className="text-xs font-black uppercase tracking-[0.18em] text-gray-400">Order Detail</p><h2 className="mt-2 text-2xl font-black text-gray-900">Order #{orderNumber(selectedOrder)}</h2><p className="mt-2 text-sm text-gray-500">{formatOrderDateTime(selectedOrder.createdAt)}</p></div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {selectedOrder.customer.phone && selectedOrder.customer.phone !== '03000000000' && (
                      <button disabled={isSendingWA} type="button" onClick={() => void handleSendWhatsAppReciept(selectedOrder)} className="rounded-2xl bg-emerald-500 px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-white disabled:opacity-50">
                        {isSendingWA ? 'Sending...' : 'WhatsApp'}
                      </button>
                    )}
                    <button type="button" onClick={() => {
                      const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
                      if (isElectron && settings && settings.kitchenPrinter) {
                        try {
                          const electronRequire = (window as ElectronWindow).require;
                          const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
                          if (!ipcRenderer) throw new Error('Electron IPC is unavailable.');
                          const printLogo = localStorage.getItem('preferred-print-logo');
                          ipcRenderer.invoke('print-kitchen-receipt-data', selectedOrder, settings.kitchenPrinter, printLogo, settings).catch(console.error);
                        } catch {
                          setPrintReadyUrl(`/dashboard/sales/print/${selectedOrder.id}?auto=true&type=kitchen`);
                        }
                      } else {
                        setPrintReadyUrl(`/dashboard/sales/print/${selectedOrder.id}?auto=true&type=kitchen`);
                      }
                    }} className="rounded-2xl bg-black px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-white">Send to Kitchen</button>
                    <Link to={`/dashboard/sales/print/${selectedOrder.id}`} className="rounded-2xl bg-[#F6F7FB] p-2.5 text-gray-500"><Printer size={16} /></Link>
                    <button type="button" onClick={() => void refreshOne(selectedOrder.id)} className="rounded-2xl bg-[#F6F7FB] p-2.5 text-gray-500"><RefreshCcw size={16} /></button>
                    {selectedOrder.status === 'pending' ? (
                      <Link to={`/dashboard/sales/${selectedOrder.id}/edit`} className="rounded-2xl bg-[#F6F7FB] px-3 py-2.5 text-xs font-black text-gray-600">Edit</Link>
                    ) : (
                      <span className="cursor-not-allowed rounded-2xl bg-[#F6F7FB] px-3 py-2.5 text-xs font-black text-gray-400">Edit Locked</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-5 p-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Box label="Order Number" value={`#${orderNumber(selectedOrder)}`} />
                  <Box label="Created At" value={formatOrderDateTime(selectedOrder.createdAt)} />
                  <Box label="Customer" value={label(selectedOrder)} />
                  <Box label={selectedOrder.orderType === 'DineIn' ? 'Waiter' : 'Phone'} value={phoneLabel(selectedOrder)} />
                  <Box label="Order Type" value={prettyType(selectedOrder)} />
                  <Box label="Address" value={selectedOrder.address || 'N/A'} />
                  <Box label="Previous Dues" value={`Rs ${customerDue}`} />
                  <Box label="Remaining" value={`Rs ${selectedOrder.remainingAmount ?? 0}`} />
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-black uppercase tracking-[0.18em] text-gray-400">Items</h3>
                    {selectedOrder.status === 'pending' ? (
                      <button type="button" onClick={() => setShowAddItems(true)} className="rounded-full bg-black px-4 py-2 text-xs font-black text-white"><PackagePlus size={14} className="mr-2 inline" />Add Items</button>
                    ) : (
                      <span className="rounded-full bg-[#F3F4F6] px-4 py-2 text-xs font-black text-gray-400">Order Locked</span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {selectedOrder.items.map((item, index) => <div key={`${item.name}-${index}`} className="rounded-[24px] bg-[#FAFBFC] p-4"><div className="flex items-center justify-between gap-3"><div><p className="font-black text-gray-900">{item.name}</p><p className="text-xs text-gray-400">{item.variation}</p></div><div className="text-right"><p className="text-sm font-black text-gray-900">Rs {item.price * item.quantity}</p><p className="text-xs text-gray-400">Qty {item.quantity}</p></div></div></div>)}
                  </div>
                </div>
              </div>

              <div className="shrink-0 space-y-4 rounded-b-[32px] bg-[#F8F9FB] p-6">
                <div className="rounded-[24px] bg-white p-4">
                  <Row label="Subtotal" value={`Rs ${selectedOrder.subtotal ?? 0}`} />
                  <Row label="Tax" value={`Rs ${selectedOrder.tax ?? 0}`} />
                  {selectedOrder.discount && selectedOrder.discount.amount > 0 ? (
                    <Row label={`Discount ${selectedOrder.discount.type === 'percent' ? `(${selectedOrder.discount.value}%)` : ''}`} value={`-Rs ${selectedOrder.discount.amount}`} />
                  ) : null}
                  <Row label="Bill Total" value={`Rs ${selectedOrder.total}`} />
                  <Row label="Previous Dues" value={`Rs ${customerDue}`} />
                  <Row label="Paid" value={`Rs ${selectedOrder.paidAmount ?? 0}`} />
                  <Row label="Grand Total" value={`Rs ${selectedOrder.total + customerDue}`} strong />
                </div>
                {selectedOrder.status === 'pending' ? (
                  <div className="grid gap-2">
                    <button type="button" onClick={() => { setDiscountAmountInput(''); setDiscountPercentInput(''); setShowPayment(true); }} className="rounded-[24px] bg-[#E2F33C] px-5 py-4 text-lg font-black text-black">Complete Order</button>
                    {hasPermission('sales.delete') ? (
                      <button type="button" onClick={() => setShowCancel(true)} className="rounded-[24px] bg-rose-600 px-5 py-4 text-sm font-black text-white"><Lock size={16} className="mr-2 inline" />Cancel Order</button>
                    ) : null}
                  </div>
                ) : selectedOrder.status === 'cancelled' ? (
                  <div className="space-y-1.5 rounded-[24px] bg-rose-50 px-4 py-4 text-sm font-bold text-rose-700">
                    <p>This order was cancelled and kept for record.</p>
                    {selectedOrder.cancelledBy ? <p className="text-xs font-semibold text-rose-500">Cancelled by {selectedOrder.cancelledBy}{selectedOrder.cancelledAt ? ` · ${formatOrderDateTime(selectedOrder.cancelledAt)}` : ''}</p> : null}
                    {selectedOrder.cancelReason ? <p className="text-xs font-semibold text-rose-500">Reason: {selectedOrder.cancelReason}</p> : null}
                  </div>
                ) : <div className="rounded-[24px] bg-emerald-50 px-4 py-4 text-sm font-bold text-emerald-700">This order is completed and stored in sales history.</div>}
              </div>
            </div>
          ) : <div className="flex min-h-[680px] flex-col items-center justify-center gap-4 p-6 text-center text-gray-400 lg:min-h-0 lg:h-full"><ShoppingBag size={56} strokeWidth={1.4} /><div><p className="font-bold text-gray-500">Select an order</p><p className="text-sm">Choose any order card from the left.</p></div></div>}
        </aside>
      </div>

      {showPayment && selectedOrder ? (
        <Modal title="Complete Payment" onClose={() => setShowPayment(false)}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-sm font-semibold text-gray-700">Discount (PKR)</label>
                <input
                  type="number"
                  min={0}
                  value={discountAmountInput}
                  onChange={(event) => { setDiscountAmountInput(event.target.value); if (event.target.value) setDiscountPercentInput(''); }}
                  placeholder="0"
                  className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-semibold text-gray-700">Discount (%)</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={discountPercentInput}
                  onChange={(event) => setDiscountPercentInput(event.target.value)}
                  disabled={discountAmountValue > 0}
                  placeholder="0"
                  className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-300"
                />
              </div>
            </div>
            <div className="rounded-[24px] bg-[#F8F9FB] p-4 text-sm">
              <Row label="Subtotal" value={`Rs ${orderSubtotal}`} />
              <Row label="Tax" value={`Rs ${orderTax}`} />
              {discountAmount > 0 ? (
                <Row label={`Discount ${discountType === 'percent' ? `(${discountRawValue}%)` : ''}`} value={`-Rs ${discountAmount}`} />
              ) : null}
              <Row label="Bill Total" value={`Rs ${adjustedTotal}`} />
              <Row label="Previous Dues" value={`Rs ${customerDue}`} />
              <Row label="Final Payable" value={`Rs ${payable}`} strong />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-gray-700">Amount Paid</label>
              <input value={paymentAmount} onChange={(event) => /^\d*$/.test(event.target.value) && setPaymentAmount(event.target.value)} className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none" placeholder={`Up to Rs ${payable}`} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => void completeOrder(false)} className="rounded-[20px] bg-black px-4 py-3 text-sm font-black text-white">Confirm Payment</button>
              <button type="button" onClick={() => void completeOrder(true)} className="rounded-[20px] bg-[#E2F33C] px-4 py-3 text-sm font-black text-black">Pay Full</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {showCancel && selectedOrder ? <CancelOrderModal order={selectedOrder} onClose={() => setShowCancel(false)} onCancelled={handleOrderCancelled} /> : null}

      {showAddItems && selectedOrder ? <Modal title="Add Items To Order" onClose={() => setShowAddItems(false)} wide><AddItemsManager products={products} onSaveItems={addItems} onProductsChanged={refreshProducts} /></Modal> : null}
      {printReadyUrl ? <iframe src={printReadyUrl} className="hidden" title="Auto Print Frame" /> : null}
    </div>
  );
}

function label(order: SavedOrder) { return order.orderType === 'DineIn' ? (order.table ? `Table ${order.table}` : 'Dine-In Customer') : order.customer.name || 'Walk-in Customer'; }
function phoneLabel(order: SavedOrder) { return order.orderType === 'DineIn' ? (order.waiter ? `Waiter: ${order.waiter}` : 'Dine In') : order.customer.phone || 'No phone'; }
function prettyType(order: SavedOrder) { return order.orderType === 'DineIn' ? 'Dine In' : order.orderType === 'TakeAway' ? 'Take Away' : 'Delivery'; }
function age(createdAt: string) { const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000); return mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} hr ${mins % 60} min ago`; }
function orderNumber(order: SavedOrder) { return String(order.dailyOrderNumber ?? order.id.slice(-4)).padStart(3, '0'); }
function hasCustomerPhone(order: SavedOrder) { return Boolean(order.customer.phone && order.customer.phone !== '03000000000'); }
function formatOrderDateTime(createdAt: string) { return new Date(createdAt).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

function Banner({ tone, text }: { tone: 'success' | 'error' | 'info'; text: string }) { return <div className={`rounded-[28px] border px-5 py-4 text-sm shadow-sm ${tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-sky-200 bg-sky-50 text-sky-700'}`}>{text}</div>; }
function Surface({ text }: { text: string }) { return <div className="rounded-[32px] bg-white p-8 text-sm text-gray-500 shadow-sm">{text}</div>; }
function StatCard({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-[16px] bg-white px-3 py-2.5 shadow-sm"><p className="truncate text-[9px] font-black uppercase tracking-[0.1em] text-gray-400">{label}</p><p className="mt-0.5 truncate text-lg font-black text-gray-900">{value}</p></div>; }
function Line({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="flex min-w-0 items-center gap-2 text-xs text-gray-600"><span className="shrink-0">{icon}</span><span className="truncate">{text}</span></div>; }
function Box({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-[20px] bg-[#F8F9FB] px-4 py-3"><p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">{label}</p><p className="mt-1 break-words text-sm font-bold text-gray-900">{value}</p></div>; }
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <div className={`flex items-center justify-between py-1.5 ${strong ? 'text-lg font-black text-gray-900' : 'text-sm text-gray-500'}`}><span>{label}</span><span>{value}</span></div>; }
function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) { return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm sm:p-6"><div className={`flex w-full max-h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-4rem)] flex-col rounded-[32px] bg-white shadow-2xl transition-all ${wide ? 'max-w-5xl' : 'max-w-xl'}`}><div className="flex shrink-0 items-center justify-between border-b border-gray-100 p-6 sm:px-8 sm:py-6"><h2 className="text-2xl font-black text-gray-900">{title}</h2><button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-3 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"><XCircle size={18} /></button></div><div className="overflow-y-auto p-6 sm:p-8">{children}</div></div></div>; }
