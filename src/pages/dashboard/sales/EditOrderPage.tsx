import { Link, useParams } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Plus, Save, Search, Trash2 } from 'lucide-react';
import { fetchOrder, fetchProducts, updateOrder } from '@/lib/pos-api';
import { Product, SavedOrder } from '@/lib/pos-types';

type DraftItem = { name: string; price: number; quantity: number; variation: string };

export default function EditOrderPage() {
  const params = useParams<{ id: string }>();
  const [order, setOrder] = useState<SavedOrder | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [orderData, productData] = await Promise.all([fetchOrder(params.id), fetchProducts()]);
        setOrder(orderData);
        setItems(orderData.items);
        setProducts(productData.products);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [params.id]);

  async function saveOrder() {
    if (!order) return;
    const subtotal = items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
    const nextPaidAmount = order.status === 'completed'
      ? subtotal
      : Math.min(order.paidAmount ?? 0, subtotal);
    const nextRemainingAmount = order.status === 'completed'
      ? 0
      : Math.max(subtotal - nextPaidAmount, 0);

    const updated = await updateOrder(order.id, {
      action: 'replaceItems',
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
    });
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
    return <div className="rounded-[32px] bg-white p-8 text-sm text-rose-500 shadow-sm">Order not found.</div>;
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
              <div key={`${item.name}-${index}`} className="rounded-[24px] bg-[#F8F9FB] p-4">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px_90px_90px_50px]">
                  <input value={item.name} onChange={(event) => setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, name: event.target.value } : entry))} className="rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
                  <input value={item.variation} onChange={(event) => setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, variation: event.target.value } : entry))} className="rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
                  <input value={String(item.price)} onChange={(event) => /^\d*$/.test(event.target.value) && setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, price: Number(event.target.value || 0) } : entry))} className="rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
                  <input value={String(item.quantity)} onChange={(event) => /^\d*$/.test(event.target.value) && setItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: Number(event.target.value || 1) } : entry))} className="rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
                  <button type="button" onClick={() => setItems((previous) => previous.filter((_, itemIndex) => itemIndex !== index))} className="rounded-2xl bg-rose-50 text-rose-600">
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
