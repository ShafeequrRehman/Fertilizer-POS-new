import type { Discount, OrderPayload, OrderUpdatePayload, SavedOrder } from '@/lib/pos-types';
import { queueOrderEdit, updateQueuedLocalOrder, type LocalOrderRecord } from '@/lib/local-hub-api';

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
export async function saveOrderEditOffline(order: SavedOrder, patch: OrderUpdatePayload): Promise<SavedOrder> {
  if (order.id.startsWith('local-')) {
    const localId = order.id.slice('local-'.length);
    const record = await updateQueuedLocalOrder(localId, patch);
    return localOrderToSavedOrder(record);
  }
  await queueOrderEdit(order.id, patch);
  return applyPatchOptimistically(order, patch);
}
