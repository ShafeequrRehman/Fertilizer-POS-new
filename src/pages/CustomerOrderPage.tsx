import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ShoppingCart, Plus, Minus, X, CheckCircle2, AlertCircle, MapPin, Download, UtensilsCrossed, Share, RotateCcw, Edit3, Clock, Check, Bike, Phone } from 'lucide-react';
import { getProductImageUrl } from '@/lib/asset-path';
import {
  createPublicOrder,
  fetchPublicCustomerStatus,
  fetchPublicMenu,
  fetchPublicOrderStatus,
  fetchPublicTables,
  initiatePublicPayment,
  requestOrderChange,
  type PaymentRedirect,
  type PublicMenuProduct,
  type PublicMenuResponse,
  type PublicOrderResult,
  type PublicOrderStatus,
  type PublicChangeRequest,
} from '@/lib/public-order-api';
import { getTableOptions, formatTableLabel } from '@/lib/table-options';
import { getApiBaseCandidates } from '@/lib/api';

// The customer-facing QR ordering PWA (see Settings > Customer Ordering for
// how a shop gets its link/QR) - reachable at /order/:shopId with NO login,
// from a customer's own phone browser after scanning the shop's QR code,
// and installable to their home screen (see manifest.json/sw.js - this is
// deliberately a plain installable web app, not an Expo/APK build, per an
// explicit request to avoid app-store/build-pipeline overhead). A second
// route, /order/:shopId/status/:orderId, deep-links straight to the
// tracking view below - used when a JazzCash/EasyPaisa payment redirects
// the customer's browser back (see publicOrderController.js's
// jazzCashCallback/easyPaisaCallback) and by anyone re-opening/bookmarking
// their order.
//
// Every write here goes through backend/controllers/publicOrderController.js,
// which re-validates and re-prices everything server-side. This page's job
// is just to collect the order and show a clear error if the backend
// rejects it, not to be the source of truth for any of those checks itself.

type CartLine = { product: PublicMenuProduct; quantity: number };
type OrderType = 'DineIn' | 'TakeAway' | 'Delivery';

const formatter = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });

// Mirrors POSPage.tsx's own ProductGroup exactly, so the customer page
// browses the catalog the same way desktop does: every Product record
// that shares the same category+name (Category "Pizza" -> item "Special
// Pizza") is one product document PER size/variation (see
// ProductManagementSection.tsx's "Add multiple variations" flow) - the
// menu groups them back into one tile, and only opens a size/variation
// picker when there's more than one to choose from. A flat one-card-per-
// variation grid (the old behavior here) meant "Special Pizza" showed up
// as three separate, identically-named cards (Small/Medium/Large) instead
// of one "Special Pizza -> choose a size" tile like desktop.
type ProductGroup = {
  key: string;
  name: string;
  category: string;
  image: string;
  color: string;
  description: string;
  isDeal: boolean;
  variations: PublicMenuProduct[];
};

function groupMenuProducts(products: PublicMenuProduct[]): ProductGroup[] {
  const map = new Map<string, ProductGroup>();
  for (const product of products) {
    const key = product.isDeal ? `deal:${product.id}` : `${product.category}::${product.name}`;
    const existing = map.get(key);
    if (existing) {
      existing.variations.push(product);
    } else {
      map.set(key, {
        key,
        name: product.name,
        category: product.category,
        image: product.image,
        color: product.color,
        description: product.description,
        isDeal: Boolean(product.isDeal),
        variations: [product],
      });
    }
  }
  return Array.from(map.values());
}

// One entry per shop, holding whatever order this device currently
// considers "the one I'm tracking" - see the persistence effect in
// CustomerOrderPage below. Scoped per shopId (not global) since a
// customer's phone could plausibly have an active order at more than one
// shop at once, even though only one PER SHOP is allowed (see
// publicOrderController.js's createOrder).
function activeOrderStorageKey(shopId: string) {
  return `posCustomerActiveOrder:${shopId}`;
}
function readSavedOrderId(shopId: string): string | null {
  try {
    return localStorage.getItem(activeOrderStorageKey(shopId));
  } catch {
    return null;
  }
}
function saveActiveOrderId(shopId: string, orderId: string) {
  try {
    localStorage.setItem(activeOrderStorageKey(shopId), orderId);
  } catch {
    // Best-effort only - private browsing / storage-disabled just means
    // the customer has to re-find their order via the shop's own tracking
    // link (e.g. a payment-gateway redirect) instead of it surviving a
    // closed tab. Never blocks ordering itself.
  }
}
function clearSavedOrderId(shopId: string) {
  try {
    localStorage.removeItem(activeOrderStorageKey(shopId));
  } catch {
    // See saveActiveOrderId.
  }
}

const TRACKING_LABELS: Record<string, { label: string; tone: string }> = {
  awaiting_confirmation: { label: 'Waiting for the shop to accept your order', tone: 'bg-amber-50 text-amber-800' },
  confirmed: { label: 'Order confirmed - getting started', tone: 'bg-blue-50 text-blue-800' },
  preparing: { label: 'Preparing your order', tone: 'bg-indigo-50 text-indigo-800' },
  ready: { label: 'Ready', tone: 'bg-emerald-50 text-emerald-800' },
  cancelled: { label: 'This order was cancelled', tone: 'bg-rose-50 text-rose-800' },
};

type LocationResult =
  | { ok: true; lat: number; lng: number; accuracy?: number }
  | { ok: false; reason: 'unsupported' | 'denied' | 'unavailable' | 'timeout' };

// Real-time location capture for a Delivery order - MANDATORY, not
// best-effort (see publicOrderController.js's createOrder, which now
// rejects a Delivery order with no valid lat/lng at all - a customer typing
// an address alone is no longer enough on its own). Returns a specific
// failure reason rather than just null, so handlePlaceOrder can show the
// customer an actionable message (e.g. "you denied location access" is a
// very different fix than "your GPS timed out").
function captureLocation(): Promise<LocationResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return resolve({ ok: false, reason: 'unsupported' });
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ ok: true, lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy }),
      (error) => {
        // GeolocationPositionError codes: 1 = PERMISSION_DENIED, 2 =
        // POSITION_UNAVAILABLE, 3 = TIMEOUT.
        if (error.code === 1) resolve({ ok: false, reason: 'denied' });
        else if (error.code === 3) resolve({ ok: false, reason: 'timeout' });
        else resolve({ ok: false, reason: 'unavailable' });
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}

type LocationErrorReason = Extract<LocationResult, { ok: false }>['reason'];

const LOCATION_ERROR_MESSAGE: Record<LocationErrorReason, string> = {
  unsupported: "Your browser doesn't support location - please try a different browser (Chrome works best) to place a delivery order.",
  denied: 'You denied location access. Please allow location for this site in your browser settings, then try again - delivery orders require it so the rider can find you.',
  unavailable: "Couldn't get your location - please check your GPS/network connection and try again.",
  timeout: 'Getting your location took too long - please make sure GPS is on and try again.',
};

