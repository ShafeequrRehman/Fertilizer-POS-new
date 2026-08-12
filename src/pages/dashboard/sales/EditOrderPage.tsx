import { Link, useParams } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Plus, Save, Search, Trash2 } from 'lucide-react';
import { ApiError, claimKitchenUpdatePrint, fetchOrder, fetchProducts, updateOrder } from '@/lib/pos-api';
import { Product, SavedOrder } from '@/lib/pos-types';
import { getStoreSettings } from '@/lib/pos-settings';
import { isDesktopApp } from '@/lib/api';
import { useNetworkStatus } from '@/lib/network-status';
import { getPendingLocalOrders, getReferenceData } from '@/lib/local-hub-api';
import { localOrderToSavedOrder, saveOrderEditOffline, computeKitchenIncreaseDelta } from '@/lib/offline-order-helpers';

type DraftItem = { name: string; price: number; quantity: number; variation: string };

type ElectronWindow = Window & typeof globalThis & {
  require?: (moduleName: 'electron') => {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  };
};

// Fires a "do not prepare / discard" kitchen ticket for items taken off
// an order that's still otherwise active - same idea as
// CancelOrderModal.tsx's cancel ticket, but scoped to just the removed
// items (see main.js's "kitchen-remove" receipt type) instead of saying
// the whole order is cancelled, since it isn't.
function printKitchenRemoveTicket(order: SavedOrder, removedItems: DraftItem[]) {
  if (removedItems.length === 0) return;
  const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
  if (!isElectron) return;

  try {
    const electronRequire = (window as ElectronWindow).require;
    if (!electronRequire) return;
    const { ipcRenderer } = electronRequire('electron');
    const settings = getStoreSettings();
    const printLogo = localStorage.getItem('preferred-print-logo');

    if (settings.kitchenPrinter) {
      ipcRenderer.invoke('print-kitchen-remove-receipt-data', { ...order, items: removedItems }, settings.kitchenPrinter, printLogo, settings).catch(console.error);
    } else {
      console.warn('No kitchen printer configured in settings - removed-items ticket not printed.');
    }
  } catch (err) {
    console.error('Electron print error (kitchen remove-items ticket):', err);
  }
}

// Fires a normal kitchen ticket for just the items the kitchen needs to
// prepare MORE of - a brand new item added via Quick Add, or an existing
// line's quantity bumped up with the +/- stepper. `items` here is already
// the exact claimed delta from claimKitchenUpdatePrint (see saveOrder
// below), never the whole order's item list, so the kitchen is never told
// to re-make something they already started or finished.
function printKitchenUpdateTicket(order: SavedOrder, items: SavedOrder['items']) {
  if (items.length === 0) return;
  const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
  if (!isElectron) return;

  try {
    const electronRequire = (window as ElectronWindow).require;
    if (!electronRequire) return;
    const { ipcRenderer } = electronRequire('electron');
    const settings = getStoreSettings();
    const printLogo = localStorage.getItem('preferred-print-logo');

    if (settings.kitchenPrinter) {
      ipcRenderer.invoke('print-kitchen-receipt-data', { ...order, items }, settings.kitchenPrinter, printLogo, settings).catch(console.error);
    } else {
      console.warn('No kitchen printer configured in settings - kitchen update ticket not printed.');
    }
  } catch (err) {
    console.error('Electron print error (kitchen update ticket):', err);
  }
}

