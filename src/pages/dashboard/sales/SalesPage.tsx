import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Heart, Lock, PackagePlus, Phone, Printer, RefreshCcw, Search, ShoppingBag, Table2, UserRound, XCircle } from 'lucide-react';
import { fetchCustomerOutstanding, fetchOrder, fetchOrders, fetchProducts, fetchShopSessionHistory, fetchTables, isAuthenticated, updateOrder, sendWhatsappMessage, sendWhatsappDocument } from '@/lib/pos-api';
import { Discount, Product, SavedOrder, ShopSession, Table } from '@/lib/pos-types';
import { StoreSettings, getStoreSettings } from '@/lib/pos-settings';
import { hasPermission } from '@/lib/auth';
import { useToast } from '@/lib/toast';
import AddItemsManager from '@/pages/dashboard/sales/components/AddItemsManager';
import CancelOrderModal from '@/components/CancelOrderModal';
import { resolveProductImage, resolveOrderImage } from '@/lib/food-images';

const filters = ['All', 'Dine In', 'Take Away', 'Delivery', 'Fariha', 'Ahsan Raza', 'Rehman', 'Rehan'];

// Order card styling, keyed by status - a thin all-around border + a
// matching soft background tint + badge tone, so the card's state reads at
// a glance without needing to parse the text.
const STATUS_BORDER: Record<string, string> = {
  pending: 'border-amber-300/70',
  completed: 'border-emerald-300/70',
  paid: 'border-sky-300/70',
  cancelled: 'border-rose-300/70',
};

// Soft status-tinted wash for the card body (replaces the old flat left
// accent bar) - light enough to still read as glass, tinted enough to tell
// pending/completed/paid/cancelled apart at a glance.
const STATUS_CARD_BG: Record<string, string> = {
  pending: 'from-amber-50/85 to-white/40',
  completed: 'from-emerald-50/85 to-white/40',
  paid: 'from-sky-50/85 to-white/40',
  cancelled: 'from-rose-50/85 to-white/40',
};

// Richer gradient (rather than a flat pale tint) so the status pill reads
// as a glossy, slightly raised badge - matching the gold "PENDING" pill
// look from the card design reference.
const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950',
  completed: 'bg-gradient-to-b from-emerald-300 to-emerald-500 text-emerald-950',
  paid: 'bg-gradient-to-b from-sky-300 to-sky-500 text-sky-950',
  cancelled: 'bg-gradient-to-b from-rose-300 to-rose-500 text-rose-950',
};

// The "TOTAL | Rs X" pill now carries the same status color as the badge
// above it (rather than always being a flat dark pill), so pending and
// completed orders are colored consistently across the whole card.
const STATUS_TOTAL_PILL: Record<string, string> = {
  pending: 'bg-gradient-to-b from-amber-400 to-amber-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(120,53,15,0.4)]',
  completed: 'bg-gradient-to-b from-emerald-400 to-emerald-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(6,78,59,0.4)]',
  paid: 'bg-gradient-to-b from-sky-400 to-sky-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(12,74,110,0.4)]',
  cancelled: 'bg-gradient-to-b from-rose-400 to-rose-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_7px_rgba(136,19,55,0.4)]',
};

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
  error?: string;
};

