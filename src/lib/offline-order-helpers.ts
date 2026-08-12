import type { Discount, OrderPayload, OrderUpdatePayload, SavedOrder } from '@/lib/pos-types';
import {
  getOrdersCache,
  getPendingLocalOrders,
  getPendingOrderEdits,
  queueOrderEdit,
  updateQueuedLocalOrder,
  type LocalOrderEditRecord,
  type LocalOrderRecord,
} from '@/lib/local-hub-api';

// Shared by SalesPage.tsx and EditOrderPage.tsx - the two places an
// existing order gets edited (as opposed to POSPage.tsx, which only ever
// creates new ones). See local-hub-api.ts's "Editing an order while
// offline" section and backend/localHub/localOrders.js for the full
// design: an order being edited either already has a real cloud _id (its
// edit gets queued for the backend to replay for real once synced) or is
// itself still only local/unsynced (its queued create record just gets
// mutated directly - see updateQueuedLocalOrder).

// Turns a locally-queued (not-yet-synced) order into the same shape the
// rest of the UI already knows how to render.
export function localOrderToSavedOrder(record: LocalOrderRecord): SavedOrder {
  const payload = (record.payload || {}) as Partial<OrderPayload>;
  return {
    ...payload,
    id: `local-${record.id}`,
    dailyOrderNumber: payload.dailyOrderNumber ?? record.localOrderNumber,
    items: payload.items ?? [],
    total: payload.total ?? 0,
    subtotal: payload.subtotal ?? payload.total ?? 0,
    tax: payload.tax ?? 0,
    orderType: payload.orderType ?? 'DineIn',
    customer: payload.customer ?? { name: '', phone: '', address: '' },
    address: payload.address ?? '',
    note: payload.note ?? '',
    waiter: payload.waiter ?? '',
    table: payload.table ?? '',
    status: payload.status ?? 'pending',
    paymentMethod: payload.paymentMethod ?? 'Cash',
    createdAt: payload.createdAt ?? record.queuedAt,
  } as SavedOrder;
}

function computeDiscountAmount(discount: Discount | null | undefined, subtotal: number): number {
  if (!discount) return 0;
  const value = Number(discount.value) || 0;
  if (value <= 0 || subtotal <= 0) return 0;
  if (discount.type === 'percent') return Math.min(Math.round((subtotal * value) / 100), subtotal);
  return Math.min(Math.round(value), subtotal);
}

type KitchenItem = SavedOrder['items'][number];

function kitchenItemKey(item: { name: string; variation?: string }): string {
  return `${item.name}::${item.variation || ''}`;
}