export default function EditOrderPage() {
  const params = useParams<{ id: string }>();
  const [order, setOrder] = useState<SavedOrder | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<DraftItem[]>([]);
  // Items the user clicked "Remove" on since the order was loaded (or
  // since the last save) - what actually needs printing for the kitchen
  // to stop, as opposed to diffing the whole list at save time, which
  // would also misfire on ordinary name/price/qty edits.
  const [removedItems, setRemovedItems] = useState<DraftItem[]>([]);
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState(true);
  // Only set when this page couldn't load an order at all because it's
  // offline and the order isn't one this till can reconstruct locally
  // (see the load effect below) - distinct from "Order not found" so the
  // person sees an actionable reason instead of thinking the order itself
  // is gone.
  const [offlineUnavailable, setOfflineUnavailable] = useState(false);
  const { isOnline } = useNetworkStatus();

  useEffect(() => {
    async function load() {
      setOfflineUnavailable(false);
      try {
        if (isDesktopApp() && !isOnline) {
          // Offline: a still-local (not yet synced) order can be fully
          // reconstructed from the Local Hub's own queue - anything else
          // (an order that already existed in the cloud before this
          // offline stretch) can't be, since this till has no cached copy
          // of past orders' full detail to fall back to. Use the order
          // card's Add Items / Complete Payment for those instead (see
          // SalesPage.tsx's saveUpdate, which handles both cases).
          if (params.id?.startsWith('local-')) {
            const localId = params.id.slice('local-'.length);
            const pending = await getPendingLocalOrders();
            const record = pending.find((entry) => entry.id === localId);
            if (record) {
              const orderData = localOrderToSavedOrder(record);
              setOrder(orderData);
              setItems(orderData.items);
              setRemovedItems([]);
            } else {
              setOrder(null);
            }
          } else {
            setOrder(null);
            setOfflineUnavailable(true);
          }
          try {
            const snapshot = await getReferenceData();
            setProducts((snapshot.products || []) as Product[]);
          } catch {
            setProducts([]);
          }
          return;
        }

        const [orderData, productData] = await Promise.all([fetchOrder(params.id), fetchProducts()]);
        setOrder(orderData);
        setItems(orderData.items);
        setRemovedItems([]);
        setProducts(productData.products);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [params.id, isOnline]);

  async function saveOrder() {
    if (!order) return;
    const subtotal = items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
    const nextPaidAmount = order.status === 'completed'
      ? subtotal
      : Math.min(order.paidAmount ?? 0, subtotal);
    const nextRemainingAmount = order.status === 'completed'
      ? 0
      : Math.max(subtotal - nextPaidAmount, 0);

    const patch = {
      action: 'replaceItems' as const,
      items,
      status: order.status,
      note: order.note,
      waiter: order.waiter,
      table: order.table,
      address: order.address,
      customer: order.customer,
      paymentMethod: order.paymentMethod,
      paidAmount: nextPaidAmount,
      remainingAmount: nextRemainingAmount,
      discount: order.discount ?? null,
    };

    if (isDesktopApp() && !isOnline) {
      // No kitchen-print CLAIM here - that coordinates printing across
      // devices via the cloud, same reasoning as SalesPage.tsx's
      // saveUpdate offline branch. The tickets themselves still print
      // immediately below (printKitchenRemoveTicket/printKitchenUpdateTicket
      // are already self-contained - no-op if no printer's configured),
      // same as they would online - nothing else could possibly be racing
      // to print this same delta while it's still only sitting on this
      // till, so there's no claim to make first. This page can only ever
      // reach here for a still-local (not yet synced) order - see the load
      // effect above - so the removed/added items are still fully recorded
      // in what gets synced either way.
      const kitchenDelta = computeKitchenIncreaseDelta(order.items, items);
      try {
        const updated = await saveOrderEditOffline(order, patch, kitchenDelta.length > 0);
        printKitchenRemoveTicket(updated, removedItems);
        if (kitchenDelta.length > 0) {
          printKitchenUpdateTicket(updated, kitchenDelta);
        }
        setRemovedItems([]);
        setStatus(`Order ${updated.id} saved offline - will sync once back online.`);
        setOrder(updated);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Could not save this change offline.');
      }
      return;
    }

    const updated = await updateOrder(order.id, patch);
    printKitchenRemoveTicket(updated, removedItems);
    setRemovedItems([]);

    // Claim-before-print, same invariant as everywhere else a kitchen
    // ticket auto-prints - if a quantity went up or a new item was added
    // via Quick Add just now, this claims that delta before this same edit
    // could otherwise be double-printed by DashboardShell's
    // KitchenUpdateWatcher a few seconds later. A 409 here just means
    // there was nothing to claim (e.g. only quantities went DOWN, or items
    // were only removed) - not an error.
    try {
      const claimed = await claimKitchenUpdatePrint(updated.id);
      if (claimed && claimed.items.length > 0) {
        printKitchenUpdateTicket(claimed.order, claimed.items);
      }
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) {
        console.error('Kitchen update claim failed:', err);
      }
    }

    setStatus(`Order ${updated.id} saved successfully.`);
    setOrder(updated);
  }

  const visibleProducts = useMemo(
    () => products.filter((product) => (category === 'All' || product.category === category) && (`${product.name} ${product.variation}`).toLowerCase().includes(search.toLowerCase())),
    [category, products, search],
  );

  if (loading) {
    return <div className="rounded-[32px] bg-white p-8 text-sm text-gray-500 shadow-sm">Loading order editor...</div>;
  }

  if (!order) {
    return (
      <div className="rounded-[32px] bg-white p-8 text-sm text-rose-500 shadow-sm">
        {offlineUnavailable
          ? "This detailed editor needs an internet connection to load an order that already existed before this till went offline. Use the order card's Add Items / Complete Payment instead, or try again once back online."
          : 'Order not found.'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {status ? <div className="rounded-[28px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700 shadow-sm">{status}</div> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/dashboard/sales" className="text-sm font-bold text-gray-500">
            <ArrowLeft size={16} className="mr-2 inline" />
            Back to Sales
          </Link>
          <h1 className="mt-2 text-3xl font-black text-gray-900">Edit Order #{order.id.slice(-4)}</h1>
        </div>
        <div className="flex gap-2">
          <Link href={`/dashboard/sales/print/${order.id}`} className="rounded-2xl bg-black px-4 py-3 text-sm font-black text-white">Print Center</Link>
          <button type="button" onClick={() => void saveOrder()} className="rounded-2xl bg-[#E2F33C] px-4 py-3 text-sm font-black text-black">
            <Save size={16} className="mr-2 inline" />
            Save Changes
          </button>
        </div>
      </div>

      {/* Order meta / quick-add panel always sits to the right of the item
          list, at every window size, matching the POS and Sales pages. */}
      <div className="grid grid-cols-[minmax(0,1fr)_260px] gap-3 sm:grid-cols-[minmax(0,1fr)_320px] sm:gap-4 xl:grid-cols-[minmax(0,1.2fr)_380px] xl:gap-6">
        <section className="min-w-0 rounded-[32px] bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-black uppercase tracking-[0.18em] text-gray-400">Order Items</h2>
          <div className="space-y-3">
            {items.map((item, index) => (
              // Keyed by index, not name - the name field is editable, and
              // keying by its current value meant every keystroke there
              // changed the key, which made React remount the whole row
              // (losing input focus) instead of just updating it in place.
              <div key={index} className="rounded-[24px] bg-[#F8F9FB] p-4">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px_90px_140px_50px]">
                  <input value={item.name} onChange={(event) => setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, name: event.target.value } : entry))} className="rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
                  <input value={item.variation} onChange={(event) => setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, variation: event.target.value } : entry))} className="rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
                  <input value={String(item.price)} onChange={(event) => /^\d*$/.test(event.target.value) && setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, price: Number(event.target.value || 0) } : entry))} className="rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
                  <div className="flex items-center justify-between gap-1 rounded-2xl border border-gray-200 bg-white px-2 py-2">
                    <button
                      type="button"
                      onClick={() => setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: Math.max(1, (Number(entry.quantity) || 1) - 1) } : entry))}
                      className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#F8F9FB] text-lg font-black text-gray-700"
                    >
                      −
                    </button>
                    <input
                      value={String(item.quantity)}
                      onChange={(event) => /^\d*$/.test(event.target.value) && setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: event.target.value === '' ? ('' as unknown as number) : Number(event.target.value) } : entry))}
                      onBlur={() => setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: Math.max(1, Number(entry.quantity) || 1) } : entry))}
                      className="w-10 border-0 bg-transparent text-center text-sm font-black text-gray-900 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: (Number(entry.quantity) || 0) + 1 } : entry))}
                      className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#F8F9FB] text-lg font-black text-gray-700"
                    >
                      +
                    </button>
                  </div>
                  <button type="button" onClick={() => { setRemovedItems((previous) => [...previous, items[index]]); setItems((previous) => previous.filter((_, itemIndex) => itemIndex !== index)); }} className="rounded-2xl bg-rose-50 text-rose-600">
                    <Trash2 size={16} className="mx-auto" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <aside className="min-w-0 space-y-6">
          <div className="rounded-[32px] bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-black uppercase tracking-[0.18em] text-gray-400">Order Meta</h2>
            <div className="space-y-3">
              <input value={order.customer.name} onChange={(event) => setOrder((previous) => previous ? { ...previous, customer: { ...previous.customer, name: event.target.value } } : previous)} placeholder="Customer name" className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
              <input value={order.customer.phone} onChange={(event) => setOrder((previous) => previous ? { ...previous, customer: { ...previous.customer, phone: event.target.value } } : previous)} placeholder="Phone" className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
              <input value={order.address} onChange={(event) => setOrder((previous) => previous ? { ...previous, address: event.target.value, customer: { ...previous.customer, address: event.target.value } } : previous)} placeholder="Address" className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
              <input value={order.waiter} onChange={(event) => setOrder((previous) => previous ? { ...previous, waiter: event.target.value } : previous)} placeholder="Waiter" className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
              <input value={order.table} onChange={(event) => setOrder((previous) => previous ? { ...previous, table: event.target.value } : previous)} placeholder="Table" className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
              <textarea value={order.note} onChange={(event) => setOrder((previous) => previous ? { ...previous, note: event.target.value } : previous)} placeholder="Order note" className="min-h-24 w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
            </div>
          </div>

          <div className="rounded-[32px] bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-black uppercase tracking-[0.18em] text-gray-400">Quick Add Product</h2>
            <div className="space-y-4">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search menu items" className="w-full rounded-full border border-gray-200 bg-[#F8F9FB] py-3 pl-11 pr-4 outline-none" />
              </div>
              <div className="flex flex-wrap gap-2">
                {['All', ...new Set(products.map((product) => product.category))].map((item) => (
                  <button key={item} type="button" onClick={() => setCategory(item)} className={`rounded-full px-3 py-2 text-xs font-bold ${category === item ? 'bg-black text-white' : 'bg-[#F6F7FB] text-gray-500'}`}>{item}</button>
                ))}
              </div>
              <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {visibleProducts.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => setItems((previous) => [...previous, { name: product.name, price: product.price, quantity: 1, variation: product.variation }])}
                  className="flex w-full items-center justify-between rounded-[22px] bg-[#F8F9FB] px-4 py-3 text-left"
                >
                  <div>
                    <p className="font-bold text-gray-900">{product.name}</p>
                    <p className="text-xs text-gray-400">{product.variation}</p>
                  </div>
                  <span className="text-sm font-black text-gray-900">Rs {product.price}</span>
                </button>
              ))}
              </div>
              <button type="button" onClick={() => setItems((previous) => [...previous, { name: 'Custom Item', price: 0, quantity: 1, variation: '' }])} className="w-full rounded-[22px] bg-black px-4 py-3 text-sm font-black text-white">
                <Plus size={16} className="mr-2 inline" />
                Add Custom Item
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
