
import { useEffect, useMemo, useState } from "react";
import { Plus, Package, Edit, Archive, X, Trash2, ListChecks, Search, ChevronDown, ChevronRight } from "lucide-react";
import { createProduct, deleteProduct, fetchProducts, updateProduct } from "@/lib/pos-api";
import { Product } from "@/lib/pos-types";
import { useToast } from "@/lib/toast";
import { getProductImageUrl } from "@/lib/asset-path";
import { resolveProductImage } from "@/lib/food-images";

// Products that share the same name+category are different "variations" of
// the same menu item (e.g. Pizza Small/Medium/Large are 3 separate Product
// documents). The directory list groups them into one row per item, with
// variations expandable underneath - mirrors the grouping used on the POS
// screen so editing matches what staff see when ringing up an order.
type ProductGroup = {
  key: string;
  name: string;
  category: string;
  image?: string;
  isDeal: boolean;
  variations: Product[];
};

const AVAILABLE_ICONS = [
  "beef-burger-combo.svg", "butter-croissant.svg", "chicken-tikka-pizza.svg",
  "coffee-beans.svg", "dark-chocolate.svg", "family-deal.svg", "fresh-avocado.svg",
  "malai-boti-roll.svg", "organic-milk.svg", "red-apple.svg", "sparkling-water.svg",
  "whole-grain-bread.svg", "zinger-shawarma.svg", "mega-deal.svg", "couple-deal.svg",
  "midnight-deal.svg", "lunch-deal.svg", "kids-meal.svg", "party-deal.svg",
  "french-fries.svg", "ice-cream.svg", "donut.svg", "hot-dog.svg", "soft-drink.svg",
  "cold-coffee.svg",
  // Added for pizza/desi-menu items (pizza slice, paratha roll, etc.)
  "pizza-slice.svg", "paratha-roll.svg", "chicken-roll.svg", "biryani.svg",
  "chai-tea.svg", "samosa.svg", "sandwich.svg", "nuggets.svg", "chicken-wings.svg"
];