function sumQuantitiesByKey(items: KitchenItem[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  (items || []).forEach((item) => {
    const key = kitchenItemKey(item);
    map.set(key, (map.get(key) || 0) + (Number(item.quantity) || 0));
  });
  return map;
}

// Client-side mirror of orderController.js's computeKitchenIncreaseDelta -
// what a "replaceItems" save (EditOrderPage.tsx's full editor) actually
// added that the kitchen needs to know about: only quantity INCREASES,
// whether that's an existing line going up or a brand new line appearing.
// Removed items / decreases go through a separate "kitchen-remove" ticket
// (see EditOrderPage.tsx's printKitchenRemoveTicket), same online or off.
export function computeKitchenIncreaseDelta(oldItems: KitchenItem[], newItems: KitchenItem[]): KitchenItem[] {
  const oldQuantities = sumQuantitiesByKey(oldItems);
  const newQuantities = sumQuantitiesByKey(newItems);
  const meta = new Map<string, { name: string; price: number; variation: string }>();
  (newItems || []).forEach((item) => {
    const key = kitchenItemKey(item);
    if (!meta.has(key)) meta.set(key, { name: item.name, price: item.price, variation: item.variation || '' });
  });

  const delta: KitchenItem[] = [];
  newQuantities.forEach((newQty, key) => {
    const oldQty = oldQuantities.get(key) || 0;
    const diff = newQty - oldQty;
    if (diff > 0) {
      const info = meta.get(key)!;
      delta.push({ ...info, quantity: diff } as KitchenItem);
    }
  });
  return delta;
}

// What the kitchen actually needs printed for a given edit, offline or on -
// exactly the same "what counts as new" rule applyOrderPatch uses on the
// backend (see orderController.js), so an offline print and the eventual
// synced pendingKitchenUpdate (when not suppressed) always agree.
export function computeKitchenPrintDelta(order: SavedOrder, patch: OrderUpdatePayload): KitchenItem[] {
  if (patch.action === 'addItems' && Array.isArray(patch.items)) {
    return (patch.items as KitchenItem[]).filter((item) => (Number(item.quantity) || 0) > 0);
  }
  if (patch.action === 'replaceItems' && Array.isArray(patch.items)) {
    return computeKitchenIncreaseDelta(order.items, patch.items as KitchenItem[]);
  }
  return [];
}

// Client-side mirror of the non-cascade branches of applyOrderPatch (see
// backend/controllers/orderController.js) - paints an immediate,
// reasonable-looking result on screen while offline. Never authoritative:
// the queued edit itself is replayed through the real backend logic once
// synced, so this only ever needs to look right for the moment, not be
// perfectly correct (e.g. it can't run completeAndSettle's cross-order
// dues cascade, since that needs a fresh read of the customer's other
// orders from the cloud).
export function applyPatchOptimistically(order: SavedOrder, patch: OrderUpdatePayload): SavedOrder {
  const next: SavedOrder = { ...order };
  const touchesItems = (patch.action === 'addItems' || patch.action === 'replaceItems') && Array.isArray(patch.items);

  if (patch.action === 'addItems' && Array.isArray(patch.items)) {
    next.items = [...next.items, ...patch.items];
  } else if (patch.action === 'replaceItems' && Array.isArray(patch.items)) {
    next.items = patch.items;
  }
  if (patch.discount !== undefined) next.discount = patch.discount;

  if (touchesItems || patch.discount !== undefined) {
    const subtotal = next.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const discountAmount = computeDiscountAmount(next.discount, subtotal);
    next.subtotal = subtotal;
    next.tax = 0;
    next.total = Math.max(subtotal - discountAmount, 0);
    next.discount = discountAmount > 0 ? next.discount : null;
    next.remainingAmount = Math.max(next.total - (next.paidAmount || 0), 0);
  }

  if (patch.action === 'completeAndSettle') {
    next.status = 'completed';
    next.paidAmount = Math.max(Number(patch.paidAmount) || 0, 0);
    next.remainingAmount = Math.max(next.total - next.paidAmount, 0);
    if (typeof patch.paymentMethod === 'string') next.paymentMethod = patch.paymentMethod;
    if (typeof patch.note === 'string') next.note = patch.note;
  } else {
    if (patch.note !== undefined) next.note = patch.note;
    if (patch.waiter !== undefined) next.waiter = patch.waiter;
    if (patch.table !== undefined) next.table = patch.table;
    if (patch.address !== undefined) next.address = patch.address;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.paymentMethod !== undefined) next.paymentMethod = patch.paymentMethod;
    if (typeof patch.paidAmount === 'number') next.paidAmount = patch.paidAmount;
    if (typeof patch.remainingAmount === 'number') next.remainingAmount = patch.remainingAmount;
  }
  if (patch.customer) next.customer = patch.customer;

  return next;
}

