import { useMemo, useState } from 'react';
import { Pencil, Plus, Search } from 'lucide-react';
import { createProduct, updateProduct } from '@/lib/pos-api';
import { Product, ProductInput } from '@/lib/pos-types';
import { resolveProductImage } from '@/lib/food-images';

type OrderItemDraft = { name: string; price: number; quantity: number; variation: string; image?: string };

export default function AddItemsManager({
  products,
  onSaveItems,
  onProductsChanged,
}: {
  products: Product[];
  onSaveItems: (items: OrderItemDraft[]) => Promise<void> | void;
  onProductsChanged?: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<'items' | 'catalog'>('items');
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [draftItems, setDraftItems] = useState<OrderItemDraft[]>([]);
  const [customItem, setCustomItem] = useState({ name: '', price: '', quantity: '1', variation: '' });
  const [productForm, setProductForm] = useState<ProductInput>({
    name: '',
    price: 0,
    stock: 0,
    category: 'Deals',
    variation: '',
    image: '/products/family-deal.svg',
    color: 'bg-lime-50',
    description: '',
  });
  const [editingProductId, setEditingProductId] = useState<string | number | null>(null);

  const categories = ['All', ...new Set(products.map((product) => product.category))];
  const imageOptions = [
    "/products/beef-burger-combo.svg", "/products/butter-croissant.svg", "/products/chicken-tikka-pizza.svg",
    "/products/coffee-beans.svg", "/products/dark-chocolate.svg", "/products/family-deal.svg", "/products/fresh-avocado.svg",
    "/products/malai-boti-roll.svg", "/products/organic-milk.svg", "/products/red-apple.svg", "/products/sparkling-water.svg",
    "/products/whole-grain-bread.svg", "/products/zinger-shawarma.svg", "/products/mega-deal.svg", "/products/couple-deal.svg", 
    "/products/midnight-deal.svg", "/products/lunch-deal.svg", "/products/kids-meal.svg", "/products/party-deal.svg", 
    "/products/french-fries.svg", "/products/ice-cream.svg", "/products/donut.svg", "/products/hot-dog.svg", "/products/soft-drink.svg", 
    "/products/cold-coffee.svg"
  ];

  const visibleProducts = useMemo(
    () => products.filter((product) => (category === 'All' || product.category === category) && `${product.name} ${product.variation}`.toLowerCase().includes(search.toLowerCase())),
    [category, products, search],
  );

  function addDraft(item: OrderItemDraft) {
    // Matching name and variation keeps manual items and catalog products consistent in one cart bucket.
    setDraftItems((previous) => {
      const found = previous.findIndex((entry) => entry.name === item.name && entry.variation === item.variation);
      if (found === -1) return [...previous, item];
      return previous.map((entry, index) => index === found ? { ...entry, quantity: entry.quantity + item.quantity } : entry);
    });
  }

  async function saveProduct() {
    if (!productForm.name || productForm.price <= 0) {
      return;
    }

    if (editingProductId) {
      await updateProduct(editingProductId, productForm);
    } else {
      await createProduct(productForm);
    }

    await onProductsChanged?.();

    setEditingProductId(null);
    setProductForm({
      name: '',
      price: 0,
      stock: 0,
      category: 'Deals',
      variation: '',
      image: '/products/family-deal.svg',
      color: 'bg-lime-50',
      description: '',
    });
  }

  return (
    // "Items To Save" cart sits to the right of the picker from tablet
    // width (sm) up, matching POS/Sales/EditOrderPage; stacks to one
    // column below that for phone screens.
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_280px] sm:gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
      <div className="min-w-0 space-y-4">
        <div className="flex gap-2 rounded-full bg-[#F6F7FB] p-1.5">
          <button type="button" onClick={() => setTab('items')} className={`rounded-full px-4 py-2 text-sm font-black ${tab === 'items' ? 'bg-black text-white' : 'text-gray-500'}`}>Add To Order</button>
          <button type="button" onClick={() => setTab('catalog')} className={`rounded-full px-4 py-2 text-sm font-black ${tab === 'catalog' ? 'bg-black text-white' : 'text-gray-500'}`}>Manage Products</button>
        </div>

        {tab === 'items' ? (
          <>
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products" className="w-full rounded-full border border-slate-300 focus:border-slate-400 bg-[#F8F9FB] py-4 pl-12 pr-4 outline-none" />
            </div>

            <div className="flex flex-wrap gap-2">
              {categories.map((item) => <button key={item} type="button" onClick={() => setCategory(item)} className={`rounded-full px-4 py-2 text-sm font-bold ${category === item ? 'bg-black text-white' : 'bg-[#F6F7FB] text-gray-500'}`}>{item}</button>)}
            </div>

            {/* 1 column on phone - each card has a 64px image plus three
                lines of text next to it, which has no room to breathe at 3
                (or even 2) columns on a narrow screen. 2 columns once
                there's some width (sm), 3 once there's plenty (lg). */}
            <div className="grid max-h-[360px] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
              {visibleProducts.map((product) => (
                <button key={product.id} type="button" onClick={() => addDraft({ name: product.name, price: product.price, quantity: 1, variation: product.variation, image: product.image })} className="group flex items-center gap-3 rounded-[24px] border border-transparent bg-[#FAFBFC] p-3 text-left transition hover:border-[#D6E332]">
                  <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl bg-slate-100 shadow-inner">
                    <img src={resolveProductImage(product)} alt={product.name} loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-110" />
                  </div>
                  <div>
                    <p className="font-black text-gray-900">{product.name}</p>
                    <p className="text-xs text-gray-400">{product.variation}</p>
                    <p className="mt-1 text-sm font-bold text-gray-700">Rs {product.price}</p>
                  </div>
                </button>
              ))}
            </div>

            <div className="rounded-[24px] bg-[#F8F9FB] p-4">
              <p className="mb-3 text-sm font-black uppercase tracking-[0.16em] text-gray-400">Manual Item</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <input value={customItem.name} onChange={(event) => setCustomItem((previous) => ({ ...previous, name: event.target.value }))} placeholder="Item name" className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
                <input value={customItem.variation} onChange={(event) => setCustomItem((previous) => ({ ...previous, variation: event.target.value }))} placeholder="Variation / size" className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
                <input value={customItem.price} onChange={(event) => /^\d*$/.test(event.target.value) && setCustomItem((previous) => ({ ...previous, price: event.target.value }))} placeholder="Price" className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
                <input value={customItem.quantity} onChange={(event) => /^\d*$/.test(event.target.value) && setCustomItem((previous) => ({ ...previous, quantity: event.target.value }))} placeholder="Quantity" className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!customItem.name || !customItem.price) return;
                  addDraft({ name: customItem.name, price: Number(customItem.price), quantity: Number(customItem.quantity || 1), variation: customItem.variation });
                  setCustomItem({ name: '', price: '', quantity: '1', variation: '' });
                }}
                className="mt-3 rounded-full bg-black px-4 py-2 text-sm font-black text-white"
              >
                <Plus size={14} className="mr-2 inline" />
                Add Manual Item
              </button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={productForm.name} onChange={(event) => setProductForm((previous) => ({ ...previous, name: event.target.value }))} placeholder="Product name" className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
              <input value={productForm.variation} onChange={(event) => setProductForm((previous) => ({ ...previous, variation: event.target.value }))} placeholder="Variation" className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
              <input value={productForm.price || ''} onChange={(event) => /^\d*$/.test(event.target.value) && setProductForm((previous) => ({ ...previous, price: Number(event.target.value || 0) }))} placeholder="Price" className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
              <input value={productForm.stock || ''} onChange={(event) => /^\d*$/.test(event.target.value) && setProductForm((previous) => ({ ...previous, stock: Number(event.target.value || 0) }))} placeholder="Stock" className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
              <input value={productForm.category} onChange={(event) => setProductForm((previous) => ({ ...previous, category: event.target.value }))} placeholder="Category" className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
              <select value={productForm.image} onChange={(event) => setProductForm((previous) => ({ ...previous, image: event.target.value }))} className="rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none">
                {imageOptions.map((option) => <option key={option} value={option}>{option.split('/').pop()}</option>)}
              </select>
            </div>
            <textarea value={productForm.description} onChange={(event) => setProductForm((previous) => ({ ...previous, description: event.target.value }))} placeholder="Description" className="min-h-24 w-full rounded-2xl border border-slate-300 focus:border-slate-400 px-4 py-3 outline-none" />
            <button type="button" onClick={() => void saveProduct()} className="rounded-full bg-[#E2F33C] px-4 py-2 text-sm font-black text-black">
              {editingProductId ? 'Update Product' : 'Create Product'}
            </button>

            <div className="space-y-2">
              {products.map((product) => (
                <div key={product.id} className="flex items-center gap-3 rounded-[20px] bg-[#F8F9FB] px-4 py-3">
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-slate-200">
                    <img src={resolveProductImage(product)} alt={product.name} className="h-full w-full object-cover" loading="lazy" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold text-gray-900">{product.name}</p>
                    <p className="text-xs text-gray-400">{product.category} • Rs {product.price}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingProductId(product.id);
                      setProductForm({
                        name: product.name,
                        price: product.price,
                        stock: product.stock,
                        category: product.category,
                        variation: product.variation,
                        image: product.image,
                        color: product.color,
                        description: product.description,
                      });
                    }}
                    className="rounded-full bg-white p-2 text-gray-500"
                  >
                    <Pencil size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="min-w-0 rounded-[28px] bg-[#F8F9FB] p-4">
        <h3 className="mb-4 text-sm font-black uppercase tracking-[0.18em] text-gray-400">Items To Save</h3>
        <div className="space-y-3">
          {draftItems.length === 0 ? <p className="text-sm text-gray-500">Choose products or create a manual item.</p> : null}
          {draftItems.map((item, index) => (
            <div key={`${item.name}-${item.variation}-${index}`} className="rounded-[22px] bg-white p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-slate-200">
                    <img src={resolveProductImage({ image: item.image, name: item.name })} alt={item.name} className="h-full w-full object-cover" loading="lazy" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-bold text-gray-900">{item.name}</p>
                    <p className="text-xs text-gray-400">{item.variation || 'No variation'}</p>
                  </div>
                </div>
                <p className="shrink-0 text-sm font-black text-gray-900">Rs {item.price * item.quantity}</p>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <div className="flex items-center gap-2 rounded-full bg-[#F6F7FB] p-1">
                  <button type="button" onClick={() => setDraftItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: Math.max(1, entry.quantity - 1) } : entry))} className="rounded-full p-2 text-gray-500 hover:bg-white">-</button>
                  <span className="min-w-6 text-center text-sm font-black">{item.quantity}</span>
                  <button type="button" onClick={() => setDraftItems((previous) => previous.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: entry.quantity + 1 } : entry))} className="rounded-full p-2 text-gray-500 hover:bg-white">+</button>
                </div>
                <button type="button" onClick={() => setDraftItems((previous) => previous.filter((_, itemIndex) => itemIndex !== index))} className="text-xs font-bold text-rose-500">Remove</button>
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => void onSaveItems(draftItems)} className="mt-4 w-full rounded-[20px] bg-black px-4 py-3 text-sm font-black text-white">
          Save Added Items
        </button>
      </div>
    </div>
  );
}