export function ProductManagementSection({
  title = "Manage Products",
  description = "Add or update products, deals, categories, icons, prices, and quantities.",
  cardClassName = "rounded-[28px] border border-slate-200 bg-white p-6",
}: {
  title?: string;
  description?: string;
  cardClassName?: string;
}) {
  const { confirm, popup } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  // Success confirmations only now - every error (validation or otherwise)
  // routes through the shared popup() from useToast instead, so it's never
  // missed as a quiet inline banner above the fold.
  const [statusMessage, setStatusMessage] = useState<{ tone: "success"; text: string } | null>(null);

  // General Form states
  const [formType, setFormType] = useState<"Product" | "Deal">("Product");
  const [editingId, setEditingId] = useState<string | number | null>(null);
  // Editing an entire product GROUP at once (name/category/image shared by
  // every variation, plus each variation's own name/price/qty) - distinct
  // from editingId above, which only ever edits ONE Product document (one
  // size/variation). Triggered by the Edit button on a multi-variation
  // group's main row (see handleEditGroupClick) - editingId stays null the
  // whole time, since there's no single product id this represents.
  const [isEditingGroup, setIsEditingGroup] = useState(false);
  // The real backend ids of the group's variations at the moment editing
  // started - used at save time to tell "this row already exists, update
  // it" apart from "this is a newly added row, create it", and to know
  // which ones were removed from the list entirely (deleted).
  const [originalGroupVariationIds, setOriginalGroupVariationIds] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [category, setCategory] = useState("");
  const [image, setImage] = useState("");
  const [variation, setVariation] = useState("Standard");
  // Product Code / SKU: optional, typed or barcode-scanned on the POS
  // screen to instantly add this exact product/deal to the cart - see
  // POSPage.tsx's product-code entry box. Used here for a single
  // (non-variation) product or a Deal; a multi-variation product sets its
  // own code per size/flavour below instead (variationsData's own
  // productCode), since each size is really a separate SKU.
  const [productCode, setProductCode] = useState("");

  // Variations states (Products only) - defaults ON, see resetForm() below.
  const [hasVariations, setHasVariations] = useState(true);
  const [variationsData, setVariationsData] = useState<Array<{ id: string; name: string; price: string; qty: string; productCode: string }>>([
    { id: "1", name: "", price: "", qty: "", productCode: "" },
  ]);

  // Deals states
  const [dealItems, setDealItems] = useState<string[]>([]);
  // Filters the "Select Items for this Deal" checkbox grid below - with
  // 100+ products in the full catalog, scrolling to find one by eye was
  // the actual complaint, so this is purely a client-side name/category
  // filter over the same `products` list already in memory.
  const [dealItemSearch, setDealItemSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  useEffect(() => {
    void loadProducts(debouncedSearch);
  }, [debouncedSearch]);

  async function loadProducts(search?: string) {
    try {
      setIsLoading(true);
      const result = await fetchProducts(search);
      setProducts(result?.products || []);
      if (!search) {
        setCategories(result?.categories || ["Burgers", "Drinks", "Deals", "Sides", "Pizzas"]);
      }
    } catch (error) {
      popup({ tone: "error", title: "Couldn't load products", message: error instanceof Error ? error.message : "Failed to load products." });
    } finally {
      setIsLoading(false);
    }
  }

  function resetForm() {
    setEditingId(null);
    setIsEditingGroup(false);
    setOriginalGroupVariationIds(new Set());
    setName("");
    setPrice("");
    setQty("");
    setCategory("");
    setImage("");
    setFormType("Product");
    setVariation("Standard");
    setProductCode("");
    // Defaults to ON for a brand new product - most menu items (pizzas,
    // burgers, etc.) come in more than one size, so leading with the
    // Small/Medium/Large rows front-and-center is the common case. A
    // single-price item (like a canned drink) is still just one unchecked
    // click away.
    setHasVariations(true);
    setVariationsData([{ id: Date.now().toString(), name: "", price: "", qty: "", productCode: "" }]);
    setDealItems([]);
  }

  // One-tap presets for the most common size/flavour patterns - replaces
  // whatever rows are currently in the variations list so picking a preset
  // twice doesn't pile up duplicates.
  function applySizePreset(names: string[]) {
    setHasVariations(true);
    setVariationsData(names.map((n, i) => ({ id: `${Date.now()}-${i}`, name: n, price: "", qty: "", productCode: "" })));
  }

  function getBasePayload() {
    return {
      name: name.trim(),
      category: formType === "Deal" ? "Deals" : category.trim(),
      image: image,
      color: "bg-indigo-500",
      description: formType === "Deal" ? "Special Combo Deal" : "",
      isDeal: formType === "Deal",
      dealItems: formType === "Deal" ? dealItems : [],
    };
  }

  async function handleSaveProduct() {
    if (!name.trim()) {
      popup({ tone: "error", title: "Missing information", message: "Name is required." });
      return;
    }

    if (formType === "Product" && !category.trim()) {
      popup({ tone: "error", title: "Missing information", message: "Category is required." });
      return;
    }

    if (!editingId && !hasVariations && !price) {
      popup({ tone: "error", title: "Missing information", message: "Price is required." });
      return;
    }

    if (editingId && !price) {
      popup({ tone: "error", title: "Missing information", message: "Price is required." });
      return;
    }

    if (formType === "Deal" && dealItems.length === 0) {
      popup({ tone: "error", title: "Missing information", message: "Deals must include at least one item." });
      return;
    }

    if (formType === "Product" && !editingId && hasVariations) {
      if (variationsData.length === 0) {
        popup({ tone: "error", title: "Missing information", message: "Please add at least one variation, or uncheck the variations option." });
        return;
      }
      for (const v of variationsData) {
        if (!v.name.trim()) {
           popup({ tone: "error", title: "Missing information", message: "Variation name is required for all variations." });
           return;
        }
        if (!v.price) {
           popup({ tone: "error", title: "Missing information", message: `Price is required for variation "${v.name}".` });
           return;
        }
      }
    }

    try {
      setIsSaving(true);

      if (isEditingGroup) {
        // Full group edit - reconciles the form's variationsData rows
        // against what the group originally had: a row whose id is one of
        // originalGroupVariationIds is an existing Product document, so it
        // gets updateProduct'd (carrying the possibly-changed shared
        // name/category/image plus its own price/stock/variation name); a
        // row with any other id was added via "Add Pattern" just now, so
        // it gets createProduct'd; anything from the original set that's
        // no longer present in the list was removed via the row's Trash2
        // button, so it gets deleted for real.
        const basePayload = getBasePayload();
        const keptIds = new Set<string>();
        const savedProducts: Product[] = [];

        for (const v of variationsData) {
          const variationName = v.name.trim();
          const payload = {
            ...basePayload,
            price: Number(v.price),
            stock: v.qty ? Number(v.qty) : 0,
            variation: variationName,
            productCode: v.productCode.trim(),
          };
          if (originalGroupVariationIds.has(v.id)) {
            keptIds.add(v.id);
            const updated = await updateProduct(v.id, payload);
            if (updated) savedProducts.push(updated);
          } else {
            const created = await createProduct(payload);
            if (created) savedProducts.push(created);
          }
        }

        const removedIds = [...originalGroupVariationIds].filter((id) => !keptIds.has(id));
        for (const id of removedIds) {
          await deleteProduct(id);
        }

        setProducts((prev) => [
          ...prev.filter((p) => !originalGroupVariationIds.has(String(p.id))),
          ...savedProducts,
        ]);
        setStatusMessage({ tone: "success", text: `"${name}" updated successfully.` });
        resetForm();
      } else if (editingId) {
        const payload = {
          ...getBasePayload(),
          price: Number(price),
          stock: qty ? Number(qty) : 0,
          variation: formType === "Deal" ? "Deal" : variation,
          productCode: productCode.trim(),
        };
        const updated = await updateProduct(editingId, payload);
        if (updated) {
          setProducts((prev) => prev.map((p) => (p.id === editingId ? updated : p)));
          setStatusMessage({ tone: "success", text: `${formType} "${updated.name}" updated successfully.` });
          resetForm();
        }
      } else {
        if (formType === "Product" && hasVariations) {
          const newProducts: Product[] = [];
          
          for (const v of variationsData) {
             const variationName = v.name.trim();
             const payload = {
               ...getBasePayload(),
               price: Number(v.price),
               stock: v.qty ? Number(v.qty) : 0,
               variation: variationName,
               productCode: v.productCode.trim(),
             };
             const created = await createProduct(payload);
             if (created) newProducts.push(created);
          }
          
          setProducts((prev) => [...prev, ...newProducts]);
          setStatusMessage({ tone: "success", text: `${newProducts.length} variants of "${name}" added successfully.` });
          resetForm();
        } else {
          const payload = {
            ...getBasePayload(),
            price: Number(price),
            stock: qty ? Number(qty) : 0,
            variation: formType === "Deal" ? "Deal" : "Standard",
            productCode: productCode.trim(),
          };
          const created = await createProduct(payload);
          if (created) {
            setProducts((prev) => [...prev, created]);
            setStatusMessage({ tone: "success", text: `${formType} "${created.name}" added successfully.` });
            resetForm();
          }
        }
      }
    } catch (error) {
      popup({ tone: "error", title: "Couldn't save", message: error instanceof Error ? error.message : "Failed to save product." });
    } finally {
      setIsSaving(false);
    }
  }

  function handleEditClick(product: Product) {
    setEditingId(product.id);
    setIsEditingGroup(false);
    setOriginalGroupVariationIds(new Set());
    setName(product.name);
    setPrice(product.price.toString());
    setQty(product.stock > 0 ? product.stock.toString() : "");
    setImage(product.image || "");
    setProductCode(product.productCode || "");

    const editingDeal = product.isDeal || product.variation?.includes("Deal") || product.description?.includes("Deal") || product.category === "Deals";
    
    if (editingDeal) {
      setFormType("Deal");
      setCategory("Deals");
      setDealItems(product.dealItems || []);
      setHasVariations(false);
    } else {
      setFormType("Product");
      setCategory(product.category);
      setHasVariations(false);
    }
    
    setVariation(product.variation || "Standard");
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleDeleteVariation(product: Product) {
    const label = product.variation && product.variation !== "Standard" ? `${product.name} (${product.variation})` : product.name;
    const confirmed = await confirm(`Delete "${label}"? This cannot be undone.`, {
      title: "Delete product",
      confirmText: "Delete",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteProduct(product.id);
      setProducts((prev) => prev.filter((p) => p.id !== product.id));
      setStatusMessage({ tone: "success", text: `"${label}" deleted.` });
      if (editingId === product.id) {
        resetForm();
      }
    } catch (error) {
      popup({ tone: "error", title: "Couldn't delete", message: error instanceof Error ? error.message : "Failed to delete product." });
    }
  }

  // Full edit of an entire product group at once - the name/category/icon
  // shared by every variation, plus each variation's own name/price/stock,
  // all in the same form used to add a brand new product (same "Add
  // Pattern"/remove-row/preset controls). See isEditingGroup's own comment
  // above for how this differs from handleEditClick (which only ever edits
  // one variation/Product document at a time).
  function handleEditGroupClick(group: ProductGroup) {
    resetForm();
    setFormType(group.isDeal ? "Deal" : "Product");
    setIsEditingGroup(true);
    setName(group.name);
    setCategory(group.category);
    setImage(group.image || "");
    setHasVariations(true);
    setOriginalGroupVariationIds(new Set(group.variations.map((v) => String(v.id))));
    setVariationsData(
      group.variations.map((v) => ({
        id: String(v.id),
        name: v.variation && v.variation !== "Standard" ? v.variation : "Standard",
        price: v.price.toString(),
        qty: v.stock > 0 ? v.stock.toString() : "",
        productCode: v.productCode || "",
      }))
    );
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Prefills the top form to add another variation to an existing product
  // group (e.g. adding "Large" to a Pizza that currently only has Small/Medium).
  function handleAddVariationClick(group: ProductGroup) {
    resetForm();
    setFormType("Product");
    setName(group.name);
    setCategory(group.category);
    setImage(group.image || "");
    setHasVariations(true);
    setVariationsData([{ id: Date.now().toString(), name: "", price: "", qty: "", productCode: "" }]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Same idea as handleAddVariationClick, but triggered from inside the Edit
  // Product form itself (the "Add Pattern" button next to Variation Name) -
  // reuses whatever name/category/icon are currently on screen instead of
  // needing a ProductGroup, since we're already editing one of its variations.
  function handleAddVariationFromEdit() {
    const groupName = name;
    const groupCategory = category;
    const groupImage = image;
    resetForm();
    setFormType("Product");
    setName(groupName);
    setCategory(groupCategory);
    setImage(groupImage);
    setHasVariations(true);
    setVariationsData([{ id: Date.now().toString(), name: "", price: "", qty: "", productCode: "" }]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const directoryProducts = useMemo(
    () =>
      products.filter((p) =>
        formType === "Deal"
          ? p.isDeal || p.category.toLowerCase().includes("deal")
          : !p.isDeal && !p.category.toLowerCase().includes("deal")
      ),
    [products, formType]
  );

  const directoryGroups = useMemo<ProductGroup[]>(() => {
    const map = new Map<string, ProductGroup>();
    const order: string[] = [];
    // Reversed so the oldest-created item of each group appears first,
    // matching the previous (ungrouped) directory ordering.
    for (const p of [...directoryProducts].reverse()) {
      const key = p.isDeal ? `deal:${p.id}` : `${p.category}::${p.name}`;
      let group = map.get(key);
      if (!group) {
        group = { key, name: p.name, category: p.category, image: p.image, isDeal: !!p.isDeal, variations: [] };
        map.set(key, group);
        order.push(key);
      }
      group.variations.push(p);
    }
    return order.map((key) => map.get(key)!);
  }, [directoryProducts]);

  return (
    <div className={cardClassName}>
      <div className="flex items-center gap-2 mb-4">
        <Package size={18} className="text-indigo-600" />
        <h3 className="text-lg font-black text-slate-900">{title}</h3>
      </div>
      <p className="max-w-2xl text-sm text-slate-500 mb-6">{description}</p>

      {statusMessage ? (
        <div className="mb-5 flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {statusMessage.text}
          <button onClick={() => setStatusMessage(null)} className="font-bold opacity-70 hover:opacity-100">×</button>
        </div>
      ) : null}

      <div className="rounded-[32px] border border-slate-100 bg-slate-50 p-6 space-y-6 shadow-sm">
        
        {/* Toggle Form Type */}
        {!editingId && !isEditingGroup && (
          <div className="flex bg-slate-200/40 p-1.5 rounded-[20px] mb-2">
            <button
              type="button"
              onClick={() => { setFormType("Product"); setHasVariations(true); }}
              className={`flex-1 py-3 px-4 rounded-2xl text-sm transition-all ${formType === "Product" ? "bg-white text-indigo-700 font-black shadow-sm" : "text-slate-500 font-bold hover:text-slate-900 hover:bg-slate-200/50"}`}>
              Add Product
            </button>
            <button
              type="button" 
              onClick={() => { setFormType("Deal"); setHasVariations(false); }} 
              className={`flex-1 py-3 px-4 rounded-2xl text-sm transition-all ${formType === "Deal" ? "bg-white text-indigo-700 font-black shadow-sm" : "text-slate-500 font-bold hover:text-slate-900 hover:bg-slate-200/50"}`}>
              Create Deal
            </button>
          </div>
        )}

        {(editingId || isEditingGroup) && (
          <h4 className="text-sm font-black uppercase text-indigo-600 tracking-wider flex items-center gap-2 border-b border-indigo-100 pb-3">
            <Edit size={16} /> {isEditingGroup ? `Edit ${formType} (all variations)` : `Edit ${formType}`}
          </h4>
        )}
        
        {/* Category comes first on purpose - it's the top of the hierarchy
            (Category -> Sub Category/Item -> Sizes) a menu naturally follows,
            e.g. "Pizza" -> "Behari Kabab" -> Small/Medium/Large. Existing
            categories are one tap away as chips so building out a menu
            doesn't mean retyping "Pizza" for every single item. */}
        {formType === "Product" && (
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Category</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              list="categories-list"
              placeholder="e.g. Pizza"
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
            />
            <datalist id="categories-list">
              {categories.map((c, i) => (
                <option key={i} value={c} />
              ))}
            </datalist>
            {categories.filter((c) => c !== "All").length > 0 ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {categories.filter((c) => c !== "All").map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`rounded-full px-3.5 py-1.5 text-[11px] font-black transition-all ${category === c ? "bg-indigo-600 text-white shadow-sm" : "bg-white text-slate-500 ring-1 ring-slate-200 hover:ring-indigo-300 hover:text-indigo-600"}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">
              {formType === "Deal" ? "Deal Name" : "Sub Category (Item Name)"}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={formType === "Deal" ? "e.g. Family Feast Combo" : "e.g. Behari Kabab"}
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
            />
            {formType === "Product" ? (
              <p className="text-[10px] font-bold text-slate-400 ml-1">This is what shows as its own card under "{category || "Category"}" - add its sizes/flavours below.</p>
            ) : null}
          </div>
        </div>

        {formType === "Deal" && (
           <div className="space-y-2">
             <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1 flex items-center gap-2"><ListChecks size={14} /> Select Items for this Deal {dealItems.length > 0 ? <span className="text-indigo-500">({dealItems.length} selected)</span> : null}</label>
             <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                <input
                   value={dealItemSearch}
                   onChange={(event) => setDealItemSearch(event.target.value)}
                   placeholder="Search products to add..."
                   className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-11 pr-4 text-sm font-semibold outline-none focus:border-indigo-400"
                />
             </div>
             <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[280px] overflow-y-auto p-4 bg-slate-100/50 rounded-3xl ring-1 ring-slate-200 inset-shadow-sm">
                {products
                  .filter(p => !p.isDeal && !p.category.toLowerCase().includes("deal"))
                  .filter(p => {
                     const q = dealItemSearch.trim().toLowerCase();
                     if (!q) return true;
                     return p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || (p.variation || "").toLowerCase().includes(q);
                  })
                  .map(p => {
                   const isSelected = dealItems.includes(String(p.id));
                   return (
                     <label key={p.id} className={`flex items-start gap-4 p-4 rounded-[20px] cursor-pointer transition-all ${isSelected ? 'bg-indigo-600 ring-2 ring-indigo-600 shadow-inner text-white' : 'bg-white ring-1 ring-slate-200 hover:ring-indigo-300 text-slate-700'}`}>
                        <input 
                           type="checkbox"
                           className="mt-0.5 w-5 h-5 rounded accent-indigo-500"
                           checked={isSelected}
                           onChange={(e) => {
                              if (e.target.checked) setDealItems([...dealItems, String(p.id)]);
                              else setDealItems(dealItems.filter(id => id !== String(p.id)));
                           }}
                        />
                        <div className="flex-1 mt-0.5">
                           <div className={`text-sm font-black ${isSelected ? 'text-white' : 'text-slate-900'}`}>{p.name} {p.variation && p.variation !== "Standard" ? <span className="opacity-70 font-bold ml-1">({p.variation})</span> : ""}</div>
                           <div className={`text-xs font-bold mt-1 ${isSelected ? 'text-indigo-200' : 'text-slate-400'}`}>PKR {p.price}</div>
                        </div>
                     </label>
                   )
                })}
             </div>
           </div>
        )}

        {/* Global Price & Qty for single product or deal */}
        {(formType === "Deal" || (!hasVariations || editingId)) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-2">
            <div className="space-y-2">
              <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{formType === "Deal" ? "Total Deal Price" : "Price"}</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 font-black text-[14px]">PKR</span>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white pl-12 pr-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Quantity / Stock (Optional)</label>
              <input
                type="number"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="Unlimited if empty"
                className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Product Code / SKU (Optional)</label>
              <input
                type="text"
                value={productCode}
                onChange={(e) => setProductCode(e.target.value)}
                placeholder="Type or scan a barcode - lets staff add this instantly on the POS screen"
                className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
              />
            </div>
            {formType === "Product" && editingId && (
              <div className="space-y-2 md:col-span-2">
                <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Variation Name</label>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    value={variation}
                    onChange={(e) => setVariation(e.target.value)}
                    placeholder="e.g. Small, Medium, Large (or Standard for a single-size item)"
                    className="flex-1 min-w-[200px] rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                  />
                  <button
                    type="button"
                    onClick={handleAddVariationFromEdit}
                    title="Add another variation to this product"
                    className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wider font-black text-indigo-700 bg-indigo-100 hover:bg-indigo-200 px-5 py-3.5 rounded-2xl transition-colors shadow-sm shrink-0"
                  >
                    <Plus size={14} /> Add Pattern
                  </button>
                </div>
                <p className="text-[10px] font-bold text-slate-400 ml-1">Adds a brand new size/variation to this same product (e.g. add "Large" to an existing Pizza).</p>
              </div>
            )}
          </div>
        )}

        {/* Variations UI Only For Products */}
        {formType === "Product" && !editingId && (
          <div className="pt-2">
            <label className="flex items-center gap-3 cursor-pointer mb-4 p-4 rounded-2xl bg-white ring-1 ring-slate-200 hover:bg-slate-50 transition-colors">
              <input
                type="checkbox"
                checked={hasVariations}
                onChange={(e) => {
                  setHasVariations(e.target.checked);
                  if (e.target.checked) setPrice("");
                }}
                className="w-5 h-5 text-indigo-600 rounded accent-indigo-600"
              />
              <div className="flex flex-col">
                <span className="text-sm font-black text-slate-800">Add sizes / flavours</span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-0.5">e.g. Small, Medium, Large - each with its own price</span>
              </div>
            </label>

            {hasVariations && (
              <div className="space-y-3 pl-6 border-l-2 border-indigo-100 py-2">
                <div className="flex flex-wrap items-center gap-2 pb-1">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Quick fill:</span>
                  <button type="button" onClick={() => applySizePreset(["Small", "Medium", "Large"])} className="rounded-full bg-slate-100 hover:bg-indigo-100 hover:text-indigo-700 px-3 py-1.5 text-[11px] font-black text-slate-600 transition-colors">
                    Small / Medium / Large
                  </button>
                  <button type="button" onClick={() => applySizePreset(["Small", "Medium", "Large", "X-Large"])} className="rounded-full bg-slate-100 hover:bg-indigo-100 hover:text-indigo-700 px-3 py-1.5 text-[11px] font-black text-slate-600 transition-colors">
                    + X-Large
                  </button>
                  <button type="button" onClick={() => applySizePreset(["Half", "Full"])} className="rounded-full bg-slate-100 hover:bg-indigo-100 hover:text-indigo-700 px-3 py-1.5 text-[11px] font-black text-slate-600 transition-colors">
                    Half / Full
                  </button>
                </div>
                {variationsData.map((v, i) => (
                  <div key={v.id} className="flex flex-wrap items-center gap-3 bg-white p-3 rounded-2xl ring-1 ring-slate-200 shadow-sm relative group">
                    <div className="flex-1 min-w-[150px]">
                      <input 
                        type="text" 
                        placeholder="Size / Flavour Name (e.g. Small)"
                        value={v.name} 
                        onChange={(e) => {
                          const newVars = [...variationsData];
                          newVars[i].name = e.target.value;
                          setVariationsData(newVars);
                        }} 
                        className="w-full rounded-[14px] border border-slate-200 px-4 py-2.5 text-sm font-bold outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all" 
                      />
                    </div>
                    <div className="relative w-28">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300 font-bold text-[10px]">PKR</span>
                      <input 
                        type="number" 
                        placeholder="Price" 
                        value={v.price} 
                        onChange={(e) => {
                          const newVars = [...variationsData];
                          newVars[i].price = e.target.value;
                          setVariationsData(newVars);
                        }} 
                        className="w-full rounded-[14px] border border-slate-200 pl-9 pr-2 py-2.5 text-sm font-bold outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all" 
                      />
                    </div>
                    <div className="w-24">
                      <input
                        type="number"
                        placeholder="Qty"
                        value={v.qty}
                        onChange={(e) => {
                          const newVars = [...variationsData];
                          newVars[i].qty = e.target.value;
                          setVariationsData(newVars);
                        }}
                        className="w-full rounded-[14px] border border-slate-200 px-3 py-2.5 text-sm font-bold outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all"
                      />
                    </div>
                    <div className="w-36">
                      <input
                        type="text"
                        placeholder="Product Code / SKU"
                        value={v.productCode}
                        onChange={(e) => {
                          const newVars = [...variationsData];
                          newVars[i].productCode = e.target.value;
                          setVariationsData(newVars);
                        }}
                        className="w-full rounded-[14px] border border-slate-200 px-3 py-2.5 text-sm font-bold outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all"
                      />
                    </div>
                    {variationsData.length > 1 && (
                      <button 
                        type="button"
                        onClick={() => {
                          setVariationsData(variationsData.filter(item => item.id !== v.id));
                        }}
                        className="p-2.5 text-rose-400 hover:text-white hover:bg-rose-500 rounded-[12px] transition-colors shadow-sm"
                        title="Remove Variation"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                ))}
                
                <button
                  type="button"
                  onClick={() => {
                    setVariationsData([...variationsData, { id: Date.now().toString(), name: "", price: "", qty: "", productCode: "" }]);
                  }}
                  className="mt-3 inline-flex items-center gap-2 text-[11px] uppercase tracking-wider font-black text-indigo-700 bg-indigo-100 hover:bg-indigo-200 px-5 py-3 rounded-[16px] transition-colors shadow-sm"
                >
                  <Plus size={14} /> Add Pattern
                </button>
              </div>
            )}
          </div>
        )}

        {/* Visual SVGs Selection */}
        <div className="pt-2">
          <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1 block mb-3">Display Icon</label>
          <div className="flex items-center gap-3 overflow-x-auto pb-4 pt-1 px-1 snap-x no-scrollbar">
             <button 
               type="button" 
               onClick={() => setImage("")} 
               className={`shrink-0 w-[72px] h-[72px] rounded-[24px] border-2 flex items-center justify-center transition-all snap-start ${image === "" ? "border-indigo-500 bg-indigo-50 text-indigo-600 shadow-sm" : "border-slate-200 bg-white text-slate-400 hover:border-indigo-300 hover:text-indigo-400 shadow-sm"}`}
             >
               <Package size={26} strokeWidth={2.5}/>
             </button>
             {AVAILABLE_ICONS.map(icon => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => setImage(icon)}
                  className={`shrink-0 w-[72px] h-[72px] rounded-[24px] border-2 flex flex-col items-center justify-center transition-all snap-start overflow-hidden bg-white hover:-translate-y-1 ${image === icon ? "border-indigo-500 shadow-inner ring-4 ring-indigo-50" : "border-slate-200 hover:border-indigo-300 shadow-sm"}`}
                >
                   <img src={getProductImageUrl(icon)} alt={icon} className="w-9 h-9 object-contain drop-shadow-sm" />
                </button>
             ))}
          </div>
        </div>

        <div className="pt-6 border-t border-slate-200 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSaveProduct()}
            disabled={isSaving}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-2xl border-[0.5px] border-white/30 bg-indigo-600 px-8 py-4 text-sm font-black text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-3px_7px_rgba(49,46,129,0.5)] transition-all hover:-translate-y-0.5"
          >
            {(editingId || isEditingGroup) ? <Edit size={16} /> : <Plus size={16} />}
            {isSaving ? "Saving..." : ((editingId || isEditingGroup) ? `Update ${formType}` : `Publish ${formType}`)}
          </button>

          {(editingId || isEditingGroup) && (
            <button
              type="button"
              onClick={resetForm}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-200 px-6 py-4 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm"
            >
              <X size={16} />
              Cancel Edit
            </button>
          )}
        </div>
      </div>

      <div className="mt-10 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3">
          <h4 className="text-xs font-black uppercase text-slate-400 tracking-wider flex items-center gap-2">
             <Package size={14} /> {formType === "Deal" ? "Deals Directory" : "Products Directory"} ({directoryGroups.length})
          </h4>
          <div className="relative w-full sm:w-64">
             <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
               <Search size={16} />
             </span>
             <input
               type="text"
               placeholder="Search products..."
               value={searchQuery}
               onChange={(e) => setSearchQuery(e.target.value)}
               className="w-full rounded-[14px] border border-slate-200 bg-white pl-9 pr-4 py-2 text-sm font-bold outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all shadow-sm"
             />
          </div>
        </div>
        {isLoading ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 animate-pulse border border-slate-100">Syncing products...</div> : null}
        {!isLoading && directoryGroups.length === 0 ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 border border-slate-100">No products configured yet.</div> : null}

        <div className="flex flex-col gap-3">
          {!isLoading ? directoryGroups.map((group) => {
            const hasMultiple = group.variations.length > 1;
            const isExpanded = expandedGroups.has(group.key);
            const totalStock = group.variations.reduce((sum, v) => sum + (v.stock || 0), 0);
            const prices = group.variations.map((v) => v.price);
            const minPrice = Math.min(...prices);
            const maxPrice = Math.max(...prices);
            const single = group.variations[0];

            return (
              <div key={group.key} className="rounded-[24px] border border-slate-100 bg-white shadow-sm hover:border-indigo-100 hover:shadow-md transition-all group overflow-hidden">
                <div className="flex items-center justify-between p-4 gap-4">
                  <button
                    type="button"
                    onClick={() => hasMultiple && toggleGroup(group.key)}
                    className={`flex items-center gap-4 flex-1 min-w-0 text-left ${hasMultiple ? "cursor-pointer" : "cursor-default"}`}
                  >
                    {hasMultiple ? (
                      <span className="text-slate-400 shrink-0">
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </span>
                    ) : null}
                    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[20px] border border-slate-100 bg-slate-50">
                      <img
                        src={resolveProductImage({ image: group.image, name: group.name, category: group.category })}
                        alt={group.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[15px] font-black text-slate-900 flex items-center gap-2 flex-wrap">
                        {group.name}
                        {hasMultiple ? (
                          <span className="bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-lg text-[10px] uppercase font-black tracking-wider">
                            {group.variations.length} variations
                          </span>
                        ) : (!group.isDeal && single.variation && single.variation !== "Standard" ? (
                          <span className="text-slate-400 font-bold">({single.variation})</span>
                        ) : null)}
                        {group.isDeal && <span className="bg-rose-100 text-rose-600 px-2 py-0.5 rounded-lg text-[10px] uppercase font-black tracking-wider shadow-sm">Deal Bundle</span>}
                      </div>
                      <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest mt-1">
                        {group.category}
                      </p>
                      {group.isDeal && single.dealItems && single.dealItems.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {single.dealItems.map((dealItemId) => {
                            const subItem = products.find(p => String(p.id) === String(dealItemId));
                            if (!subItem) return null;
                            return (
                               <span key={dealItemId} className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-500 bg-slate-100 rounded-md px-2 py-1">
                                 <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 opacity-60"></div>
                                 {subItem.name} {subItem.variation && subItem.variation !== 'Standard' ? `(${subItem.variation})` : ''}
                               </span>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </button>
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="flex flex-col items-end">
                      <div className="text-[15px] font-black text-slate-900">
                        {hasMultiple ? (minPrice === maxPrice ? `PKR ${minPrice}` : `PKR ${minPrice} - ${maxPrice}`) : `PKR ${single.price}`}
                      </div>
                      <div className="flex items-center gap-1 mt-1 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        <Archive size={10} />
                        <span>{totalStock > 0 ? `${totalStock} in stock` : "Unlimited"}</span>
                      </div>
                    </div>
                    {hasMultiple ? (
                      !group.isDeal && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleEditGroupClick(group)}
                            title="Edit this product (name, image, category, and all its variations)"
                            className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-100 rounded-xl transition-all shadow-sm"
                          >
                            <Edit size={16} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddVariationClick(group)}
                            title="Add another variation"
                            className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-indigo-700 bg-indigo-100 hover:bg-indigo-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm shrink-0"
                          >
                            <Plus size={14} /> Add
                          </button>
                        </div>
                      )
                    ) : (
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={() => handleEditClick(single)}
                          className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-100 rounded-xl transition-all shadow-sm"
                        >
                          <Edit size={16} />
                        </button>
                        <button
                          onClick={() => void handleDeleteVariation(single)}
                          className="p-3 text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-100 rounded-xl transition-all shadow-sm"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {hasMultiple && isExpanded && (
                  <div className="border-t border-slate-100 divide-y divide-slate-50 bg-slate-50/40">
                    {group.variations.map((v) => (
                      <div key={v.id} className="flex items-center justify-between px-4 py-3 pl-[90px]">
                        <div className="text-sm font-black text-slate-700">
                          {v.variation && v.variation !== "Standard" ? v.variation : "Standard"}
                        </div>
                        <div className="flex items-center gap-5">
                          <div className="text-sm font-black text-slate-900">PKR {v.price}</div>
                          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest w-24 text-right">
                            {v.stock > 0 ? `${v.stock} in stock` : "Unlimited"}
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleEditClick(v)}
                              className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                            >
                              <Edit size={14} />
                            </button>
                            <button
                              onClick={() => void handleDeleteVariation(v)}
                              className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }) : null}
        </div>
      </div>
    </div>
  );
}