// Mirrors publicOrderController.js's own ADD_ITEMS_WINDOW_MS - kept in
// sync with the server-side cutoff so the countdown shown here never
// promises more time than the backend will actually honor (the backend
// re-checks this regardless, so this is purely a UX courtesy).
const ADD_ITEMS_WINDOW_MS = 5 * 60 * 1000;

function useCountdown(deadline: number): number {
  const [remaining, setRemaining] = useState(() => Math.max(deadline - Date.now(), 0));
  useEffect(() => {
    setRemaining(Math.max(deadline - Date.now(), 0));
    const intervalId = window.setInterval(() => setRemaining(Math.max(deadline - Date.now(), 0)), 1000);
    return () => window.clearInterval(intervalId);
  }, [deadline]);
  return remaining;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(Math.ceil(ms / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Auto-submits a hidden HTML form to the gateway's own hosted checkout
// page - JazzCash/EasyPaisa both expect a real browser POST (not a fetch/
// XHR redirect) so their page can render normally and eventually redirect
// back through publicOrderController.js's callback routes.
function redirectToGateway(redirect: PaymentRedirect) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = redirect.url;
  Object.entries(redirect.fields).forEach(([key, value]) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = key;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
}

// Same "choose a size/variation" bottom sheet as desktop's
// VariationPickerModal (POSPage.tsx) - a single tap adds ONE of that
// variation straight to the cart and closes the sheet, matching desktop's
// own tap-to-add behavior exactly (no separate quantity stepper inside
// here; further quantity changes happen back on the card/cart list, same
// as everywhere else on this page).
function VariationPickerSheet({ group, onSelect, onClose }: { group: ProductGroup; onSelect: (variation: PublicMenuProduct) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/50 sm:items-center sm:justify-center" onClick={onClose}>
      <div className="w-full max-w-sm rounded-t-[28px] bg-white p-6 shadow-2xl sm:rounded-[28px]" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center gap-3">
          <div className={`h-14 w-14 shrink-0 overflow-hidden rounded-[16px] ${group.color || 'bg-indigo-50'} p-2`}>
            {getProductImageUrl(group.image) ? (
              <img src={getProductImageUrl(group.image)} alt={group.name} className="h-full w-full object-contain" />
            ) : (
              <UtensilsCrossed className="h-full w-full text-black/30" strokeWidth={1.5} />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-lg font-black text-gray-900">{group.name}</h3>
            <p className="text-xs font-bold text-gray-400">Choose a size / variation</p>
          </div>
        </div>
        <div className="max-h-[320px] space-y-2 overflow-y-auto">
          {group.variations.map((variation) => (
            <button
              key={variation.id}
              type="button"
              onClick={() => onSelect(variation)}
              className="flex w-full items-center justify-between rounded-2xl border border-gray-100 bg-[#FAFBFC] px-4 py-3 text-left transition hover:border-[#E2F33C] hover:bg-[#FBFDEB]"
            >
              <p className="truncate text-sm font-black text-gray-900">{variation.variation || 'Standard'}</p>
              <span className="shrink-0 text-sm font-black text-gray-900">Rs {formatter.format(variation.price)}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-2xl bg-gray-100 py-3 text-sm font-black text-gray-600">
          Cancel
        </button>
      </div>
    </div>
  );
}

// Lets the customer ask to add and/or remove items on an order they
// already placed - never applied directly (see publicOrderController.js's
// requestOrderChange): it just sits on the order as a pending request
// until staff approves or rejects it from the Sales dashboard (see
// SalesPage.tsx's OnlineOrderControls). Adding new items is only offered
// within ADD_ITEMS_WINDOW_MS of the order being placed (the kitchen may
// already be well underway after that) - removals stay available for as
// long as the order itself is still open to changes at all (see
// OrderStatusPanel's own canRequestChange).
function ChangeRequestModal({
  shopId,
  status,
  onClose,
  onSubmitted,
}: {
  shopId: string;
  status: PublicOrderStatus;
  onClose: () => void;
  onSubmitted: (request: PublicChangeRequest) => void;
}) {
  const deadline = useMemo(() => new Date(status.createdAt).getTime() + ADD_ITEMS_WINDOW_MS, [status.createdAt]);
  const remaining = useCountdown(deadline);
  const canAdd = remaining > 0;

  const [menu, setMenu] = useState<PublicMenuResponse | null>(null);
  const [menuLoading, setMenuLoading] = useState(canAdd);
  const [addQuantities, setAddQuantities] = useState<Map<string, number>>(new Map());
  const [removeQuantities, setRemoveQuantities] = useState<Map<string, number>>(new Map());
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canAdd) {
      setMenuLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchPublicMenu(shopId);
        if (!cancelled) setMenu(result);
      } catch {
        // Best-effort - the Add section just stays empty if this fails;
        // removals (loaded straight from `status`, no fetch needed) still work.
      } finally {
        if (!cancelled) setMenuLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shopId, canAdd]);

  function itemKey(name: string, variation: string) {
    return `${name}::${variation}`;
  }

  // Existing order lines grouped by name+variation, so the remove-quantity
  // stepper can't go past what's actually on the order even if the same
  // item appears as more than one line (e.g. added at different times).
  const currentItems = useMemo(() => {
    const map = new Map<string, { name: string; variation: string; quantity: number; price: number }>();
    status.items.forEach((item) => {
      const key = itemKey(item.name, item.variation);
      const existing = map.get(key);
      if (existing) existing.quantity += item.quantity;
      else map.set(key, { name: item.name, variation: item.variation, quantity: item.quantity, price: item.price });
    });
    return Array.from(map.values());
  }, [status.items]);

  function setAddQty(product: PublicMenuProduct, qty: number) {
    setAddQuantities((previous) => {
      const next = new Map(previous);
      const key = itemKey(product.name, product.variation);
      if (qty <= 0) next.delete(key);
      else next.set(key, qty);
      return next;
    });
  }

  function setRemoveQty(item: { name: string; variation: string; quantity: number }, qty: number) {
    setRemoveQuantities((previous) => {
      const next = new Map(previous);
      const key = itemKey(item.name, item.variation);
      const clamped = Math.max(0, Math.min(qty, item.quantity));
      if (clamped <= 0) next.delete(key);
      else next.set(key, clamped);
      return next;
    });
  }

  const addItemsPayload = Array.from(addQuantities.entries()).map(([key, quantity]) => {
    const [name, variation] = key.split('::');
    return { name, variation, quantity };
  });
  const removeItemsPayload = Array.from(removeQuantities.entries()).map(([key, quantity]) => {
    const [name, variation] = key.split('::');
    return { name, variation, quantity };
  });
  const canSubmit = (addItemsPayload.length > 0 || removeItemsPayload.length > 0) && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await requestOrderChange(shopId, status.id, {
        addItems: addItemsPayload.length > 0 ? addItemsPayload : undefined,
        removeItems: removeItemsPayload.length > 0 ? removeItemsPayload : undefined,
        note: note.trim() || undefined,
      });
      onSubmitted(result.customerChangeRequest);
      onClose();
    } catch (err) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(message || 'Could not send your request - please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const productGroups = useMemo(() => groupMenuProducts(menu?.products || []), [menu]);
  const categories = useMemo(() => ['All', ...Array.from(new Set(productGroups.map((g) => g.category)))], [productGroups]);
  const [category, setCategory] = useState('All');
  const visibleGroups = category === 'All' ? productGroups : productGroups.filter((g) => g.category === category);
  const [pickerGroup, setPickerGroup] = useState<ProductGroup | null>(null);

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/50 sm:items-center sm:justify-center">
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-[28px] bg-white p-6 sm:max-w-lg sm:rounded-[28px]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-black text-gray-900">Request a Change</h2>
          <button type="button" onClick={onClose}><X size={20} className="text-gray-400" /></button>
        </div>

        <div className={`mb-4 flex items-center gap-2 rounded-xl p-3 text-xs font-bold ${canAdd ? 'bg-indigo-50 text-indigo-800' : 'bg-gray-50 text-gray-500'}`}>
          <Clock size={14} className="shrink-0" />
          {canAdd
            ? `You can still add new items for the next ${formatCountdown(remaining)}.`
            : "The 5-minute window to add new items has passed - you can still ask to remove items below."}
        </div>

        {canAdd ? (
          <div className="mb-5">
            <p className="mb-2 text-xs font-black uppercase tracking-[0.14em] text-gray-400">Add Items</p>
            {menuLoading ? (
              <p className="py-3 text-center text-xs text-gray-400">Loading menu...</p>
            ) : (
              <>
                <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategory(cat)}
                      className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-black ${category === cat ? 'bg-black text-white' : 'bg-[#F8F9FB] text-gray-500'}`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                <div className="space-y-2">
                  {visibleGroups.map((group) => {
                    // Same "one tile per name, picker for 2+ sizes" pattern
                    // as the main menu below and desktop's POSPage.tsx - see
                    // groupMenuProducts' own comment.
                    if (group.variations.length <= 1) {
                      const product = group.variations[0];
                      const key = itemKey(product.name, product.variation);
                      const qty = addQuantities.get(key) || 0;
                      return (
                        <div key={group.key} className="flex items-center justify-between rounded-xl bg-[#F8F9FB] p-3">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-black text-gray-900">{product.name}{product.variation ? ` (${product.variation})` : ''}</p>
                            <p className="text-[11px] text-gray-400">Rs {formatter.format(product.price)}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <button type="button" onClick={() => setAddQty(product, qty - 1)} disabled={qty === 0} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white disabled:opacity-30"><Minus size={13} /></button>
                            <span className="w-4 text-center text-xs font-black">{qty}</span>
                            <button type="button" onClick={() => setAddQty(product, qty + 1)} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white"><Plus size={13} /></button>
                          </div>
                        </div>
                      );
                    }
                    const groupQty = group.variations.reduce((sum, v) => sum + (addQuantities.get(itemKey(v.name, v.variation)) || 0), 0);
                    const cheapest = Math.min(...group.variations.map((v) => v.price));
                    return (
                      <button
                        key={group.key}
                        type="button"
                        onClick={() => setPickerGroup(group)}
                        className="flex w-full items-center justify-between rounded-xl bg-[#F8F9FB] p-3 text-left"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-xs font-black text-gray-900">{group.name}</p>
                          <p className="text-[11px] text-gray-400">{group.variations.length} sizes/options - from Rs {formatter.format(cheapest)}</p>
                        </div>
                        <span className="shrink-0 rounded-lg bg-black px-2.5 py-1.5 text-[10px] font-black text-white">{groupQty > 0 ? `${groupQty} added` : 'Select'}</span>
                      </button>
                    );
                  })}
                  {visibleGroups.length === 0 ? <p className="py-3 text-center text-xs text-gray-400">No items in this category.</p> : null}
                </div>
              </>
            )}
          </div>
        ) : null}

        {pickerGroup ? (
          <VariationPickerSheet
            group={pickerGroup}
            onSelect={(variation) => {
              const key = itemKey(variation.name, variation.variation);
              setAddQty(variation, (addQuantities.get(key) || 0) + 1);
              setPickerGroup(null);
            }}
            onClose={() => setPickerGroup(null)}
          />
        ) : null}

        <div className="mb-5">
          <p className="mb-2 text-xs font-black uppercase tracking-[0.14em] text-gray-400">Remove Items</p>
          <div className="space-y-2">
            {currentItems.map((item) => {
              const key = itemKey(item.name, item.variation);
              const qty = removeQuantities.get(key) || 0;
              return (
                <div key={key} className="flex items-center justify-between rounded-xl bg-[#F8F9FB] p-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black text-gray-900">{item.name}{item.variation ? ` (${item.variation})` : ''}</p>
                    <p className="text-[11px] text-gray-400">You have {item.quantity} · Rs {formatter.format(item.price)} each</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button type="button" onClick={() => setRemoveQty(item, qty - 1)} disabled={qty === 0} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white disabled:opacity-30"><Minus size={13} /></button>
                    <span className="w-4 text-center text-xs font-black">{qty}</span>
                    <button type="button" onClick={() => setRemoveQty(item, qty + 1)} disabled={qty >= item.quantity} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white disabled:opacity-30"><Plus size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything else to tell the shop about this request..."
          rows={2}
          className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm outline-none"
        />

        {error ? <p className="mt-3 text-xs font-bold text-rose-600">{error}</p> : null}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="mt-4 w-full rounded-2xl bg-[#E2F33C] py-3.5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Sending Request...' : 'Send Request to Shop'}
        </button>
      </div>
    </div>
  );
}

// The customer's own order-tracking section - shown right after placing
// an order, from a payment-gateway redirect, or automatically whenever
// this device still has an active order remembered for this shop (see the
// persistence effect in the default export below). Read-only for the
// order itself - there's no direct public edit endpoint - but a customer
// can ASK for changes via ChangeRequestModal above, which staff then has
// to explicitly approve before anything actually changes.
// Visual step-by-step tracker (Placed -> Confirmed -> Preparing -> Ready ->
// Completed) - trackingStatus (awaiting_confirmation/confirmed/preparing/
// ready) covers the first four; the fifth ("Completed") comes from the
// real `status` field instead, since trackingStatus has no "completed"
// value of its own (see Order.js's own comment - it only ever reaches
// "ready" before staff closes the order out for real via Complete
// Payment). Cancelled orders skip this entirely - the banner above already
// covers that case clearly.
const PROGRESS_STEPS: Array<{ key: string; label: string }> = [
  { key: 'awaiting_confirmation', label: 'Placed' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'ready', label: 'Ready' },
  { key: 'completed', label: 'Completed' },
];

function OrderProgressStepper({ status }: { status: PublicOrderStatus }) {
  if (status.status === 'cancelled') return null;
  const currentIndex =
    status.status === 'completed'
      ? PROGRESS_STEPS.length - 1
      : Math.max(PROGRESS_STEPS.findIndex((step) => step.key === status.trackingStatus), 0);

  return (
    <div className="mt-5 flex items-start">
      {PROGRESS_STEPS.map((step, index) => (
        <div key={step.key} className={`flex items-center ${index < PROGRESS_STEPS.length - 1 ? 'flex-1' : ''}`}>
          <div className="flex flex-col items-center">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${
                index <= currentIndex ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-400'
              }`}
            >
              {index <= currentIndex ? <Check size={13} /> : index + 1}
            </div>
            <span className={`mt-1 w-14 text-center text-[9px] font-bold leading-tight ${index <= currentIndex ? 'text-gray-700' : 'text-gray-300'}`}>
              {step.label}
            </span>
          </div>
          {index < PROGRESS_STEPS.length - 1 ? (
            <div className={`mx-1 mt-3.5 h-0.5 flex-1 ${index < currentIndex ? 'bg-emerald-500' : 'bg-gray-100'}`} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function OrderStatusPanel({
  shopId,
  orderId,
  onFinished,
}: {
  shopId: string;
  orderId: string;
  onFinished?: () => void;
}) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<PublicOrderStatus | null>(null);
  const [error, setError] = useState('');
  const finishedRef = useRef(false);
  const [showChangeModal, setShowChangeModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await fetchPublicOrderStatus(shopId, orderId);
        if (cancelled) return;
        setStatus(result);
        // "Finished" = staff has completed or cancelled it (same boundary
        // publicOrderController.js's one-active-order-per-phone check
        // uses: status !== "pending") - once that happens there's nothing
        // left to track, so free up this device to remember/place a new
        // order instead of holding onto a dead one forever.
        if (result.status !== 'pending' && !finishedRef.current) {
          finishedRef.current = true;
          onFinished?.();
        }
      } catch {
        if (!cancelled) setError("Couldn't load this order.");
      }
    }
    void poll();
    const intervalId = window.setInterval(poll, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId, orderId]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F9FB] p-6 text-center text-sm font-bold text-gray-500">{error}</div>
    );
  }
  if (!status) {
    return <div className="flex min-h-screen items-center justify-center bg-[#F8F9FB] text-sm font-bold text-gray-500">Loading your order...</div>;
  }

  const tracking = TRACKING_LABELS[status.trackingStatus] || TRACKING_LABELS.awaiting_confirmation;
  const isFinished = status.status !== 'pending';
  // Once the kitchen has actually started on it (preparing/ready) or it's
  // cancelled, changes stop being requestable at all - same boundary
  // publicOrderController.js's requestOrderChange enforces server-side.
  const canRequestChange = !isFinished && ['awaiting_confirmation', 'confirmed'].includes(status.trackingStatus);
  const changeRequest = status.customerChangeRequest;
  return (
    <div className="min-h-screen bg-[#F8F9FB] p-6">
      <div className="mx-auto max-w-md rounded-[28px] bg-white p-8 text-center shadow-sm">
        <CheckCircle2 className="mx-auto mb-3 text-emerald-500" size={56} />
        <h1 className="text-2xl font-black text-gray-900">Order #{status.dailyOrderNumber}</h1>
        <div className={`mt-4 rounded-2xl px-4 py-3 text-sm font-black ${status.status === 'cancelled' ? TRACKING_LABELS.cancelled.tone : tracking.tone}`}>
          {status.status === 'cancelled' ? TRACKING_LABELS.cancelled.label : status.status === 'completed' ? 'Order completed - thank you!' : tracking.label}
        </div>

        <OrderProgressStepper status={status} />

        <div className="mt-6 space-y-1.5 rounded-2xl bg-[#F8F9FB] p-4 text-left text-sm">
          {status.items.map((item, index) => (
            <div key={`${item.name}-${index}`} className="flex justify-between gap-3">
              <span className="text-gray-600">{item.quantity}x {item.name}{item.variation ? ` (${item.variation})` : ''}</span>
              <span className="shrink-0 font-black text-gray-900">Rs {formatter.format(item.price * item.quantity)}</span>
            </div>
          ))}
        </div>

        <div className="mt-3 space-y-2 rounded-2xl bg-[#F8F9FB] p-4 text-left text-sm">
          <div className="flex justify-between"><span className="text-gray-500">Type</span><span className="font-black">{status.orderType === 'DineIn' ? 'Dine-In' : status.orderType}</span></div>
          {status.table ? <div className="flex justify-between"><span className="text-gray-500">Table</span><span className="font-black">{formatTableLabel(status.table)}</span></div> : null}
          {status.address ? <div className="flex justify-between gap-3"><span className="shrink-0 text-gray-500">Address</span><span className="text-right font-black">{status.address}</span></div> : null}
          <div className="flex justify-between"><span className="text-gray-500">Subtotal</span><span className="font-black">Rs {formatter.format(status.subtotal)}</span></div>
          {status.otherCharges > 0 ? (
            <div className="flex justify-between"><span className="text-gray-500">Other Charges</span><span className="font-black">Rs {formatter.format(status.otherCharges)}</span></div>
          ) : null}
          <div className="flex justify-between"><span className="text-gray-500">Total</span><span className="font-black">Rs {formatter.format(status.total)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Payment Method</span><span className="font-black">{status.paymentMethod}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Payment Status</span><span className="font-black capitalize">{status.paymentStatus.replace('_', ' ')}</span></div>
        </div>

        {status.orderType === 'Delivery' && status.assignedRider ? (
          <div className="mt-3 flex items-center gap-3 rounded-2xl bg-indigo-50 p-4 text-left">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white"><Bike size={16} /></div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-indigo-400">Your Rider</p>
              <p className="truncate text-sm font-black text-indigo-900">{status.assignedRider.name || 'Assigned'}</p>
            </div>
            <a href={`tel:${status.assignedRider.phone}`} className="flex shrink-0 items-center gap-1 rounded-xl bg-indigo-600 px-3 py-2 text-[11px] font-black text-white">
              <Phone size={12} /> Call
            </a>
          </div>
        ) : null}

        {changeRequest && changeRequest.status === 'pending' ? (
          <div className="mt-3 rounded-2xl bg-amber-50 p-4 text-left text-xs font-bold text-amber-800">
            <p>Your change request is waiting for the shop's approval:</p>
            <ul className="mt-1.5 space-y-0.5">
              {changeRequest.addItems.map((item, index) => (
                <li key={`add-${index}`}>+ {item.quantity}x {item.name}{item.variation ? ` (${item.variation})` : ''}</li>
              ))}
              {changeRequest.removeItems.map((item, index) => (
                <li key={`remove-${index}`}>− {item.quantity}x {item.name}{item.variation ? ` (${item.variation})` : ''}</li>
              ))}
            </ul>
          </div>
        ) : changeRequest && changeRequest.status === 'rejected' ? (
          <div className="mt-3 rounded-2xl bg-rose-50 p-4 text-left text-xs font-bold text-rose-700">
            Your last change request was declined{changeRequest.note ? `: ${changeRequest.note}` : '.'}
          </div>
        ) : changeRequest && changeRequest.status === 'approved' ? (
          <div className="mt-3 rounded-2xl bg-emerald-50 p-4 text-left text-xs font-bold text-emerald-700">
            Your last change request was approved and is reflected in your order above.
          </div>
        ) : null}

        {canRequestChange && (!changeRequest || changeRequest.status !== 'pending') ? (
          <button
            type="button"
            onClick={() => setShowChangeModal(true)}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#F8F9FB] py-3.5 text-sm font-black text-gray-800"
          >
            <Edit3 size={15} /> Add or Remove Items
          </button>
        ) : null}

        {isFinished ? (
          <button
            type="button"
            onClick={() => navigate(`/order/${shopId}`)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-black py-3.5 text-sm font-black text-white"
          >
            <RotateCcw size={15} /> Start a New Order
          </button>
        ) : (
          <p className="mt-5 text-[11px] font-semibold text-gray-400">This page updates automatically - no need to refresh.</p>
        )}
      </div>

      {showChangeModal ? (
        <ChangeRequestModal
          shopId={shopId}
          status={status}
          onClose={() => setShowChangeModal(false)}
          onSubmitted={(request) => setStatus((previous) => (previous ? { ...previous, customerChangeRequest: request } : previous))}
        />
      ) : null}
    </div>
  );
}

// A persistent "Menu" / "Track Order" tab strip - shown whenever this
// device has an active order, so a customer can flip back and forth
// between browsing the menu and checking their order's progress without
// losing either. Previously, having an active order forced the customer
// straight into (and stuck on) the tracking view with no way back to the
// menu at all - this just wraps both existing full-page views behind a
// lightweight local tab instead of a route change, so switching is instant
// and doesn't re-fetch the menu each time.
function CustomerShell({
  shopId,
  activeOrderId,
  onOrderFinished,
}: {
  shopId: string;
  activeOrderId: string;
  onOrderFinished: () => void;
}) {
  const [tab, setTab] = useState<'track' | 'menu'>('track');
  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="sticky top-0 z-30 flex gap-1.5 bg-black p-2">
        <button
          type="button"
          onClick={() => setTab('menu')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-black transition ${
            tab === 'menu' ? 'bg-[#E2F33C] text-black' : 'text-white/60'
          }`}
        >
          <UtensilsCrossed size={14} /> Menu
        </button>
        <button
          type="button"
          onClick={() => setTab('track')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-black transition ${
            tab === 'track' ? 'bg-[#E2F33C] text-black' : 'text-white/60'
          }`}
        >
          <Clock size={14} /> Track Order
        </button>
      </div>
      {tab === 'track' ? (
        <OrderStatusPanel shopId={shopId} orderId={activeOrderId} onFinished={onOrderFinished} />
      ) : (
        <CustomerOrderingFlow shopId={shopId} />
      )}
    </div>
  );
}

export default function CustomerOrderPage() {
  const params = useParams<{ shopId: string; orderId?: string }>();
  const shopId = params.shopId || '';

  // Swap the page's <link rel="manifest"> to this shop's own per-shop
  // manifest (see publicOrderController.js's getManifest) and register the
  // installability service worker - both scoped to ONLY this customer-
  // facing page mounting, never touching the staff dashboard/Electron
  // shell's own generic /manifest.json or lack of a service worker. Runs
  // for both the ordering flow and the status-tracking deep link below,
  // since a customer could land on either first.
  useEffect(() => {
    if (!shopId || typeof document === 'undefined') return;

    // Built from the same resolved API base as every other public-order
    // call (see public-order-api.ts's getShopOrderingUrl) - NOT a
    // hardcoded "/api/..." root path, because a shop deployed behind an
    // nginx path prefix (e.g. VITE_API_URL=https://host/pos/api) needs
    // that same "/pos" prefix here too, or the manifest 404s in production
    // even though it works fine in local dev without a prefix.
    const candidates = getApiBaseCandidates();
    const apiBase = candidates.find((base) => !base.includes('localhost')) || candidates[0] || '';
    const link = document.querySelector('link[rel="manifest"]');
    const previousHref = link?.getAttribute('href') || null;
    if (link && apiBase) link.setAttribute('href', `${apiBase}/public/${shopId}/manifest.json`);

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      // Relative (no leading "/") so it resolves against the CURRENT page
      // URL rather than the site root - correct both for a bare-root
      // deployment and one served under a path prefix like "/pos/".
      navigator.serviceWorker.register('sw.js').catch(() => {
        // Non-fatal - the page still works fully as a plain web page, it
        // just won't offer the "Add to Home Screen" install prompt.
      });
    }

    return () => {
      if (link && previousHref) link.setAttribute('href', previousHref);
    };
  }, [shopId]);

  // Persisted "active order" session - lets a customer close the tab/app
  // entirely and reopen the bare /order/:shopId link (not a specific
  // status deep link) and still land straight on their order's tracking
  // view, instead of the menu, for as long as that order is still active.
  // There's only ever one to remember per shop, since a phone can only
  // have one active order at a time now (see publicOrderController.js's
  // createOrder). Cleared automatically once OrderStatusPanel observes the
  // order leave "pending" (completed/cancelled).
  const [resolvedOrderId, setResolvedOrderId] = useState<string | null>(params.orderId || null);
  const [resolving, setResolving] = useState(!params.orderId);

  useEffect(() => {
    if (!shopId) {
      setResolving(false);
      return;
    }
    if (params.orderId) {
      // Explicit deep link (payment-gateway redirect, a shared/bookmarked
      // status link) - remember it too, so a later bare reopen of
      // /order/:shopId also resumes tracking it.
      saveActiveOrderId(shopId, params.orderId);
      setResolvedOrderId(params.orderId);
      setResolving(false);
      return;
    }

    let cancelled = false;
    (async () => {
      const savedId = readSavedOrderId(shopId);
      if (!savedId) {
        if (!cancelled) setResolving(false);
        return;
      }
      try {
        const status = await fetchPublicOrderStatus(shopId, savedId);
        if (cancelled) return;
        if (status.status !== 'pending') {
          // Already finished (customer might have tracked it to
          // completion on a different visit) - nothing left to resume.
          clearSavedOrderId(shopId);
          setResolvedOrderId(null);
        } else {
          setResolvedOrderId(savedId);
        }
      } catch {
        // Order no longer exists/invalid - drop the stale reference and
        // fall through to the ordering flow instead of getting stuck.
        if (!cancelled) {
          clearSavedOrderId(shopId);
          setResolvedOrderId(null);
        }
      } finally {
        if (!cancelled) setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shopId, params.orderId]);

  if (resolving) {
    return <div className="flex min-h-screen items-center justify-center bg-[#F8F9FB] text-sm font-bold text-gray-500">Loading...</div>;
  }
  if (resolvedOrderId) {
    return <CustomerShell shopId={shopId} activeOrderId={resolvedOrderId} onOrderFinished={() => clearSavedOrderId(shopId)} />;
  }
  return <CustomerOrderingFlow shopId={shopId} />;
}

function CustomerOrderingFlow({ shopId }: { shopId: string }) {
  const navigate = useNavigate();
  const [menu, setMenu] = useState<PublicMenuResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [category, setCategory] = useState('All');
  const [cart, setCart] = useState<Map<string, CartLine>>(new Map());
  const [showCart, setShowCart] = useState(false);

  const [orderType, setOrderType] = useState<OrderType>('DineIn');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [note, setNote] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Online' | 'JazzCash' | 'EasyPaisa'>('Cash');

  const [tables, setTables] = useState<string[]>([]);
  const [occupiedTables, setOccupiedTables] = useState<Set<string>>(new Set());
  const [table, setTable] = useState('');

  const [activeOrderWarning, setActiveOrderWarning] = useState<{ id: string; orderType: string; table: string; dailyOrderNumber: number } | null>(null);
  const phoneCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState('');
  const [placedOrder, setPlacedOrder] = useState<PublicOrderResult | null>(null);
  const [installPromptEvent, setInstallPromptEvent] = useState<any>(null);
  const [showIosInstallHint, setShowIosInstallHint] = useState(false);

  useEffect(() => {
    if (!shopId) {
      setLoadError('This ordering link is invalid.');
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const result = await fetchPublicMenu(shopId);
        setMenu(result);
      } catch (err) {
        const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
        setLoadError(message || "Couldn't load this shop's menu. Please try again.");
      } finally {
        setLoading(false);
      }
    })();
  }, [shopId]);

  // The browser's own "Add to Home Screen" prompt (Chrome/Edge/Android) -
  // captured here so the Install button below can trigger it on demand
  // instead of waiting for the browser's own mini-infobar. Safari/iOS has
  // no such event at all (its install is the manual Share > Add to Home
  // Screen flow) - the button just doesn't do anything there, which is
  // fine since iOS users already see that option in their share sheet.
  useEffect(() => {
    function handler(event: Event) {
      event.preventDefault();
      setInstallPromptEvent(event);
    }
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // iOS Safari never fires beforeinstallprompt at all (an Apple platform
  // restriction, not something any website can work around) - so the
  // Install button above would just silently never appear there, leaving
  // an iPhone customer with no visible way to add this to their home
  // screen. This shows the manual steps instead (Share -> Add to Home
  // Screen), and skips itself entirely once the page is already running
  // installed (navigator.standalone - the flag iOS sets on a launched
  // home-screen app - or the standard matchMedia check other installed
  // PWAs use).
  useEffect(() => {
    const ua = window.navigator.userAgent;
    const isIos = /iphone|ipad|ipod/i.test(ua) && !(window as any).MSStream;
    const isStandalone = (window.navigator as any).standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    setShowIosInstallHint(isIos && !isStandalone);
  }, []);

  useEffect(() => {
    if (!shopId || orderType !== 'DineIn') return undefined;
    let cancelled = false;
    async function load() {
      try {
        const result = await fetchPublicTables(shopId);
        if (cancelled) return;
        setTables(result.tables);
        setOccupiedTables(new Set(result.occupied));
      } catch {
        // Best-effort - the backend re-checks at submit time regardless.
      }
    }
    void load();
    const intervalId = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [shopId, orderType]);

  // Checked regardless of which order type is currently selected - the
  // one-active-order-per-phone restriction applies across Dine-In/
  // Takeaway/Delivery alike now (see publicOrderController.js's
  // createOrder), not just Dine-In table reservations.
  useEffect(() => {
    if (customerPhone.replace(/\D/g, '').length < 10) {
      setActiveOrderWarning(null);
      return;
    }
    if (phoneCheckTimeoutRef.current) clearTimeout(phoneCheckTimeoutRef.current);
    phoneCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const status = await fetchPublicCustomerStatus(shopId, customerPhone);
        setActiveOrderWarning(
          status.hasActiveOrder && status.order
            ? { id: status.order.id, orderType: status.order.orderType, table: status.order.table, dailyOrderNumber: status.order.dailyOrderNumber }
            : null,
        );
      } catch {
        setActiveOrderWarning(null);
      }
    }, 400);
  }, [shopId, customerPhone]);

  const products = menu?.products || [];
  const tableOptions = getTableOptions(tables);
  // Category -> product name -> size/variation, same three-level browse as
  // desktop's POSPage.tsx (see groupMenuProducts' own comment) - "Pizza"
  // (category) contains "Special Pizza" (one tile/group), which opens a
  // picker for Small/Medium/Large (variations) if it has more than one.
  const productGroups = useMemo(() => groupMenuProducts(products), [products]);
  const categories = useMemo(() => ['All', ...Array.from(new Set(productGroups.map((g) => g.category)))], [productGroups]);
  const visibleGroups = useMemo(
    () => (category === 'All' ? productGroups : productGroups.filter((g) => g.category === category)),
    [productGroups, category],
  );
  const [variationPickerGroup, setVariationPickerGroup] = useState<ProductGroup | null>(null);

  const cartLines = Array.from(cart.values());
  const cartCount = cartLines.reduce((sum, line) => sum + line.quantity, 0);
  const cartTotal = cartLines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

  function cartKey(product: PublicMenuProduct) {
    return `${product.name}::${product.variation}`;
  }

  function addToCart(product: PublicMenuProduct) {
    setCart((previous) => {
      const next = new Map(previous);
      const key = cartKey(product);
      const existing = next.get(key);
      next.set(key, { product, quantity: (existing?.quantity || 0) + 1 });
      return next;
    });
  }

  function changeQuantity(product: PublicMenuProduct, delta: number) {
    setCart((previous) => {
      const next = new Map(previous);
      const key = cartKey(product);
      const existing = next.get(key);
      if (!existing) return next;
      const quantity = existing.quantity + delta;
      if (quantity <= 0) next.delete(key);
      else next.set(key, { ...existing, quantity });
      return next;
    });
  }

  // Same behavior as desktop's handleGroupClick - a single-variation group
  // (the vast majority of items) adds straight to the cart; only a group
  // with 2+ sizes/options opens the picker.
  function handleGroupTap(group: ProductGroup) {
    if (group.variations.length <= 1) {
      addToCart(group.variations[0]);
      return;
    }
    setVariationPickerGroup(group);
  }

  const phoneDigits = customerPhone.replace(/\D/g, '');
  const canSubmit =
    cartCount > 0 &&
    menu?.isOpen &&
    customerName.trim().length >= 2 &&
    phoneDigits.length >= 10 &&
    (orderType !== 'Delivery' || customerAddress.trim().length >= 5) &&
    (orderType !== 'DineIn' || Boolean(table));

  async function handlePlaceOrder() {
    if (!canSubmit || placing) return;
    setPlacing(true);
    setPlaceError('');
    try {
      // Mandatory for Delivery - see publicOrderController.js's createOrder,
      // which rejects the request server-side either way if this is
      // missing. Placing the order is blocked entirely until location is
      // actually captured; there's no "skip" path anymore.
      let location: { lat: number; lng: number; accuracy?: number } | undefined;
      if (orderType === 'Delivery') {
        const locationResult = await captureLocation();
        if (!locationResult.ok) {
          setPlaceError(LOCATION_ERROR_MESSAGE[locationResult.reason]);
          setPlacing(false);
          return;
        }
        location = { lat: locationResult.lat, lng: locationResult.lng, accuracy: locationResult.accuracy };
      }
      const result = await createPublicOrder(shopId, {
        orderType,
        table: orderType === 'DineIn' ? table : undefined,
        customer: { name: customerName.trim(), phone: customerPhone.trim(), address: customerAddress.trim() },
        paymentMethod,
        note: note.trim(),
        items: cartLines.map((line) => ({ name: line.product.name, variation: line.product.variation, quantity: line.quantity })),
        location,
      });

      // Remembered immediately (not just once the status panel mounts) so
      // even a payment-gateway redirect that fails to come back still
      // leaves this device tracking the right order.
      saveActiveOrderId(shopId, result.id);

      if (result.requiresOnlinePayment && result.paymentMethod) {
        const provider = result.paymentMethod === 'JazzCash' ? 'jazzcash' : 'easypaisa';
        const redirect = await initiatePublicPayment(shopId, result.id, provider);
        redirectToGateway(redirect);
        return; // Browser is navigating away to the gateway now.
      }

      setPlacedOrder(result);
    } catch (err) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setPlaceError(message || 'Could not place your order - please try again.');
    } finally {
      setPlacing(false);
    }
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-[#F8F9FB] text-sm font-bold text-gray-500">Loading menu...</div>;
  }
  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F9FB] p-6 text-center">
        <div>
          <AlertCircle className="mx-auto mb-3 text-rose-500" size={40} />
          <p className="font-bold text-gray-700">{loadError}</p>
        </div>
      </div>
    );
  }
  if (placedOrder) {
    return <OrderStatusPanel shopId={shopId} orderId={placedOrder.id} onFinished={() => clearSavedOrderId(shopId)} />;
  }

  return (
    <div className="min-h-screen bg-[#F8F9FB] pb-28">
      <header className="bg-black px-5 py-6 text-white">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-black">{menu?.shopName || 'Menu'}</h1>
            <p className="text-xs font-semibold text-white/60">Order Dine-In, Takeaway, or Delivery</p>
          </div>
          {installPromptEvent ? (
            <button
              type="button"
              onClick={async () => {
                installPromptEvent.prompt();
                await installPromptEvent.userChoice;
                setInstallPromptEvent(null);
              }}
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-2 text-xs font-black"
            >
              <Download size={14} /> Install
            </button>
          ) : null}
        </div>
      </header>

      {!menu?.isOpen ? (
        <div className="mx-5 mt-4 flex items-center gap-2 rounded-2xl bg-amber-50 p-4 text-xs font-bold text-amber-800">
          <AlertCircle size={16} /> This shop is currently closed and isn't taking orders right now.
        </div>
      ) : null}

      {showIosInstallHint ? (
        <div className="mx-5 mt-4 flex items-start gap-2 rounded-2xl bg-white p-4 text-xs font-bold text-gray-700 shadow-sm">
          <Share size={16} className="mt-0.5 shrink-0 text-indigo-600" />
          <span className="flex-1">
            Add this to your Home Screen: tap the <b>Share</b> button below, then <b>Add to Home Screen</b>.
          </span>
          <button type="button" onClick={() => setShowIosInstallHint(false)} className="shrink-0 text-gray-400">
            <X size={16} />
          </button>
        </div>
      ) : null}

      <div className="flex gap-2 overflow-x-auto px-5 py-4">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setCategory(cat)}
            className={`shrink-0 rounded-full px-4 py-2 text-xs font-black ${category === cat ? 'bg-black text-white' : 'bg-white text-gray-500'}`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 px-5 sm:grid-cols-3">
        {visibleGroups.map((group) => {
          // A single-variation group behaves exactly like before (its own
          // quantity stepper, unambiguous which product it refers to). A
          // multi-variation group ("Special Pizza" -> Small/Medium/Large)
          // shows a "from Rs X" price and always opens the size picker on
          // tap, same as desktop - no inline stepper on the tile itself
          // since it wouldn't be clear which size it's adjusting.
          const hasVariations = group.variations.length > 1;
          const single = group.variations[0];
          const line = !hasVariations ? cart.get(cartKey(single)) : undefined;
          const groupCartCount = hasVariations
            ? group.variations.reduce((sum, v) => sum + (cart.get(cartKey(v))?.quantity || 0), 0)
            : 0;
          const cheapest = Math.min(...group.variations.map((v) => v.price));
          const imageUrl = getProductImageUrl(group.image);
          return (
            <div key={group.key} className="rounded-2xl bg-white p-3 shadow-sm">
              {/* Same colored icon tile POSPage.tsx's own product grid uses
                  on desktop (see getProductImageUrl's own comment for why a
                  relative path is required, not "/products/...") - keeps
                  this page visually identical to the shop's real catalog
                  instead of a plain photo grid, and still shows a sensible
                  placeholder for the (rare) product with no icon set. */}
              <div className={`mb-2 flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl p-2 ${group.color || 'bg-indigo-50'}`}>
                {imageUrl ? (
                  <img src={imageUrl} alt={group.name} className="h-full w-full object-contain" />
                ) : (
                  <UtensilsCrossed className="text-black/30" size={28} strokeWidth={1.5} />
                )}
              </div>
              <p className="text-sm font-black text-gray-900">{group.name}</p>
              <p className="text-[11px] text-gray-400">{hasVariations ? `${group.variations.length} sizes/options` : single.variation}</p>
              <p className="mt-1 text-sm font-black text-gray-900">{hasVariations ? `From Rs ${formatter.format(cheapest)}` : `Rs ${formatter.format(single.price)}`}</p>
              {hasVariations ? (
                <button type="button" onClick={() => handleGroupTap(group)} className="mt-2 w-full rounded-xl bg-[#E2F33C] py-2 text-xs font-black text-black">
                  {groupCartCount > 0 ? `${groupCartCount} in cart - Select` : 'Select'}
                </button>
              ) : line ? (
                <div className="mt-2 flex items-center justify-between rounded-xl bg-[#F8F9FB] px-2 py-1.5">
                  <button type="button" onClick={() => changeQuantity(single, -1)} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white"><Minus size={14} /></button>
                  <span className="text-sm font-black">{line.quantity}</span>
                  <button type="button" onClick={() => changeQuantity(single, 1)} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white"><Plus size={14} /></button>
                </div>
              ) : (
                <button type="button" onClick={() => handleGroupTap(group)} className="mt-2 w-full rounded-xl bg-[#E2F33C] py-2 text-xs font-black text-black">Add</button>
              )}
            </div>
          );
        })}
        {visibleGroups.length === 0 ? <p className="col-span-full py-10 text-center text-sm text-gray-400">No items in this category.</p> : null}
      </div>

      {variationPickerGroup ? (
        <VariationPickerSheet
          group={variationPickerGroup}
          onSelect={(variation) => {
            addToCart(variation);
            setVariationPickerGroup(null);
          }}
          onClose={() => setVariationPickerGroup(null)}
        />
      ) : null}

      {cartCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowCart(true)}
          className="fixed bottom-4 left-1/2 flex w-[92%] max-w-md -translate-x-1/2 items-center justify-between rounded-2xl bg-black px-5 py-4 text-white shadow-xl"
        >
          <span className="flex items-center gap-2 text-sm font-black"><ShoppingCart size={18} /> {cartCount} item{cartCount === 1 ? '' : 's'}</span>
          <span className="text-sm font-black">Rs {formatter.format(cartTotal)} · Checkout</span>
        </button>
      ) : null}

      {showCart ? (
        <div className="fixed inset-0 z-30 flex items-end bg-black/50 sm:items-center sm:justify-center">
          <div className="max-h-[90vh] w-full overflow-y-auto rounded-t-[28px] bg-white p-6 sm:max-w-md sm:rounded-[28px]">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-black text-gray-900">Your Order</h2>
              <button type="button" onClick={() => setShowCart(false)}><X size={20} className="text-gray-400" /></button>
            </div>

            <div className="space-y-3">
              {cartLines.map((line) => (
                <div key={cartKey(line.product)} className="flex items-center justify-between rounded-xl bg-[#F8F9FB] p-3">
                  <div>
                    <p className="text-sm font-black text-gray-900">{line.product.name}</p>
                    <p className="text-xs text-gray-400">Rs {formatter.format(line.product.price)} x {line.quantity}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => changeQuantity(line.product, -1)} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white"><Minus size={14} /></button>
                    <span className="text-sm font-black">{line.quantity}</span>
                    <button type="button" onClick={() => changeQuantity(line.product, 1)} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white"><Plus size={14} /></button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex justify-between border-t border-gray-100 pt-4 text-sm font-black">
              <span>Total</span>
              <span>Rs {formatter.format(cartTotal)}</span>
            </div>

            <div className="mt-5 space-y-3">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-gray-400">Order Type</p>
              <div className="flex gap-2">
                {(['DineIn', 'TakeAway', 'Delivery'] as OrderType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setOrderType(type)}
                    className={`flex-1 rounded-xl py-2.5 text-xs font-black ${orderType === type ? 'bg-black text-white' : 'bg-[#F8F9FB] text-gray-500'}`}
                  >
                    {type === 'DineIn' ? 'Dine-In' : type}
                  </button>
                ))}
              </div>

              <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Your name" className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm outline-none" />
              <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value.replace(/[^\d]/g, ''))} placeholder="Phone number" inputMode="numeric" className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm outline-none" />
              {orderType === 'Delivery' ? (
                <div>
                  <input value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} placeholder="Delivery address" className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm outline-none" />
                  <p className="mt-1.5 flex items-center gap-1.5 text-[11px] font-bold text-amber-700">
                    <MapPin size={12} /> We'll ask to share your live location when you place the order - this is required for delivery so the rider can find you.
                  </p>
                </div>
              ) : null}

              {activeOrderWarning ? (
                <div className="rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-800">
                  <div className="flex items-center gap-2">
                    <AlertCircle size={14} className="shrink-0" />
                    <span>
                      You already have an active order{activeOrderWarning.table ? ` at Table ${activeOrderWarning.table}` : ''} (#{activeOrderWarning.dailyOrderNumber}).
                      Please wait until it's completed before placing another.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate(`/order/${shopId}/status/${activeOrderWarning.id}`)}
                    className="mt-2 w-full rounded-lg bg-amber-800/10 py-2 text-xs font-black text-amber-900"
                  >
                    Track that order
                  </button>
                </div>
              ) : null}

              {orderType === 'DineIn' && !activeOrderWarning ? (
                <div>
                  <p className="mb-2 text-xs font-black uppercase tracking-[0.14em] text-gray-400">Choose Your Table</p>
                  <div className="flex flex-wrap gap-2">
                    {tableOptions.map((tableNumber) => {
                      const isOccupied = occupiedTables.has(tableNumber) && table !== tableNumber;
                      const isActive = table === tableNumber;
                      return (
                        <button
                          key={tableNumber}
                          type="button"
                          disabled={isOccupied}
                          onClick={() => setTable(tableNumber)}
                          className={`rounded-xl px-3 py-2 text-xs font-black ${isActive ? 'bg-black text-white' : isOccupied ? 'cursor-not-allowed bg-gray-100 text-gray-300' : 'bg-[#F8F9FB] text-gray-700'}`}
                        >
                          {formatTableLabel(tableNumber)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <p className="mt-3 text-xs font-black uppercase tracking-[0.14em] text-gray-400">Payment</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setPaymentMethod('Cash')} className={`flex-1 rounded-xl py-2.5 text-xs font-black ${paymentMethod === 'Cash' ? 'bg-black text-white' : 'bg-[#F8F9FB] text-gray-500'}`}>Cash</button>
                {/* Always offered, even with no JazzCash/EasyPaisa merchant
                    credentials configured - the customer just tells the
                    shop they'll pay online (bank transfer/personal
                    EasyPaisa-JazzCash account/etc) and staff confirms it
                    manually, same as they would with cash in hand. See
                    publicOrderController.js's createOrder for the
                    isOnlineIntent handling. */}
                <button type="button" onClick={() => setPaymentMethod('Online')} className={`flex-1 rounded-xl py-2.5 text-xs font-black ${paymentMethod === 'Online' ? 'bg-black text-white' : 'bg-[#F8F9FB] text-gray-500'}`}>Online</button>
                {menu?.paymentMethods.jazzCash ? (
                  <button type="button" onClick={() => setPaymentMethod('JazzCash')} className={`flex-1 rounded-xl py-2.5 text-xs font-black ${paymentMethod === 'JazzCash' ? 'bg-black text-white' : 'bg-[#F8F9FB] text-gray-500'}`}>JazzCash</button>
                ) : null}
                {menu?.paymentMethods.easyPaisa ? (
                  <button type="button" onClick={() => setPaymentMethod('EasyPaisa')} className={`flex-1 rounded-xl py-2.5 text-xs font-black ${paymentMethod === 'EasyPaisa' ? 'bg-black text-white' : 'bg-[#F8F9FB] text-gray-500'}`}>EasyPaisa</button>
                ) : null}
              </div>
              {paymentMethod === 'Online' ? (
                <p className="text-[11px] font-semibold text-gray-400">You'll pay the shop directly online (bank transfer, EasyPaisa, or JazzCash) - they'll confirm your order once payment is received.</p>
              ) : paymentMethod === 'JazzCash' || paymentMethod === 'EasyPaisa' ? (
                <p className="text-[11px] font-semibold text-gray-400">You'll be taken to {paymentMethod}'s secure payment page next - your order is confirmed automatically once payment clears.</p>
              ) : null}

              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any special instructions..." className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm outline-none" rows={2} />

              {placeError ? <p className="text-xs font-bold text-rose-600">{placeError}</p> : null}

              <button
                type="button"
                onClick={() => void handlePlaceOrder()}
                disabled={!canSubmit || placing || Boolean(activeOrderWarning)}
                className="w-full rounded-2xl bg-[#E2F33C] py-4 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50"
              >
                {placing ? (orderType === 'Delivery' ? 'Getting Your Location...' : 'Placing Order...') : `Place Order · Rs ${formatter.format(cartTotal)}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