function isReceiptPdfResult(value: unknown): value is ReceiptPdfResult {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

export default function SalesPage() {
  const { popup } = useToast();
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  // Every dine-in table's Family/Simple category, loaded once so each order
  // card and the detail panel can look up "is table 7 a Family Table?"
  // by name without re-fetching per order - see Table model / isFamily in
  // TableManagementSection.tsx, the same source used on the POS table grid.
  const [tables, setTables] = useState<Table[]>([]);
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
  // Set once the cashier clicks Confirm Payment/Pay Full in the Complete
  // Payment modal - opens a second "Order Details Preview" popup (Technical
  // Requirements for Dynamic Popups #2) showing the full item list and
  // totals one more time before anything is actually charged/saved. The
  // real completeAndSettle call only happens from that preview's own
  // Confirm button (see confirmCompletePayment).
  const [paymentPreview, setPaymentPreview] = useState<{ full: boolean; paid: number } | null>(null);
  // Scrolled into view the instant the Complete Payment modal opens, so
  // the Confirm Payment/Pay Full buttons are visible without the cashier
  // needing to manually scroll down past the discount fields and bill
  // breakdown first (Technical Requirements #2 - Auto-Scroll Feature).
  const paymentButtonsRef = useRef<HTMLDivElement>(null);
  // Scrolled into view whenever a pending order is selected from the list,
  // so the Complete Order/Cancel Order buttons at the bottom of the detail
  // panel are visible immediately - no manual scrolling needed to find
  // them, matching the same auto-scroll pattern as the payment modal above.
  const completeButtonsRef = useRef<HTMLDivElement>(null);

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
    void fetchTables().then((result) => setTables(result ?? [])).catch(() => setTables([]));
    // Shop status can change (someone closes the shop) while this page is
    // sitting open, so the shift window is kept in sync the same way
    // RecordPage.tsx and the Dashboard do.
    const intervalId = setInterval(() => void refresh(), 45000);
    return () => clearInterval(intervalId);
  }, []);

  // Auto-scroll to the Confirm Payment/Pay Full buttons as soon as the
  // Complete Payment modal opens - the modal's own content (discount
  // fields + bill breakdown) can push them below the fold on shorter
  // screens, and this makes finalizing the sale possible without any
  // manual scrolling. Runs on the next paint (rAF) so the modal has
  // actually mounted first.
  useEffect(() => {
    if (!showPayment) return;
    const frame = requestAnimationFrame(() => {
      paymentButtonsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    return () => cancelAnimationFrame(frame);
  }, [showPayment]);

  // Same idea, one level up: clicking a pending order card in the list
  // selects it and the detail panel appears to the right, but on a shorter
  // window the Complete Order/Cancel Order buttons at the very bottom of
  // that panel can sit below the fold. Scroll straight to them the moment
  // a pending order is selected - keyed on id/status (not the whole
  // selectedOrder object) so the background 45s refresh doesn't re-trigger
  // this every time it swaps in a fresh object for the same order.
  useEffect(() => {
    if (!selectedOrder || selectedOrder.status !== 'pending') return;
    const frame = requestAnimationFrame(() => {
      completeButtonsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    return () => cancelAnimationFrame(frame);
    // Deliberately NOT depending on the whole selectedOrder object - see
    // comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrder?.id, selectedOrder?.status]);

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
  const sessionWindow = useMemo(() => {
    if (!shopSession) return null;
    const start = new Date(shopSession.openedAt);
    const end = shopSession.status === 'open' ? new Date() : new Date(shopSession.closedAt as string);
    return { start, end };
  }, [shopSession]);

  const shiftOrders = useMemo(() => {
    if (!sessionWindow) return [];
    return orders.filter((order) => {
      const createdAt = new Date(order.createdAt);
      return createdAt >= sessionWindow.start && createdAt <= sessionWindow.end;
    });
  }, [orders, sessionWindow]);

  const visibleOrders = useMemo(() => shiftOrders.filter((order) => {
    const byFilter = filter === 'All'
      || (filter === 'Dine In' && order.orderType === 'DineIn')
      || (filter === 'Take Away' && order.orderType === 'TakeAway')
      || (filter === 'Delivery' && order.orderType === 'Delivery')
      || order.waiter === filter;
    const haystack = `${order.id} ${order.dailyOrderNumber ?? ''} ${label(order)} ${phoneLabel(order)}`.toLowerCase();
    return byFilter && haystack.includes(search.toLowerCase());
  }), [filter, shiftOrders, search]);

  // table name -> isFamily, so any order's `table` field (just a plain
  // string like "7") can be resolved to its Family/Simple category without
  // re-fetching per card. See Table model / TableManagementSection.tsx.
  const familyTableNames = useMemo(() => {
    const map: Record<string, boolean> = {};
    tables.forEach((t) => { map[t.name] = t.isFamily; });
    return map;
  }, [tables]);

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
        const start = latestSession ? new Date(latestSession.openedAt) : null;
        const end = latestSession ? (latestSession.status === 'open' ? new Date() : new Date(latestSession.closedAt as string)) : null;
        const scoped = start && end ? data.filter((order) => {
          const createdAt = new Date(order.createdAt);
          return createdAt >= start && createdAt <= end;
        }) : [];

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
        const receiptData = targetPrintType === 'cashier' ? { ...updated, previousDues: customerDue } : updated;

        if (targetPrintType === 'cashier' && settings.counterPrinter) {
          ipcRenderer.invoke('print-cashier-receipt-data', receiptData, settings.counterPrinter, printLogo, settings).catch(console.error);
        } else if (targetPrintType === 'kitchen' && settings.kitchenPrinter) {
          ipcRenderer.invoke('print-kitchen-receipt-data', updated, settings.kitchenPrinter, printLogo, settings).catch(console.error);
        } else {
          setPrintReadyUrl(`/dashboard/sales/print/${updated.id}?auto=true&type=${targetPrintType}`);
        }
      } catch {
        setPrintReadyUrl(`/dashboard/sales/print/${updated.id}?auto=true&type=${targetPrintType}`);
      }
    } else {
      setPrintReadyUrl(`/dashboard/sales/print/${updated.id}?auto=true&type=${targetPrintType}`);
    }

    return updated;
  }

  // Step 1 of finalizing a sale: validates the amount and opens the Order
  // Details Preview popup (Technical Requirements #2) instead of charging
  // anything immediately - the actual completeAndSettle call only happens
  // from that preview's own Confirm button, see confirmCompletePayment.
  function openPaymentPreview(full: boolean) {
    if (!selectedOrder) return;
    const paid = full ? payable : Number(paymentAmount || 0);
    if (!full && (paid <= 0 || paid > payable)) {
      popup({ tone: 'error', title: 'Invalid Payment Amount', message: `Enter an amount between Rs 1 and Rs ${payable}.` });
      return;
    }
    // Swap to the preview instead of stacking it on top of this modal.
    setShowPayment(false);
    setPaymentPreview({ full, paid });
  }

  // Step 2: the cashier reviewed the preview and confirmed it. `paid` here
  // is the FULL amount actually collected right now - this order's own
  // bill plus whatever of the customer's other outstanding dues (Previous
  // Dues, above) the cashier chose to collect alongside it. The backend's
  // completeAndSettle action pays down the customer's older dues/pending
  // orders first with it, oldest first, and only applies what's left to
  // this order - see orderController.updateOrder.
  async function confirmCompletePayment() {
    if (!selectedOrder || !paymentPreview) return;
    const { paid } = paymentPreview;
    const updated = await saveUpdate({ status: 'completed', action: 'completeAndSettle', paidAmount: paid, discount: discountForOrder });
    if (!updated) return;
    await sendCompletedReceiptOnWhatsApp(updated);
    setPaymentPreview(null);
    setShowPayment(false);
    setPaymentAmount('');
    setDiscountAmountInput('');
    setDiscountPercentInput('');
    // Technical Requirements for Dynamic Popups #2 - Post-Payment Success
    // Popup: compact, responsive, and states the outcome plainly.
    popup({ tone: 'success', title: 'Order Completed Successfully', message: `Order #${orderNumber(updated)} - Rs ${paid} collected.` });
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
      const result = await ipcRenderer.invoke('create-customer-receipt-pdf-data', { ...order, previousDues: customerDue }, `customer_receipt_${receiptNumber}`, printLogo);
      if (!isReceiptPdfResult(result) || !result.success || !result.pdfPath) {
        throw new Error(isReceiptPdfResult(result) ? result.error || 'Customer receipt PDF was not created.' : 'Invalid receipt PDF response.');
      }

      await sendWhatsappDocument(order.customer.phone, result.pdfPath, `receipt-${receiptNumber}.pdf`);
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

  async function addItems(items: Array<{ name: string; price: number; quantity: number; variation: string; image?: string }>) {
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
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
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
          <div className="glass rounded-[32px] p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-md">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search orders, tables, customers, waiters" className="w-full rounded-full border border-white/60 bg-white/50 py-4 pl-12 pr-4 shadow-inner outline-none focus:border-[#D6E332]" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <p className="max-w-xs text-xs font-bold text-gray-500">
                  {shopSession
                    ? `Showing orders for ${shopSession.status === 'open' ? 'the current open shift' : "this shop's last shift"} - not split by calendar date.`
                    : 'No shift recorded yet. Open the shop to start taking orders.'}
                </p>
                <button type="button" onClick={() => void refresh()} className="glass-dark rounded-2xl px-4 py-3 text-sm font-black"><RefreshCcw size={16} className="mr-2 inline" />Refresh</button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {filters.map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`rounded-full px-4 py-2 text-sm font-bold transition ${filter === item ? 'glass-dark' : 'bg-white/50 text-gray-600 shadow-inner hover:bg-white/70'}`}>{item}</button>)}
            </div>
          </div>

          {loading ? <Surface text="Loading orders..." /> : null}
          {!loading && visibleOrders.length === 0 ? <Surface text="No orders matched the current filters." /> : null}
          {!loading && visibleOrders.length > 0 ? (
            // auto-fill/minmax instead of fixed breakpoint columns - order
            // cards resize fluidly with the available width (which now
            // varies since the detail panel is always pinned to the right)
            // instead of ever needing a horizontal scrollbar.
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-3 md:grid-cols-3 lg:min-h-0 lg:flex-1 lg:content-start lg:grid-cols-3 lg:overflow-y-auto lg:pr-2 xl:grid-cols-4">
              {visibleOrders.map((order) => {
                const isSelected = selectedOrder?.id === order.id;
                const heroImage = resolveOrderImage(order.items);
                return (
                <button
                  key={order.id}
                  type="button"
                  onClick={() => setSelectedOrder(order)}
                  className={`min-w-0 overflow-hidden rounded-[28px] border bg-gradient-to-br backdrop-blur-xl backdrop-saturate-150 text-left transition-all duration-200 ${
                    isSelected
                      ? '-translate-y-1 border-[#D6E332] from-[#FBFDEB]/80 to-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_10px_rgba(214,227,50,0.3)] ring-1 ring-[#E2F33C]/60'
                      : `${STATUS_BORDER[order.status] ?? 'border-gray-200'} ${STATUS_CARD_BG[order.status] ?? 'from-white/60 to-white/25'} shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_10px_rgba(15,23,42,0.14)] hover:-translate-y-1.5 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-5px_12px_rgba(15,23,42,0.2)]`
                  }`}
                >
                  <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
                    <img src={heroImage} alt={order.items[0]?.name ?? 'Order'} loading="lazy" className="h-full w-full object-cover" />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-black/0 to-transparent" />
                    <span className={`absolute right-2 top-2 rounded-full px-3 py-1 text-[11px] font-black uppercase shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-1px_3px_rgba(0,0,0,0.12)] ${STATUS_BADGE[order.status] ?? 'bg-gray-100 text-gray-600'}`}>{order.status}</span>
                    <span className="absolute bottom-2 left-2 min-w-0 max-w-[85%] truncate rounded-full bg-white/90 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-700 shadow-sm backdrop-blur-sm">
                      {age(order.createdAt)} &middot; {formatOrderDateTime(order.createdAt)}
                    </span>
                  </div>
                  <div className="p-4">
                    <h3 className="truncate text-lg font-black text-gray-900">Order #{orderNumber(order)}</h3>
                    <div className="mt-3 space-y-2 text-sm text-gray-600">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="min-w-0 shrink-0"><Line icon={<UserRound size={15} />} text={label(order)} /></div>
                        {order.orderType === 'DineIn' && order.table ? (
                          <TableTypeBadge tableName={order.table} isFamily={familyTableNames[order.table]} />
                        ) : null}
                      </div>
                      <Line icon={<Phone size={15} />} text={phoneLabel(order)} />
                      <Line icon={<ShoppingBag size={15} />} text={`${prettyType(order)} • ${order.items.length} items`} />
                    </div>
                    <div className={`mt-4 flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-black ${STATUS_TOTAL_PILL[order.status] ?? 'glass-dark'}`}>
                      <span className="text-[10px] font-bold uppercase tracking-widest text-white/75">Total</span>
                      <span className="text-white/40">|</span>
                      <span className="truncate">Rs {order.total}</span>
                    </div>
                  </div>
                </button>
                );
              })}
            </div>
          ) : null}
        </section>

        <aside className="glass min-w-0 rounded-[32px] lg:self-start">
          {selectedOrder ? (
            <div className="flex flex-col">
              <div className="shrink-0 border-b border-white/40 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div><p className="text-xs font-black uppercase tracking-[0.18em] text-gray-500">Order Detail</p><h2 className="mt-2 text-2xl font-black text-gray-900">Order #{orderNumber(selectedOrder)}</h2><p className="mt-2 text-sm text-gray-500">{formatOrderDateTime(selectedOrder.createdAt)}</p></div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {selectedOrder.customer.phone && selectedOrder.customer.phone !== '03000000000' && (
                      <button disabled={isSendingWA} type="button" onClick={() => void handleSendWhatsAppReciept(selectedOrder)} className="rounded-2xl bg-gradient-to-b from-emerald-400 to-emerald-600 px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] disabled:opacity-50">
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
                    }} className="glass-dark rounded-2xl px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em]">Send to Kitchen</button>
                    <Link to={`/dashboard/sales/print/${selectedOrder.id}`} className="glass-pill rounded-2xl p-2.5 text-gray-500"><Printer size={16} /></Link>
                    <button type="button" onClick={() => void refreshOne(selectedOrder.id)} className="glass-pill rounded-2xl p-2.5 text-gray-500"><RefreshCcw size={16} /></button>
                    {selectedOrder.status === 'pending' ? (
                      <Link to={`/dashboard/sales/${selectedOrder.id}/edit`} className="glass-pill rounded-2xl px-3 py-2.5 text-xs font-black text-gray-600">Edit</Link>
                    ) : (
                      <span className="glass-pill cursor-not-allowed rounded-2xl px-3 py-2.5 text-xs font-black text-gray-400">Edit Locked</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-5 p-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Box label="Order Number" value={`#${orderNumber(selectedOrder)}`} />
                  <Box label="Created At" value={formatOrderDateTime(selectedOrder.createdAt)} />
                  <Box label="Customer" value={label(selectedOrder)} />
                  {selectedOrder.orderType === 'DineIn' && selectedOrder.table ? (
                    <div className="min-w-0 rounded-[20px] bg-white/50 px-4 py-3 shadow-inner">
                      <p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-500">Table Category</p>
                      <div className="mt-1.5"><TableTypeBadge tableName={selectedOrder.table} isFamily={familyTableNames[selectedOrder.table]} /></div>
                    </div>
                  ) : null}
                  <Box label={selectedOrder.orderType === 'DineIn' ? 'Waiter' : 'Phone'} value={phoneLabel(selectedOrder)} />
                  <Box label="Order Type" value={prettyType(selectedOrder)} />
                  <Box label="Address" value={selectedOrder.address || 'N/A'} />
                  <Box label="Previous Dues" value={`Rs ${customerDue}`} />
                  <Box label="Remaining" value={`Rs ${selectedOrder.remainingAmount ?? 0}`} />
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-black uppercase tracking-[0.18em] text-gray-500">Items</h3>
                    {selectedOrder.status === 'pending' ? (
                      <button type="button" onClick={() => setShowAddItems(true)} className="glass-dark rounded-full px-4 py-2 text-xs font-black"><PackagePlus size={14} className="mr-2 inline" />Add Items</button>
                    ) : (
                      <span className="glass-pill rounded-full px-4 py-2 text-xs font-black text-gray-500">Order Locked</span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {selectedOrder.items.map((item, index) => (
                      <div key={`${item.name}-${index}`} className="flex items-center gap-3 rounded-[24px] bg-white/45 p-3 shadow-inner">
                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[16px] bg-slate-100 shadow-inner">
                          <img src={resolveProductImage({ image: item.image, name: item.name })} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                        </div>
                        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                          <div className="min-w-0"><p className="truncate font-black text-gray-900">{item.name}</p><p className="text-xs text-gray-500">{item.variation}</p></div>
                          <div className="shrink-0 text-right"><p className="text-sm font-black text-gray-900">Rs {item.price * item.quantity}</p><p className="text-xs text-gray-500">Qty {item.quantity}</p></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="shrink-0 space-y-4 rounded-b-[32px] border-t border-white/40 bg-white/30 p-6">
                <div className="rounded-[24px] bg-white/50 p-4 shadow-inner">
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
                  <div ref={completeButtonsRef} className="grid gap-2.5">
                    <button
                      type="button"
                      onClick={() => { setDiscountAmountInput(''); setDiscountPercentInput(''); setShowPayment(true); }}
                      className="flex items-center justify-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-emerald-400 to-emerald-600 px-5 py-4 text-lg font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.5),inset_0_-4px_10px_rgba(6,95,70,0.45)] transition hover:brightness-105"
                    >
                      <CheckCircle2 size={20} /> Complete Order
                    </button>
                    {hasPermission('sales.delete') ? (
                      <button
                        type="button"
                        onClick={() => setShowCancel(true)}
                        className="flex items-center justify-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-rose-500 to-rose-700 px-5 py-4 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-4px_10px_rgba(136,19,55,0.45)] transition hover:brightness-105"
                      >
                        <Lock size={16} /> Cancel Order
                      </button>
                    ) : null}
                  </div>
                ) : selectedOrder.status === 'cancelled' ? (
                  <div className="space-y-1.5 rounded-[24px] bg-rose-50/60 px-4 py-4 text-sm font-bold text-rose-700 shadow-inner">
                    <p>This order was cancelled and kept for record.</p>
                    {selectedOrder.cancelledBy ? <p className="text-xs font-semibold text-rose-500">Cancelled by {selectedOrder.cancelledBy}{selectedOrder.cancelledAt ? ` · ${formatOrderDateTime(selectedOrder.cancelledAt)}` : ''}</p> : null}
                    {selectedOrder.cancelReason ? <p className="text-xs font-semibold text-rose-500">Reason: {selectedOrder.cancelReason}</p> : null}
                  </div>
                ) : <div className="rounded-[24px] bg-emerald-50/60 px-4 py-4 text-sm font-bold text-emerald-700 shadow-inner">This order is completed and stored in sales history.</div>}
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
                  className="w-full rounded-2xl border border-white/60 bg-white/50 px-4 py-3 shadow-inner outline-none"
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
                  className="w-full rounded-2xl border border-white/60 bg-white/50 px-4 py-3 shadow-inner outline-none disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-gray-300"
                />
              </div>
            </div>
            <div className="rounded-[24px] bg-white/50 p-4 text-sm shadow-inner">
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
              <input value={paymentAmount} onChange={(event) => /^\d*$/.test(event.target.value) && setPaymentAmount(event.target.value)} className="w-full rounded-2xl border border-white/60 bg-white/50 px-4 py-3 shadow-inner outline-none" placeholder={`Up to Rs ${payable}`} />
            </div>
            <div ref={paymentButtonsRef} className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => openPaymentPreview(false)} className="glass-dark rounded-[20px] px-4 py-3 text-sm font-black transition hover:brightness-110">Confirm Payment</button>
              <button type="button" onClick={() => openPaymentPreview(true)} className="rounded-[20px] border-[0.5px] border-white/50 bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] px-4 py-3 text-sm font-black text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-3px_8px_rgba(132,144,10,0.4)] transition hover:brightness-105">Pay Full</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {paymentPreview && selectedOrder ? (
        <Modal title="Confirm Order Payment" onClose={() => { setPaymentPreview(null); setShowPayment(true); }}>
          <div className="space-y-4">
            <div className="rounded-[24px] bg-white/50 p-4 shadow-inner">
              <p className="mb-3 text-xs font-black uppercase tracking-[0.16em] text-gray-400">
                Order #{orderNumber(selectedOrder)} &middot; {label(selectedOrder)}
              </p>
              <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                {selectedOrder.items.map((item, index) => (
                  <div key={`${item.name}-${index}`} className="flex items-center gap-2.5 text-sm">
                    <div className="h-8 w-8 shrink-0 overflow-hidden rounded-[10px] bg-slate-100 shadow-inner">
                      <img src={resolveProductImage({ image: item.image, name: item.name })} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                    </div>
                    <span className="min-w-0 flex-1 truncate text-gray-600">{item.name}{item.variation ? ` (${item.variation})` : ''} &times; {item.quantity}</span>
                    <span className="shrink-0 font-black text-gray-900">Rs {item.price * item.quantity}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-[24px] bg-white/50 p-4 text-sm shadow-inner">
              <Row label="Subtotal" value={`Rs ${orderSubtotal}`} />
              <Row label="Tax" value={`Rs ${orderTax}`} />
              {discountAmount > 0 ? (
                <Row label={`Discount ${discountType === 'percent' ? `(${discountRawValue}%)` : ''}`} value={`-Rs ${discountAmount}`} />
              ) : null}
              <Row label="Bill Total" value={`Rs ${adjustedTotal}`} />
              <Row label="Previous Dues" value={`Rs ${customerDue}`} />
              <Row label="Collecting Now" value={`Rs ${paymentPreview.paid}`} strong />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => { setPaymentPreview(null); setShowPayment(true); }} className="glass-pill rounded-[20px] px-4 py-3 text-sm font-black text-gray-700 transition hover:bg-white/70">Back</button>
              <button type="button" onClick={() => void confirmCompletePayment()} className="rounded-[20px] border-[0.5px] border-white/50 bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] px-4 py-3 text-sm font-black text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-3px_8px_rgba(132,144,10,0.4)] transition hover:brightness-105">Confirm &amp; Complete</button>
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

function Banner({ tone, text }: { tone: 'success' | 'error' | 'info'; text: string }) { return <div className={`glass rounded-[28px] px-5 py-4 text-sm ${tone === 'success' ? 'text-emerald-700' : tone === 'error' ? 'text-rose-700' : 'text-sky-700'}`}>{text}</div>; }
function Surface({ text }: { text: string }) { return <div className="glass rounded-[32px] p-8 text-sm text-gray-500">{text}</div>; }
function StatCard({ label, value }: { label: string; value: string }) { return <div className="glass rounded-[28px] px-5 py-5"><p className="text-[11px] font-black uppercase tracking-[0.18em] text-gray-500">{label}</p><p className="mt-2 text-3xl font-black text-gray-900">{value}</p></div>; }
function Line({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="flex min-w-0 items-center gap-2.5 text-sm text-gray-600"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/60 text-gray-500 shadow-inner">{icon}</span><span className="truncate">{text}</span></div>; }

// A dine-in table is either a Family Table or a plain/Simple table (see
// Table model's `isFamily` + TableManagementSection.tsx) - this makes that
// category impossible to miss anywhere a table number shows up, e.g. table
// 7 vs table 11 can be two different categories and staff need to see
// which is which at a glance, not just the number. `isFamily` is
// `undefined` only if the table was deleted/renamed since this list last
// loaded - falls back to the neutral "Simple" look rather than rendering
// nothing.
function TableTypeBadge({ tableName, isFamily }: { tableName: string; isFamily: boolean | undefined }) {
  const familyMode = Boolean(isFamily);
  return (
    <span
      title={`Table ${tableName} - ${familyMode ? 'Family Table' : 'Simple Table'}`}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[7px] font-black uppercase tracking-wide shadow-inner ${familyMode ? 'bg-pink-100/80 text-pink-700' : 'bg-sky-100/80 text-sky-700'}`}
    >
      {familyMode ? <Heart size={8} fill="currentColor" /> : <Table2 size={8} />}
      {familyMode ? 'Family' : 'Simple'}
    </span>
  );
}
function Box({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-[20px] bg-white/50 px-4 py-3 shadow-inner"><p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-gray-500">{label}</p><p className="mt-1 break-words text-sm font-bold text-gray-900">{value}</p></div>; }
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <div className={`flex items-center justify-between py-1.5 ${strong ? 'text-lg font-black text-gray-900' : 'text-sm text-gray-500'}`}><span>{label}</span><span>{value}</span></div>; }
function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) { return <div className="glass-overlay fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"><div className={`glass-strong flex w-full max-h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-4rem)] flex-col rounded-[32px] transition-all ${wide ? 'max-w-5xl' : 'max-w-xl'}`}><div className="flex shrink-0 items-center justify-between border-b border-white/40 p-6 sm:px-8 sm:py-6"><h2 className="text-2xl font-black text-gray-900">{title}</h2><button type="button" onClick={onClose} className="glass-pill rounded-full p-3 text-gray-500 transition hover:bg-white/70"><XCircle size={18} /></button></div><div className="overflow-y-auto p-6 sm:p-8">{children}</div></div></div>; }