// Applies an order-card edit against either an already-synced cloud order
// (queues the edit for the sync engine to replay for real) or a still-only
// -local order (mutates its queued create payload directly) - returns the
// resulting SavedOrder for immediate display. Throws on a genuine Local
// Hub failure (e.g. unreachable), same as the online path throwing on a
// genuine network failure.
// `kitchenPrinted` - set by the caller (SalesPage.tsx/EditOrderPage.tsx)
// when it already attempted a kitchen print for this exact edit's delta
// items the instant it was made (see computeKitchenPrintDelta above) - only
// meaningful for the already-synced-order path below: it's what tells
// importOfflineOrderUpdates to suppress pendingKitchenUpdate once this edit
// replays for real, so DashboardShell.tsx's KitchenUpdateWatcher never
// prints the same delta a second time. A still-local order's edits don't
// need this - they get folded into the ONE queueOrder-level print flag
// already set when the order was first created (see localOrders.js), since
// the whole thing syncs as a single finished order via importOfflineOrders,
// never through the separate pendingKitchenUpdate path at all.
export async function saveOrderEditOffline(order: SavedOrder, patch: OrderUpdatePayload, kitchenPrinted = false): Promise<SavedOrder> {
  if (order.id.startsWith('local-')) {
    const localId = order.id.slice('local-'.length);
    const record = await updateQueuedLocalOrder(localId, patch);
    return localOrderToSavedOrder(record);
  }
  await queueOrderEdit(order.id, patch, undefined, kitchenPrinted);
  return applyPatchOptimistically(order, patch);
}

// Combines the Local Hub's cached cloud snapshot with whatever this till
// still has queued locally, into the one order list Dashboard/Sales/
// Kitchen actually render - see mergeOrdersForDisplay below for why this
// never needs a live cloud call to produce a correct-looking list.
function applyPendingEdits(cachedOrders: SavedOrder[], pendingEdits: LocalOrderEditRecord[]): Map<string, SavedOrder> {
  const byId = new Map(cachedOrders.map((order) => [order.id, order]));
  for (const edit of pendingEdits) {
    const target = byId.get(edit.orderId);
    if (target) {
      byId.set(edit.orderId, applyPatchOptimistically(target, edit.payload as OrderUpdatePayload));
    }
    // If the target isn't in the cache (e.g. this till hasn't refreshed
    // its cloud snapshot since the edit was queued), there's nothing to
    // apply it to for display yet - it's still safely queued for sync
    // either way, this is purely a display-completeness concern.
  }
  return byId;
}

// The single place Dashboard.tsx/SalesPage.tsx/KitchenPage.tsx build the
// order list they show - always from the Local Hub, NEVER a direct live
// cloud call (see offline-sync.ts's pushCurrentOrdersCache for how the
// cache snapshot stays fresh in the background). `cachedOrders` is
// whatever this till last successfully pulled from the cloud;
// `pendingNewRecords`/`pendingEdits` are this till's own not-yet-synced
// queue (see getPendingLocalOrders/getPendingOrderEdits) - overlaid on
// top so an order punched or edited seconds ago shows up immediately,
// with no dependence on connectivity at all.
export function mergeOrdersForDisplay(
  cachedOrders: SavedOrder[],
  pendingNewRecords: LocalOrderRecord[],
  pendingEdits: LocalOrderEditRecord[],
): SavedOrder[] {
  const byId = applyPendingEdits(cachedOrders, pendingEdits);
  const knownClientSyncIds = new Set(cachedOrders.map((order) => order.clientSyncId).filter(Boolean));

  for (const record of pendingNewRecords) {
    const clientSyncId = (record.payload as { clientSyncId?: string } | undefined)?.clientSyncId;
    // Already present in the cloud snapshot under its real _id - this
    // till just hasn't acked the local queue entry yet (or is mid-sync).
    // Showing both would be a confusing "the same order twice" duplicate,
    // and worse, would look exactly like the ticket-number-reuse bug this
    // whole cache exists to avoid.
    if (clientSyncId && knownClientSyncIds.has(clientSyncId)) continue;
    const order = localOrderToSavedOrder(record);
    byId.set(order.id, order);
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

// Fetches and merges all three sources in one call - what the load
// effects in Dashboard/Sales/Kitchen actually call.
export async function loadOrdersFromLocalHub(): Promise<SavedOrder[]> {
  const [cache, pendingNew, pendingEdits] = await Promise.all([
    getOrdersCache(),
    getPendingLocalOrders(),
    getPendingOrderEdits(),
  ]);
  return mergeOrdersForDisplay(cache.orders as SavedOrder[], pendingNew, pendingEdits);
}
