import { isDesktopApp } from '@/lib/api';
import type { Customer, DuesHistoryEntry, LedgerCustomer } from '@/lib/pos-types';
import {
  getCustomersCache,
  getPendingCustomerActions,
  queueCustomerAction,
  type LocalCustomerActionRecord,
} from '@/lib/local-hub-api';
import { ApiError } from '@/lib/pos-api';
import { triggerBackgroundSync } from '@/lib/offline-sync';

// Customer Dues offline support - the same "always show something local
// first, queue writes that can't reach the cloud right now" idea as
// offline-order-helpers.ts, but scoped to a single flat action queue (see
// backend/localHub/localCustomerActions.js's own comment on why one queue
// is enough here, unlike orders' three).
//
// Unlike Orders (which are ALWAYS written local-first, online or not -
// see offline-order-helpers.ts), Customer Dues writes still try the real
// cloud call FIRST (DuesPage.tsx's existing behaviour, unchanged) and only
// fall back to queuing here when that call fails for a connectivity
// reason (see isConnectivityFailure below) rather than a real rejection
// (bad input, a duplicate phone, a permission error) - a genuine
// rejection should still show the cashier an error, not silently vanish
// into a queue that will just fail again the same way once synced.

// True for a failure that's about NOT BEING ABLE TO REACH THE SERVER at
// all (offline, DNS failure, timeout, a 502/503/504 from a proxy/gateway
// mid-outage) - false for a real answer FROM the server that happens to
// be an error (400 validation, 404 not found, 409 conflict, 500 with a
// real message). Mirrors api.ts's own isRetryableStatus reasoning.
export function isConnectivityFailure(error: unknown): boolean {
  if (error instanceof ApiError) {
    return !error.status || error.status >= 500;
  }
  return true;
}

function pendingCreateToLedgerCustomer(action: LocalCustomerActionRecord): LedgerCustomer {
  const payload = action.payload as Partial<Customer>;
  const previousDues = Number(payload.previousDues || 0);
  return {
    id: `local-${action.id}`,
    name: payload.name || '',
    phone: payload.phone || '',
    address: payload.address || '',
    previousDues,
    orderCount: 0,
    totalBilled: 0,
    totalPaid: 0,
    totalOrderBalance: 0,
    totalDue: previousDues,
    totalPurchaseBalance: 0,
    netBalance: previousDues,
    lastOrderAt: null,
    orders: [],
    purchases: [],
    duesHistory: [],
  };
}

// Applies a pending "+ Add Dues"/"- Pay Dues" action optimistically onto
// its matching cached customer (by phone) so the on-screen balance/
// History already reflects it while it's still only queued, not yet
// synced - exactly what a shop owner needs to see to keep working through
// a slow/offline stretch without the numbers looking wrong or stale.
function applyPendingDuesAction(customer: LedgerCustomer, action: LocalCustomerActionRecord): LedgerCustomer {
  const payload = action.payload as { previousDues?: number; amount?: number; note?: string; paymentMethod?: 'cash' | 'bank' };
  const isAdd = action.kind === 'add_due';
  const nextPreviousDues = isAdd
    ? Number(payload.previousDues || 0)
    : Number(customer.previousDues || 0) - Number(payload.amount || 0);
  const delta = nextPreviousDues - Number(customer.previousDues || 0);
  if (delta === 0) return customer;

  const entry: DuesHistoryEntry = {
    type: delta > 0 ? 'add' : 'settle',
    amount: Math.abs(delta),
    note: `${payload.note ? `${payload.note} - ` : ''}(saved offline, will sync automatically)`,
    balanceAfter: nextPreviousDues,
    createdBy: action.actor?.name || '',
    createdAt: action.queuedAt,
    paymentMethod: payload.paymentMethod === 'bank' ? 'bank' : 'cash',
  };

  return {
    ...customer,
    previousDues: nextPreviousDues,
    totalDue: customer.totalDue + delta,
    netBalance: customer.netBalance + delta,
    duesHistory: [...customer.duesHistory, entry],
  };
}

// The single function DuesPage.tsx calls to load its list - always reads
// the Local Hub cache first (near-instant, local, works with no internet
// at all), then layers whatever's still only queued (a customer added
// offline, or a dues action against an existing one) on top, so nothing
// the cashier already did while offline ever silently disappears from the
// list until it's actually confirmed synced.
export async function loadCustomersFromLocalHub(): Promise<LedgerCustomer[]> {
  const [cache, pendingActions] = await Promise.all([getCustomersCache(), getPendingCustomerActions()]);
  const customers = (cache.customers as LedgerCustomer[]) || [];
  const byPhone = new Map(customers.map((customer) => [customer.phone, customer]));

  for (const action of pendingActions) {
    if (action.kind === 'create') {
      const phone = (action.payload as Partial<Customer>).phone;
      // Already present in the cloud snapshot - this till just hasn't
      // acked the queue entry yet (or is mid-sync). Avoid a duplicate row.
      if (phone && byPhone.has(phone)) continue;
      const provisional = pendingCreateToLedgerCustomer(action);
      if (provisional.phone) byPhone.set(provisional.phone, provisional);
    } else {
      const phone = (action.payload as { phone?: string }).phone;
      const existing = phone ? byPhone.get(phone) : null;
      if (existing) byPhone.set(phone as string, applyPendingDuesAction(existing, action));
    }
  }

  return Array.from(byPhone.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Queues an "Add Customer" made while the cloud couldn't be reached (see
// isConnectivityFailure above) - returns an optimistic LedgerCustomer so
// the caller can merge it into on-screen state immediately, same as a
// successful online create would. Kicks off a background sync attempt
// right away (best-effort, same as every offline order action) so it
// reaches the cloud the moment connectivity actually allows it, without
// waiting for the next scheduled tick.
export async function queueCreateCustomerOffline(
  payload: Omit<Customer, 'id'>,
  actor?: { name?: string },
): Promise<LedgerCustomer> {
  const record = await queueCustomerAction('create', payload as Record<string, unknown>, actor);
  triggerBackgroundSync();
  return pendingCreateToLedgerCustomer(record);
}

// Queues a "+ Add Dues" made while offline - returns the optimistically-
// patched customer so DuesPage.tsx can update its on-screen card at once.
export async function queueAddDueOffline(
  customer: LedgerCustomer,
  body: { previousDues: number; note?: string; paymentMethod?: 'cash' | 'bank'; bankId?: string },
  actor?: { name?: string },
): Promise<LedgerCustomer> {
  const record = await queueCustomerAction('add_due', { phone: customer.phone, ...body }, actor);
  triggerBackgroundSync();
  return applyPendingDuesAction(customer, record);
}

// Queues a "- Pay Dues"/"Clear" made while offline - same shape as
// queueAddDueOffline above, for the settle side.
export async function queueSettleDueOffline(
  customer: LedgerCustomer,
  body: { amount: number; note?: string; paymentMethod?: 'cash' | 'bank'; bankId?: string },
  actor?: { name?: string },
): Promise<LedgerCustomer> {
  const record = await queueCustomerAction('settle_due', { phone: customer.phone, ...body }, actor);
  triggerBackgroundSync();
  return applyPendingDuesAction(customer, record);
}

// Convenience guard DuesPage.tsx uses before even trying the offline path
// - queuing only ever makes sense inside the Electron till app, which is
// the only place with a Local Hub to queue into (see local-hub-api.ts).
export const canQueueCustomerActionsOffline = isDesktopApp;
