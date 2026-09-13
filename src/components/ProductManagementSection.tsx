
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Package, Edit, Archive, X, Trash2, Search, ChevronDown, ChevronRight, Upload } from "lucide-react";
import { createProduct, deleteProduct, fetchProducts, updateProduct } from "@/lib/pos-api";
import { Product } from "@/lib/pos-types";
import { useToast } from "@/lib/toast";
import { resolveProductImage } from "@/lib/food-images";
import { useLanguage } from "@/i18n";

// Products that share the same name+category are different "variations" of
// the same menu item (e.g. Pizza Small/Medium/Large are 3 separate Product
// documents). The directory list groups them into one row per item, with
// variations expandable underneath - mirrors the grouping used on the POS
// screen so editing matches what staff see when ringing up an order.
type ProductGroup = {
  key: string;
  name: string;
  category: string;
  company?: string;
  image?: string;
  isDeal: boolean;
  variations: Product[];
};

// Longest side an uploaded product photo is resized down to before it's
// stored as a data: URI - keeps the resulting string (and the eventual
// Mongo document + every page that has to send/render it) small, while
// still looking sharp as a product-card/cart thumbnail. Never upscales a
// smaller source image.
const MAX_UPLOAD_DIMENSION = 480;

// Reads an image File picked from the device, downsizes it on an offscreen
// <canvas> so its longest side is ~MAX_UPLOAD_DIMENSION px (preserving
// aspect ratio), and returns it as a compressed JPEG data: URI. That string
// is set directly as the existing `image` field - no upload endpoint, no
// separate storage - so it's just an ordinary string value handled by the
// existing save/display path (see resolveProductImage in food-images.ts,
// which treats a data: URI as a highest-priority custom image and falls
// back to a generic placeholder when `image` is empty).
function resizeImageToDataUrl(file: File, t: (key: string, vars?: Record<string, string | number>) => string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error(t("productManagement.imageErrors.invalidFileType")));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("productManagement.imageErrors.readFailed")));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error(t("productManagement.imageErrors.invalidImage")));
      img.onload = () => {
        const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error(t("productManagement.imageErrors.processFailed")));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function ProductManagementSection({
  title,
  description,
  cardClassName = "rounded-[28px] border border-slate-200 bg-white p-6",
}: {
  title?: string;
  description?: string;
  cardClassName?: string;
}) {
  const { confirm, popup } = useToast();
  const { t } = useLanguage();
  // Falls back to the translated defaults when the caller doesn't pass its
  // own title/description - see the same pattern used for every other
  // translated section.
  const resolvedTitle = title ?? t("productManagement.title");
  const resolvedDescription = description ?? t("productManagement.description");
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  // Success confirmations only now - every error (validation or otherwise)
  // routes through the shared popup() from useToast instead, so it's never
  // missed as a quiet inline banner above the fold.
  const [statusMessage, setStatusMessage] = useState<{ tone: "success"; text: string } | null>(null);

  // General Form states
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
  // Company/brand name (e.g. "Engro", "Fauji", "FFC") - shared by every
  // variation of a group, same as category/image - see Product.company's
  // own comment in pos-types.ts/backend/models/Product.js.
  const [company, setCompany] = useState("");
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

  // Deal fields (isDeal/dealItems/description) no longer have any creation
  // or editing UI here (see "Create Deal" removal) - but an existing Deal
  // product can still be opened via the regular Edit button (it's just
  // treated as a normal product: name/price/category/image are editable,
  // its deal composition isn't). Whatever it already had is captured here
  // on edit-open and passed straight back through unchanged on save, so
  // saving an edit never silently strips a product's deal status/items.
  const [preservedDealFields, setPreservedDealFields] = useState<{ isDeal: boolean; dealItems: string[]; description: string }>({
    isDeal: false,
    dealItems: [],
    description: "",
  });
  // Manual photo upload (see resizeImageToDataUrl above) - imageFileInputRef
  // is the hidden <input type="file"> the "Upload Photo" button clicks.
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
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
      popup({ tone: "error", title: t("productManagement.toasts.loadFailedTitle"), message: error instanceof Error ? error.message : t("productManagement.toasts.loadFailedFallback") });
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
    setCompany("");
    setImage("");
    setVariation("Standard");
    setProductCode("");
    setPreservedDealFields({ isDeal: false, dealItems: [], description: "" });
    // Defaults to ON for a brand new product - most menu items (pizzas,
    // burgers, etc.) come in more than one size, so leading with the
    // Small/Medium/Large rows front-and-center is the common case. A
    // single-price item (like a canned drink) is still just one unchecked
    // click away.
    setHasVariations(true);
    setVariationsData([{ id: Date.now().toString(), name: "", price: "", qty: "", productCode: "" }]);
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
      category: category.trim(),
      company: company.trim(),
      image: image,
      color: "bg-indigo-500",
      // Preserved as-is from whatever was already on the product being
      // edited (or the "not a deal" defaults for a brand new product) -
      // there's no UI here to change these anymore, see preservedDealFields.
      description: preservedDealFields.description,
      isDeal: preservedDealFields.isDeal,
      dealItems: preservedDealFields.dealItems,
    };
  }

  async function handleSaveProduct() {
    if (!name.trim()) {
      popup({ tone: "error", title: t("productManagement.toasts.missingInfoTitle"), message: t("productManagement.toasts.nameRequired") });
      return;
    }

    if (!category.trim()) {
      popup({ tone: "error", title: t("productManagement.toasts.missingInfoTitle"), message: t("productManagement.toasts.categoryRequired") });
      return;
    }

    if (!editingId && !hasVariations && !price) {
      popup({ tone: "error", title: t("productManagement.toasts.missingInfoTitle"), message: t("productManagement.toasts.priceRequired") });
      return;
    }

    if (editingId && !price) {
      popup({ tone: "error", title: t("productManagement.toasts.missingInfoTitle"), message: t("productManagement.toasts.priceRequired") });
      return;
    }

    if (!editingId && hasVariations) {
      if (variationsData.length === 0) {
        popup({ tone: "error", title: t("productManagement.toasts.missingInfoTitle"), message: t("productManagement.toasts.variationRequired") });
        return;
      }
      for (const v of variationsData) {
        if (!v.name.trim()) {
           popup({ tone: "error", title: t("productManagement.toasts.missingInfoTitle"), message: t("productManagement.toasts.variationNameRequired") });
           return;
        }
        if (!v.price) {
           popup({ tone: "error", title: t("productManagement.toasts.missingInfoTitle"), message: t("productManagement.toasts.priceRequiredForVariation", { name: v.name }) });
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
        setStatusMessage({ tone: "success", text: t("productManagement.toasts.groupUpdated", { name }) });
        resetForm();
      } else if (editingId) {
        const payload = {
          ...getBasePayload(),
          price: Number(price),
          stock: qty ? Number(qty) : 0,
          variation,
          productCode: productCode.trim(),
        };
        const updated = await updateProduct(editingId, payload);
        if (updated) {
          setProducts((prev) => prev.map((p) => (p.id === editingId ? updated : p)));
          setStatusMessage({ tone: "success", text: t("productManagement.toasts.productUpdated", { name: updated.name }) });
          resetForm();
        }
      } else {
        if (hasVariations) {
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
          setStatusMessage({ tone: "success", text: t("productManagement.toasts.variantsAdded", { count: newProducts.length, name }) });
          resetForm();
        } else {
          const payload = {
            ...getBasePayload(),
            price: Number(price),
            stock: qty ? Number(qty) : 0,
            variation: "Standard",
            productCode: productCode.trim(),
          };
          const created = await createProduct(payload);
          if (created) {
            setProducts((prev) => [...prev, created]);
            setStatusMessage({ tone: "success", text: t("productManagement.toasts.productAdded", { name: created.name }) });
            resetForm();
          }
        }
      }
    } catch (error) {
      popup({ tone: "error", title: t("productManagement.toasts.saveFailedTitle"), message: error instanceof Error ? error.message : t("productManagement.toasts.saveFailedFallback") });
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
    setCategory(product.category);
    setCompany(product.company || "");
    setHasVariations(false);
    setVariation(product.variation || "Standard");
    // Carry through whatever deal-only fields this product already had
    // (there's no UI here to change them) so saving doesn't strip an
    // existing Deal's isDeal/dealItems - see preservedDealFields above.
    setPreservedDealFields({
      isDeal: !!product.isDeal,
      dealItems: product.dealItems || [],
      description: product.description || "",
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleDeleteVariation(product: Product) {
    const label = product.variation && product.variation !== "Standard" ? `${product.name} (${product.variation})` : product.name;
    const confirmed = await confirm(t("productManagement.toasts.deleteConfirmMessage", { label }), {
      title: t("productManagement.toasts.deleteConfirmTitle"),
      confirmText: t("common.delete"),
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteProduct(product.id);
      setProducts((prev) => prev.filter((p) => p.id !== product.id));
      setStatusMessage({ tone: "success", text: t("productManagement.toasts.deletedMessage", { label }) });
      if (editingId === product.id) {
        resetForm();
      }
    } catch (error) {
      popup({ tone: "error", title: t("productManagement.toasts.deleteFailedTitle"), message: error instanceof Error ? error.message : t("productManagement.toasts.deleteFailedFallback") });
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
    setIsEditingGroup(true);
    setName(group.name);
    setCategory(group.category);
    setCompany(group.company || "");
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
    setName(group.name);
    setCategory(group.category);
    setCompany(group.company || "");
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
    const groupCompany = company;
    const groupImage = image;
    resetForm();
    setName(groupName);
    setCategory(groupCategory);
    setCompany(groupCompany);
    setImage(groupImage);
    setHasVariations(true);
    setVariationsData([{ id: Date.now().toString(), name: "", price: "", qty: "", productCode: "" }]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Handles a file picked (or dropped) via the "Upload Photo" button/input -
  // resizes it client-side and sets the resulting data: URI as the form's
  // `image` string.
  async function handleImageFileSelected(file: File | null) {
    if (!file) return;
    try {
      setIsUploadingImage(true);
      const dataUrl = await resizeImageToDataUrl(file, t);
      setImage(dataUrl);
    } catch (error) {
      popup({ tone: "error", title: t("productManagement.toasts.photoFailedTitle"), message: error instanceof Error ? error.message : t("productManagement.toasts.photoFailedFallback") });
    } finally {
      setIsUploadingImage(false);
      if (imageFileInputRef.current) imageFileInputRef.current.value = "";
    }
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

  // Shows every product, including any existing Deals (with their own "Deal
  // Bundle" badge/read-only item list below) - there's no separate Deal
  // creation mode to filter by anymore, so this is just one combined
  // directory an admin can view/search/edit from.
  const directoryGroups = useMemo<ProductGroup[]>(() => {
    const map = new Map<string, ProductGroup>();
    const order: string[] = [];
    // Reversed so the oldest-created item of each group appears first,
    // matching the previous (ungrouped) directory ordering.
    for (const p of [...products].reverse()) {
      const key = p.isDeal ? `deal:${p.id}` : `${p.category}::${p.name}`;
      let group = map.get(key);
      if (!group) {
        group = { key, name: p.name, category: p.category, company: p.company, image: p.image, isDeal: !!p.isDeal, variations: [] };
        map.set(key, group);
        order.push(key);
      }
      group.variations.push(p);
    }
    return order.map((key) => map.get(key)!);
  }, [products]);

  return (
    <div className={cardClassName}>
      <div className="flex items-center gap-2 mb-4">
        <Package size={18} className="text-indigo-600" />
        <h3 className="text-lg font-black text-slate-900">{resolvedTitle}</h3>
      </div>
      <p className="max-w-2xl text-sm text-slate-500 mb-6">{resolvedDescription}</p>

      {statusMessage ? (
        <div className="mb-5 flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {statusMessage.text}
          <button onClick={() => setStatusMessage(null)} className="font-bold opacity-70 hover:opacity-100">×</button>
        </div>
      ) : null}

      <div className="rounded-[32px] border border-slate-100 bg-slate-50 p-6 space-y-6 shadow-sm">

        {(editingId || isEditingGroup) && (
          <h4 className="text-sm font-black uppercase text-indigo-600 tracking-wider flex items-center gap-2 border-b border-indigo-100 pb-3">
            <Edit size={16} /> {isEditingGroup ? t("productManagement.editHeading.group") : t("productManagement.editHeading.single")}
          </h4>
        )}

        {/* Category comes first on purpose - it's the top of the hierarchy
            (Category -> Sub Category/Item -> Sizes) a menu naturally follows,
            e.g. "Pizza" -> "Behari Kabab" -> Small/Medium/Large. Existing
            categories are one tap away as chips so building out a menu
            doesn't mean retyping "Pizza" for every single item. */}
        <div className="space-y-2">
          <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{t("common.category")}</label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            list="categories-list"
            placeholder={t("productManagement.fields.categoryPlaceholder")}
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">
              {t("productManagement.fields.company")}
            </label>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder={t("productManagement.fields.companyPlaceholder")}
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
            />
          </div>
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">
              {t("productManagement.fields.productName")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("productManagement.fields.productNamePlaceholder")}
              className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
            />
            <p className="text-[10px] font-bold text-slate-400 ml-1">{t("productManagement.fields.productNameHint", { category: category || t("common.category") })}</p>
          </div>
        </div>

        {/* Global Price & Qty for a single (non-variation) product */}
        {(!hasVariations || editingId) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-2">
            <div className="space-y-2">
              <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{t("common.price")}</label>
              <div className="relative">
                <span className="absolute left-4 rtl:left-auto rtl:right-4 top-1/2 -translate-y-1/2 text-slate-300 font-black text-[14px]">PKR</span>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white pl-12 pr-4 rtl:pl-4 rtl:pr-12 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{t("productManagement.fields.quantity")}</label>
              <input
                type="number"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder={t("productManagement.fields.quantityPlaceholder")}
                className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{t("productManagement.fields.productCode")}</label>
              <input
                type="text"
                value={productCode}
                onChange={(e) => setProductCode(e.target.value)}
                placeholder={t("productManagement.fields.productCodePlaceholder")}
                className="w-full rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
              />
            </div>
            {editingId && (
              <div className="space-y-2 md:col-span-2">
                <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{t("productManagement.fields.variationName")}</label>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    value={variation}
                    onChange={(e) => setVariation(e.target.value)}
                    placeholder={t("productManagement.fields.variationNamePlaceholder")}
                    className="flex-1 min-w-[200px] rounded-2xl border-none ring-1 ring-slate-200 bg-white px-4 py-3.5 text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                  />
                  <button
                    type="button"
                    onClick={handleAddVariationFromEdit}
                    title={t("productManagement.fields.addPatternTitle")}
                    className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wider font-black text-indigo-700 bg-indigo-100 hover:bg-indigo-200 px-5 py-3.5 rounded-2xl transition-colors shadow-sm shrink-0"
                  >
                    <Plus size={14} /> {t("productManagement.variations.addPattern")}
                  </button>
                </div>
                <p className="text-[10px] font-bold text-slate-400 ml-1">{t("productManagement.fields.addPatternHint")}</p>
              </div>
            )}
          </div>
        )}

        {/* Variations UI - only when creating a brand new product */}
        {!editingId && (
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
                <span className="text-sm font-black text-slate-800">{t("productManagement.variations.addToggleLabel")}</span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-0.5">{t("productManagement.variations.addToggleHint")}</span>
              </div>
            </label>

            {hasVariations && (
              <div className="space-y-3 pl-6 rtl:pl-0 rtl:pr-6 border-l-2 rtl:border-l-0 rtl:border-r-2 border-indigo-100 py-2">
                <div className="flex flex-wrap items-center gap-2 pb-1">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1 rtl:mr-0 rtl:ml-1">{t("productManagement.variations.quickFill")}</span>
                  <button type="button" onClick={() => applySizePreset(["Small", "Medium", "Large"])} className="rounded-full bg-slate-100 hover:bg-indigo-100 hover:text-indigo-700 px-3 py-1.5 text-[11px] font-black text-slate-600 transition-colors">
                    {t("productManagement.variations.presetSmallMediumLarge")}
                  </button>
                  <button type="button" onClick={() => applySizePreset(["Small", "Medium", "Large", "X-Large"])} className="rounded-full bg-slate-100 hover:bg-indigo-100 hover:text-indigo-700 px-3 py-1.5 text-[11px] font-black text-slate-600 transition-colors">
                    {t("productManagement.variations.presetXLarge")}
                  </button>
                  <button type="button" onClick={() => applySizePreset(["Half", "Full"])} className="rounded-full bg-slate-100 hover:bg-indigo-100 hover:text-indigo-700 px-3 py-1.5 text-[11px] font-black text-slate-600 transition-colors">
                    {t("productManagement.variations.presetHalfFull")}
                  </button>
                </div>
                {variationsData.map((v, i) => (
                  <div key={v.id} className="flex flex-wrap items-center gap-3 bg-white p-3 rounded-2xl ring-1 ring-slate-200 shadow-sm relative group">
                    <div className="flex-1 min-w-[150px]">
                      <input 
                        type="text" 
                        placeholder={t("productManagement.variations.namePlaceholder")}
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
                      <span className="absolute left-3 rtl:left-auto rtl:right-3 top-1/2 -translate-y-1/2 text-slate-300 font-bold text-[10px]">PKR</span>
                      <input
                        type="number"
                        placeholder={t("productManagement.variations.pricePlaceholder")}
                        value={v.price}
                        onChange={(e) => {
                          const newVars = [...variationsData];
                          newVars[i].price = e.target.value;
                          setVariationsData(newVars);
                        }}
                        className="w-full rounded-[14px] border border-slate-200 pl-9 pr-2 rtl:pl-2 rtl:pr-9 py-2.5 text-sm font-bold outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all"
                      />
                    </div>
                    <div className="w-24">
                      <input
                        type="number"
                        placeholder={t("productManagement.variations.qtyPlaceholder")}
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
                        placeholder={t("productManagement.variations.codePlaceholder")}
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
                        title={t("productManagement.variations.removeTitle")}
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
                  <Plus size={14} /> {t("productManagement.variations.addPattern")}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Product Photo - manual upload only (the old preset restaurant-
            icon grid - burgers, pizza slices, etc. - was removed as not
            relevant to every business; resolveProductImage still falls back
            to a clean generic placeholder when a product has no photo). */}
        <div className="pt-2">
          <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1 block mb-3">{t("productManagement.photo.label")}</label>
          <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-dashed border-slate-300 bg-white p-4">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-slate-100 bg-slate-50">
              <img
                src={resolveProductImage({ image, name, category })}
                alt={t("productManagement.photo.previewAlt")}
                className="h-full w-full object-cover"
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => imageFileInputRef.current?.click()}
                  disabled={isUploadingImage}
                  className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wider font-black text-indigo-700 bg-indigo-100 hover:bg-indigo-200 px-4 py-2.5 rounded-xl transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Upload size={14} /> {isUploadingImage ? t("productManagement.photo.processing") : t("productManagement.photo.upload")}
                </button>
                {image ? (
                  <button
                    type="button"
                    onClick={() => setImage("")}
                    className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wider font-black text-rose-600 bg-rose-50 hover:bg-rose-100 px-4 py-2.5 rounded-xl transition-colors shadow-sm"
                  >
                    <X size={14} /> {t("productManagement.photo.remove")}
                  </button>
                ) : null}
              </div>
              <input
                ref={imageFileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void handleImageFileSelected(e.target.files?.[0] ?? null)}
              />
              <p className="text-[10px] font-bold text-slate-400">{t("productManagement.photo.hint")}</p>
            </div>
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
            {isSaving ? t("common.saving") : ((editingId || isEditingGroup) ? t("productManagement.actions.updateProduct") : t("productManagement.actions.publishProduct"))}
          </button>

          {(editingId || isEditingGroup) && (
            <button
              type="button"
              onClick={resetForm}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-200 px-6 py-4 text-sm font-black text-slate-700 hover:bg-slate-300 transition-all shadow-sm"
            >
              <X size={16} />
              {t("common.cancelEdit")}
            </button>
          )}
        </div>
      </div>

      <div className="mt-10 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3">
          <h4 className="text-xs font-black uppercase text-slate-400 tracking-wider flex items-center gap-2">
             <Package size={14} /> {t("productManagement.directory.heading", { count: directoryGroups.length })}
          </h4>
          <div className="relative w-full sm:w-64">
             <span className="absolute left-3 rtl:left-auto rtl:right-3 top-1/2 -translate-y-1/2 text-slate-400">
               <Search size={16} />
             </span>
             <input
               type="text"
               placeholder={t("productManagement.directory.searchPlaceholder")}
               value={searchQuery}
               onChange={(e) => setSearchQuery(e.target.value)}
               className="w-full rounded-[14px] border border-slate-200 bg-white pl-9 pr-4 rtl:pl-4 rtl:pr-9 py-2 text-sm font-bold outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all shadow-sm"
             />
          </div>
        </div>
        {isLoading ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 animate-pulse border border-slate-100">{t("productManagement.directory.syncing")}</div> : null}
        {!isLoading && directoryGroups.length === 0 ? <div className="rounded-[32px] bg-slate-50 px-6 py-8 text-center text-sm font-bold text-slate-500 border border-slate-100">{t("productManagement.directory.empty")}</div> : null}

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
                {/* Was one `flex items-center justify-between` row with the
                    price/stock/action block `shrink-0` on the right - on a
                    phone, that fixed-width block (plus the 56px image) left
                    the name/badges nowhere to go, and since the outer card
                    has `overflow-hidden`, the overflow got clipped instead
                    of wrapping - reading as text and icons crammed/
                    overlapping right on top of the image. Stacks into two
                    full-width rows below sm instead: image+name on top,
                    price/stock/actions underneath, wrapping freely.
                    Unchanged from sm (640px) up. */}
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <button
                    type="button"
                    onClick={() => hasMultiple && toggleGroup(group.key)}
                    className={`flex items-center gap-4 min-w-0 text-left sm:flex-1 ${hasMultiple ? "cursor-pointer" : "cursor-default"}`}
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
                            {t("productManagement.directory.variationsCount", { count: group.variations.length })}
                          </span>
                        ) : (!group.isDeal && single.variation && single.variation !== "Standard" ? (
                          <span className="text-slate-400 font-bold">({single.variation})</span>
                        ) : null)}
                        {group.isDeal && <span className="bg-rose-100 text-rose-600 px-2 py-0.5 rounded-lg text-[10px] uppercase font-black tracking-wider shadow-sm">{t("productManagement.directory.dealBundle")}</span>}
                      </div>
                      <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest mt-1">
                        {group.category}{group.company ? ` · ${group.company}` : ""}
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
                  <div className="flex flex-wrap items-center justify-end gap-4 sm:shrink-0">
                    <div className="flex flex-col items-end">
                      <div className="text-[15px] font-black text-slate-900">
                        {hasMultiple ? (minPrice === maxPrice ? `PKR ${minPrice}` : `PKR ${minPrice} - ${maxPrice}`) : `PKR ${single.price}`}
                      </div>
                      <div className="flex items-center gap-1 mt-1 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        <Archive size={10} />
                        <span>{totalStock > 0 ? t("productManagement.directory.inStock", { count: totalStock }) : t("common.unlimited")}</span>
                      </div>
                    </div>
                    {hasMultiple ? (
                      !group.isDeal && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleEditGroupClick(group)}
                            title={t("productManagement.directory.editGroupTitle")}
                            className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-100 rounded-xl transition-all shadow-sm"
                          >
                            <Edit size={16} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddVariationClick(group)}
                            title={t("productManagement.directory.addVariationTitle")}
                            className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-black text-indigo-700 bg-indigo-100 hover:bg-indigo-200 px-3 py-2.5 rounded-xl transition-colors shadow-sm shrink-0"
                          >
                            <Plus size={14} /> {t("common.add")}
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
                      <div key={v.id} className="flex items-center justify-between px-4 py-3 pl-[90px] rtl:pl-4 rtl:pr-[90px]">
                        <div className="text-sm font-black text-slate-700">
                          {v.variation && v.variation !== "Standard" ? v.variation : t("productManagement.directory.standardVariation")}
                        </div>
                        <div className="flex items-center gap-5">
                          <div className="text-sm font-black text-slate-900">PKR {v.price}</div>
                          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest w-24 text-right rtl:text-left">
                            {v.stock > 0 ? t("productManagement.directory.inStock", { count: v.stock }) : t("common.unlimited")}
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
