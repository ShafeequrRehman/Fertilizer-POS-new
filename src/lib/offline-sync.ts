import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isDesktopApp } from '@/lib/api';
import { getAuthShop } from '@/lib/auth';
import { useNetworkStatus } from '@/lib/network-status';
import {
  ackLocalOrders,
  ackOrderEdits,
  ackOrderCancellations,
  getPendingLocalOrders,
  getPendingOrderEdits,
  getPendingOrderCancellations,
  markOrderCancellationFailed,
  markOrderEditFailed,
  markLocalOrderFailed,
  getSyncStatus,
  isLocalHubReachable,
  pushOrdersCache,
  pushReferenceData,
  pushIngredientsCache,
  syncOrderCounter,
  syncLifetimeCounter,
  pushEmployeesCache,
  getPendingEmployeeCreates,
  ackEmployeeCreates,
  markEmployeeCreateFailed,
  getPendingEmployeeEdits,
  ackEmployeeEdits,
  markEmployeeEditFailed,
  getPendingEmployeeDeletes,
  ackEmployeeDeletes,
  markEmployeeDeleteFailed,
  getPendingCustomerActions,
  ackCustomerActions,
  markCustomerActionFailed,
  pushCustomersCache,
  type SyncStatus,
} from '@/lib/local-hub-api';
import { ApiError, fetchOrders, fetchProducts, fetchAllCustomers, fetchCustomerLedger, fetchWaiters, openShopSession, fetchShopSessionStatus, fetchIngredients, fetchIngredientCategories, fetchRecipes } from '@/lib/pos-api';
import { shopApi } from '@/lib/shop-api';
import { hasPendingLocalShopOpen, clearPendingLocalShopOpen } from '@/lib/shop-session';

// The offline sync engine: every SYNC_INTERVAL_MS, if this till is online,
// (1) pushes queued orders from the Local Hub (backend/localHub/) to the
// cloud's POST /orders/import-offline, acking whichever ones the cloud
// confirms it has, and (2) pushes a fresh copy of products/customers/
// waiters DOWN into the Local Hub so it's ready to serve offline order
// data (to this till's own offline POS view, and to any paired phone) the
// next time the internet drops. Only meaningful inside the Electron app -
// there's no Local Hub to talk to in a plain browser tab.
//
// Was 5 minutes back when this only mattered for genuine outages. Now
// that every order action (this till's own, via triggerBackgroundSync,
// AND a paired phone's - see pos-mobile's OrderDetailScreen/
// CheckoutScreen) queues to the Local Hub FIRST as the normal, always-on
// path rather than an outage fallback, this periodic tick is the ONLY
// thing that ever picks up something a phone queued (the Local Hub itself
// has no cloud credentials of its own to push with - see server.js's own
// comment on the security model - only this renderer, holding the shop's
// real session, can). Shortened so a phone-placed/edited order reaches
// the cloud (and therefore shows up for other tills) within seconds
// instead of minutes.
const SYNC_INTERVAL_MS = 15 * 1000;

export interface OfflineSyncResult {
  imported: number;
  skipped: number;
  failed: number;
  editsApplied?: number;
  editsFailed?: number;
  // Offline Manage Staff - see syncEmployeeQueues below. Combines all three
  // staff queues (creates/edits/deletes) into one count, same as
  // editsApplied/editsFailed do for order edits.
  staffApplied?: number;
  staffFailed?: number;
  // Offline Cancel Order - see syncOrderCancellations below. A failure here
  // most often means the Cancel Order Key entered offline turned out to be
  // wrong once actually checked against the cloud (see cancelOrderCore in
  // orderController.js) - wrongKeyOrderIds specifically calls those out so
  // a consumer (DashboardShell.tsx) can surface a clear "this cancellation
  // needs to be redone with the correct key" alert instead of a generic
  // failure count.
  cancellationsApplied?: number;
  cancellationsFailed?: number;
  wrongKeyOrderIds?: string[];
  // Conflict resolution surfacing - see orderController.js's
  // importOfflineOrders/importOfflineOrderUpdates for where these
  // `reason`-tagged failures originate. Neither is retried into eventually
  // succeeding on its own (a table conflict needs a different table, a
  // version conflict needs the edit redone against fresh data) - these
  // lists are what let DashboardShell.tsx flag them for a human instead of
  // letting them silently keep failing in the background forever.
  tableConflictOrderIds?: string[];
  versionConflictOrderIds?: string[];
  // Offline Customer Dues - see syncCustomerActions below.
  customerActionsApplied?: number;
  customerActionsFailed?: number;
  error?: string;
}

// Second phase of a sync tick - pushes order-card edits (add items,
// complete payment, etc.) queued while offline against orders that
// already had a real cloud _id (see local-hub-api.ts's queueOrderEdit /
// backend/localHub/localOrders.js). Orders both created AND edited
// entirely offline never go through here - their final state was already
// baked into the create queue directly (updateQueuedOrder), so
// runSyncNow's order-import phase above is all they ever need. Never
// throws - a failed edit is reported back but doesn't block the rest of
// the sync tick (reference-data push, etc.).
async function syncOrderEdits(): Promise<{ applied: number; failed: number; versionConflictOrderIds: string[] }> {
  const pendingEdits = await getPendingOrderEdits();
  if (pendingEdits.length === 0) return { applied: 0, failed: 0, versionConflictOrderIds: [] };

  try {
    const response = await api.post('/orders/import-offline-updates', {
      updates: pendingEdits.map((edit) => ({
        localEditId: edit.id,
        orderId: edit.orderId,
        offlineUpdatedAt: edit.queuedAt,
        payload: edit.payload,
        // See localOrders.js's queueOrderEdit - lets importOfflineOrderUpdates
        // suppress pendingKitchenUpdate so the background KitchenUpdateWatcher
        // never prints a delta this till already printed offline.
        kitchenPrinted: edit.kitchenPrinted,
        // Same idea, for the customer/cashier receipt - lets
        // importOfflineOrderUpdates mark customerReceiptPrintedAt so
        // ReceiptPrintWatcher never prints a receipt this till already
        // printed offline at completion time.
        receiptPrinted: edit.receiptPrinted,
        // Conflict resolution - see localOrders.js's queueOrderEdit and
        // importOfflineOrderUpdates's own comment on how this is used.
        expectedVersion: edit.expectedVersion,
      })),
    });

    const { applied = [], skipped = [], failed: failedEntries = [] } = response.data as {
      applied: Array<{ localEditId: string }>;
      skipped: Array<{ localEditId: string }>;
      failed: Array<{ localEditId: string; orderId?: string; error: string; reason?: string }>;
    };

    // A skipped edit (e.g. the order it targeted somehow no longer
    // exists) is still acked - retrying it forever would never succeed,
    // and it'd just sit there confusing the pending-edit count.
    const confirmedIds = [...applied, ...skipped].map((entry) => entry.localEditId);
    await ackOrderEdits(confirmedIds);

    // A version-conflict failure never resolves itself by retrying - the
    // edit was built against data another till has since changed. Mark it
    // failed (surfaced on OfflineSyncPage.tsx, same as any other failed
    // edit) so staff know to refresh and redo it, same "reject + flag"
    // treatment as a wrong Cancel Order Key.
    const versionConflictOrderIds = failedEntries
      .filter((entry) => entry.reason === 'version_conflict' && entry.orderId)
      .map((entry) => entry.orderId as string);
    for (const entry of failedEntries) {
      void markOrderEditFailed(entry.localEditId, entry.error);
    }

    return { applied: applied.length, failed: pendingEdits.length - confirmedIds.length, versionConflictOrderIds };
  } catch {
    return { applied: 0, failed: pendingEdits.length, versionConflictOrderIds: [] };
  }
}

// Third phase - replays a Cancel Order made while offline (see
// CancelOrderModal.tsx + localOrders.js's queueOrderCancellation) against
// the real, bcrypt-gated cancel endpoint. Deliberately separate from
// syncOrderEdits above and its own dedicated backend route (see
// orderController.js's importOfflineCancellations) - applyOrderPatch,
// which syncOrderEdits relies on, rejects status:"cancelled" outright.
// Never throws - same "report it back, don't block the rest of the sync
// tick" contract as every other phase here.
async function syncOrderCancellations(): Promise<{ applied: number; failed: number; wrongKeyOrderIds: string[] }> {
  const pending = await getPendingOrderCancellations();
  if (pending.length === 0) return { applied: 0, failed: 0, wrongKeyOrderIds: [] };

  try {
    const response = await api.post('/orders/import-offline-cancellations', {
      cancellations: pending.map((entry) => ({
        localCancellationId: entry.id,
        orderId: entry.orderId,
        key: entry.key,
        reason: entry.reason,
      })),
    });

    const { applied = [], failed: failedEntries = [] } = response.data as {
      applied: Array<{ localCancellationId: string; orderId: string }>;
      failed: Array<{ localCancellationId: string; orderId: string; error: string; reason?: string }>;
    };

    const appliedIds = applied.map((entry) => entry.localCancellationId);
    if (appliedIds.length) await ackOrderCancellations(appliedIds);

    const wrongKeyOrderIds: string[] = [];
    for (const entry of failedEntries) {
      // Clears the (now-used) key from local storage regardless of why it
      // failed - see localOrders.js's markCancellationFailed. A genuine
      // wrong key needs a fresh Cancel Order Key entry to retry either way,
      // never a silent replay of the same value.
      await markOrderCancellationFailed(entry.localCancellationId, entry.error);
      if (entry.reason === 'wrong_key') wrongKeyOrderIds.push(entry.orderId);
    }

    return { applied: appliedIds.length, failed: failedEntries.length, wrongKeyOrderIds };
  } catch {
    return { applied: 0, failed: pending.length, wrongKeyOrderIds: [] };
  }
}

// --- Offline Manage Staff sync - the staff-CRUD counterpart to
// syncOrderEdits above. See backend/localHub/localStaff.js for the queue
// design. None of these three ever throw - a failed record is reported
// back (and marked failed so OfflineSyncPage.tsx can surface it) but never
// blocks the rest of the sync tick.

async function syncEmployeeCreates(): Promise<{ applied: number; failed: number }> {
  const pending = await getPendingEmployeeCreates();
  if (pending.length === 0) return { applied: 0, failed: 0 };

  const appliedIds: string[] = [];
  let failed = 0;

  for (const record of pending) {
    try {
      // roleName was only ever denormalized into the queued payload for
      // offline display (see offline-staff-helpers.ts's
      // localEmployeeToSummary) - the cloud only wants the real roleId.
      const { roleName: _roleName, ...payload } = record.payload as Record<string, unknown> & { roleName?: string };
      await shopApi.createEmployee(payload);
      appliedIds.push(record.id);
    } catch (error) {
      const reason = (error as { response?: { data?: { reason?: string } } })?.response?.data?.reason;
      if (reason === 'username_taken') {
        // Most likely this exact create already succeeded on an earlier
        // sync attempt (e.g. it landed on the cloud but the connection
        // dropped again before this till got to ack it) - treat it as
        // already-synced rather than retrying forever against a username
        // that will never become available. If it's a genuine collision
        // with someone else's account instead, the shop owner will notice
        // the staff member missing from Manage Staff and can re-create them
        // under a different username.
        appliedIds.push(record.id);
      } else {
        failed += 1;
        const message = error instanceof Error ? error.message : 'Sync failed - will retry automatically.';
        await markEmployeeCreateFailed(record.id, message);
      }
    }
  }

  if (appliedIds.length) await ackEmployeeCreates(appliedIds);
  return { applied: appliedIds.length, failed };
}

async function syncEmployeeEdits(): Promise<{ applied: number; failed: number }> {
  const pending = await getPendingEmployeeEdits();
  if (pending.length === 0) return { applied: 0, failed: 0 };

  const appliedIds: string[] = [];
  let failed = 0;

  for (const record of pending) {
    try {
      await shopApi.updateEmployee(record.employeeId, record.payload);
      appliedIds.push(record.id);
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        // The target employee is gone (e.g. a queued delete for the same
        // employee already synced first) - nothing left to apply this
        // edit to.
        appliedIds.push(record.id);
      } else {
        failed += 1;
        const message = error instanceof Error ? error.message : 'Sync failed - will retry automatically.';
        await markEmployeeEditFailed(record.id, message);
      }
    }
  }

  if (appliedIds.length) await ackEmployeeEdits(appliedIds);
  return { applied: appliedIds.length, failed };
}

async function syncEmployeeDeletes(): Promise<{ applied: number; failed: number }> {
  const pending = await getPendingEmployeeDeletes();
  if (pending.length === 0) return { applied: 0, failed: 0 };

  const appliedIds: string[] = [];
  let failed = 0;

  for (const record of pending) {
    try {
      await shopApi.deleteEmployee(record.employeeId);
      appliedIds.push(record.id);
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        // Already gone - a previous sync attempt likely already deleted it.
        appliedIds.push(record.id);
      } else {
        failed += 1;
        const message = error instanceof Error ? error.message : 'Sync failed - will retry automatically.';
        await markEmployeeDeleteFailed(record.id, message);
      }
    }
  }

  if (appliedIds.length) await ackEmployeeDeletes(appliedIds);
  return { applied: appliedIds.length, failed };
}

// Runs all three staff queues in one call - order doesn't affect
// correctness (a queued edit/delete only ever targets a staff member that
// already had a real cloud _id before this offline stretch, never one
// still sitting in the creates queue - see localStaff.js), creates just go
// first for tidiness.
// Offline Customer Dues - replays whatever "Add Customer" / "+ Add Dues" /
// "- Pay Dues" actions were queued while offline (see
// backend/localHub/localCustomerActions.js / offline-dues-helpers.ts)
// against the same real customerController.js logic the online routes
// use. One flat queue (unlike orders' three), so this is a single call
// instead of syncOrderEdits + syncOrderCancellations' separate phases.
async function syncCustomerActions(): Promise<{ applied: number; failed: number }> {
  const pending = await getPendingCustomerActions();
  if (pending.length === 0) return { applied: 0, failed: 0 };

  try {
    const response = await api.post('/customers/import-offline-actions', {
      actions: pending.map((action) => ({
        clientActionId: action.id,
        kind: action.kind,
        ...action.payload,
      })),
    });

    const { results = [] } = response.data as {
      results: Array<{ clientActionId: string; success: boolean; error?: string }>;
    };

    const succeededIds = results.filter((entry) => entry.success).map((entry) => entry.clientActionId);
    if (succeededIds.length) await ackCustomerActions(succeededIds);

    for (const entry of results) {
      if (!entry.success) void markCustomerActionFailed(entry.clientActionId, entry.error || 'Sync failed');
    }

    return { applied: succeededIds.length, failed: pending.length - succeededIds.length };
  } catch {
    return { applied: 0, failed: pending.length };
  }
}

async function syncEmployeeQueues(): Promise<{ applied: number; failed: number }> {
  const [creates, edits, deletes] = await Promise.all([
    syncEmployeeCreates(),
    syncEmployeeEdits(),
    syncEmployeeDeletes(),
  ]);
  return {
    applied: creates.applied + edits.applied + deletes.applied,
    failed: creates.failed + edits.failed + deletes.failed,
  };
}

export async function runSyncNow(): Promise<OfflineSyncResult> {
  if (!isDesktopApp()) return { imported: 0, skipped: 0, failed: 0 };

  const hubUp = await isLocalHubReachable();
  if (!hubUp) return { imported: 0, skipped: 0, failed: 0, error: 'Local Hub is not reachable on this till.' };

  // If "Open Shop" was tapped while offline (see shop-session.tsx's
  // openLocally()), the cloud still doesn't have a real ShopSession - and
  // import-offline below needs one to assign real dailyOrderNumbers. Open
  // it for real now, before touching any queued orders. A 409 here just
  // means someone/something else already opened it in the meantime
  // (e.g. another device, or this same till syncing twice) - either way
  // the cloud now has an open session, which is all this step needs.
  if (hasPendingLocalShopOpen()) {
    try {
      await openShopSession();
      clearPendingLocalShopOpen();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        clearPendingLocalShopOpen();
      } else {
        return {
          imported: 0,
          skipped: 0,
          failed: 0,
          error: 'Could not reconcile opening the shop offline with the server yet - will retry automatically.',
        };
      }
    }
  }

  const pending = await getPendingLocalOrders();
  let result: OfflineSyncResult = { imported: 0, skipped: 0, failed: 0 };
  let tableConflictLocalOrderIds: string[] = [];

  if (pending.length > 0) {
    try {
      const response = await api.post('/orders/import-offline', {
        orders: pending.map((order) => ({
          localOrderId: order.id,
          localOrderNumber: order.localOrderNumber,
          // Tr# / shopSequenceNumber - see localOrders.js's queueOrder and
          // orderController.js's importOfflineOrders (reads this as
          // entry.localSequenceNumber).
          localSequenceNumber: order.shopSequenceNumber,
          offlineCreatedAt: order.queuedAt,
          payload: order.payload,
          // See localOrders.js's queueOrder - lets importOfflineOrders mark
          // the cloud record as already-printed so the background print
          // watchers never print it a second time.
          kitchenPrinted: order.kitchenPrinted,
          receiptPrinted: order.receiptPrinted,
        })),
      });

      const { imported = [], skipped = [], failed: failedEntries = [] } = response.data as {
        imported: Array<{ localOrderId: string }>;
        skipped: Array<{ localOrderId: string }>;
        failed: Array<{ localOrderId: string; error: string; reason?: string }>;
      };

      const confirmedIds = [...imported, ...skipped].map((entry) => entry.localOrderId);
      await ackLocalOrders(confirmedIds);

      // A table-conflict failure never resolves itself by retrying - the
      // table it was queued against already has another device's order on
      // it. Mark it failed (surfaced on OfflineSyncPage.tsx) so it's
      // visible, and report the still-local order ids (see
      // localOrderToSavedOrder's "local-" prefix) so DashboardShell.tsx can
      // point staff at the "Change Table" action that unblocks it.
      tableConflictLocalOrderIds = failedEntries
        .filter((entry) => entry.reason === 'table_conflict')
        .map((entry) => `local-${entry.localOrderId}`);
      for (const entry of failedEntries) {
        void markLocalOrderFailed(entry.localOrderId, entry.error);
      }

      result = { imported: imported.length, skipped: skipped.length, failed: pending.length - confirmedIds.length };
    } catch (error) {
      result = {
        imported: 0,
        skipped: 0,
        failed: pending.length,
        error: error instanceof Error ? error.message : 'Sync failed - will retry automatically.',
      };
    }
  }

  // Edits run regardless of whether there were any new orders to create -
  // an order created earlier (before this offline stretch, or synced
  // earlier in this same tick above) can still have edits queued against
  // it with nothing new needing to be created.
  const editsResult = await syncOrderEdits();

  // Same "runs regardless of what else happened this tick" reasoning as
  // editsResult above - a queued cancellation targets an order that could
  // have existed well before this offline stretch even started.
  const cancellationsResult = await syncOrderCancellations();

  // Offline Manage Staff - completely independent of the order queue above
  // (different Local Hub queue entirely, see localStaff.js), so it always
  // runs regardless of whether there were any orders to sync this tick.
  const staffResult = await syncEmployeeQueues();

  // Offline Customer Dues - same "always runs, independent queue" as
  // staff above (see localCustomerActions.js).
  const customerActionsResult = await syncCustomerActions();

  // Whatever this tick just imported (or found nothing to import), pull
  // the cloud's now-current session + orderCounter and hand it to the
  // Local Hub - this is what keeps the local counter caught up even when
  // no order happened to be placed right at reconnect (e.g. a quiet till
  // that just came back online) rather than relying only on
  // shop-session.tsx's own refresh() calls or a just-placed order's own
  // push. See local-hub-api.ts's syncOrderCounter.
  try {
    const status = await fetchShopSessionStatus();
    if (status?.isOpen && status.session) {
      await syncOrderCounter(status.session.id, status.session.orderCounter ?? 0);
    }
    // Tr# / shopSequenceNumber's counter - present regardless of isOpen
    // (unlike orderCounter above), and never resets. See
    // local-hub-api.ts's syncLifetimeCounter.
    if (status) {
      await syncLifetimeCounter(status.shopSequenceCounter ?? 0);
    }
  } catch {
    // Best-effort - not worth failing the whole sync tick over.
  }

  return {
    ...result,
    editsApplied: editsResult.applied,
    editsFailed: editsResult.failed,
    staffApplied: staffResult.applied,
    staffFailed: staffResult.failed,
    cancellationsApplied: cancellationsResult.applied,
    cancellationsFailed: cancellationsResult.failed,
    wrongKeyOrderIds: cancellationsResult.wrongKeyOrderIds,
    tableConflictOrderIds: tableConflictLocalOrderIds,
    versionConflictOrderIds: editsResult.versionConflictOrderIds,
    customerActionsApplied: customerActionsResult.applied,
    customerActionsFailed: customerActionsResult.failed,
  };
}

// Fire-and-forget sync trigger for the "always local-first" order actions
// (POSPage placement, SalesPage's Add Items/Complete Payment,
// EditOrderPage, CancelOrderModal, RecordPage's Complete Order) - every one
// of those writes to the Local Hub queue immediately and returns instantly
// regardless of connectivity, then calls this right after so the cloud
// (and therefore other tills / the paired phone) finds out within a
// second or two instead of waiting on the regular SYNC_INTERVAL_MS timer.
// Safe to call even when genuinely offline - runSyncNow no-ops the moment
// it can't reach the Local Hub or the cloud, and the regular timer (or the
// reconnect-triggered sync in useOfflineSync) picks the backlog back up
// once connectivity actually returns. The in-flight guard just avoids
// piling up redundant sync attempts if several actions happen in quick
// succession (e.g. placing several orders back to back).
let backgroundSyncInFlight = false;
export function triggerBackgroundSync(): void {
  if (!isDesktopApp() || backgroundSyncInFlight) return;
  backgroundSyncInFlight = true;
  (async () => {
    try {
      await runSyncNow();
      // Keeps this till's own order list / table-occupancy view correct
      // immediately after a sync, not just the cloud's copy - relevant
      // since Sales/Kitchen/table-picker all render from these caches
      // (see offline-order-helpers.ts's loadOrdersFromLocalHub), never a
      // live call.
      await pushCurrentOrdersCache();
      // Same reasoning, for Customer Dues - see offline-dues-helpers.ts's
      // loadCustomersFromLocalHub.
      await pushCurrentCustomersLedgerCache();
    } catch {
      // Best-effort, same as every other background push in this file.
    } finally {
      backgroundSyncInFlight = false;
    }
  })();
}

export async function pushCurrentReferenceData(): Promise<void> {
  if (!isDesktopApp()) return;
  const hubUp = await isLocalHubReachable();
  if (!hubUp) return;

  try {
    const [productsResult, customers, waiters, roles] = await Promise.all([
      fetchProducts(),
      fetchAllCustomers(),
      fetchWaiters(),
      shopApi.listRoles(),
    ]);

    await pushReferenceData({
      shopName: getAuthShop()?.name || '',
      products: productsResult?.products || [],
      customers: customers || [],
      staff: waiters || [],
      roles: roles || [],
    });
  } catch {
    // Best-effort - the next 5-minute tick will just try again. Nothing
    // here should ever interrupt normal online usage.
  }
}

// Ingredient Stock / Recipe Management's own reference-data-shaped push -
// see backend/localHub/ingredientsCache.js. Kept separate from
// pushCurrentReferenceData above (rather than folded into one call) since
// these are a different, larger dataset (a shop's full ingredient/recipe
// catalog) that only IngredientStockSection.tsx/RecipeManagementSection.tsx
// ever need, refreshed on the same best-effort background cadence.
export async function pushCurrentIngredientsCache(): Promise<void> {
  if (!isDesktopApp()) return;
  const hubUp = await isLocalHubReachable();
  if (!hubUp) return;

  try {
    const [ingredients, categories, recipes] = await Promise.all([
      fetchIngredients(),
      fetchIngredientCategories(),
      fetchRecipes(),
    ]);

    await pushIngredientsCache({
      ingredients: ingredients || [],
      categories: categories || [],
      recipes: recipes || [],
    });
  } catch {
    // Best-effort - same reasoning as pushCurrentReferenceData.
  }
}

// The order-list counterpart to pushCurrentReferenceData above - see
// orderCache.js / offline-order-helpers.ts's mergeOrdersForDisplay.
// Bounded to the last 14 days for the same reason getOrders' `since`
// param exists at all (see orderController.js) - this is a background
// push, not something a cashier is ever waiting on, but there's still no
// reason to pull (and store locally) a shop's entire lifetime history
// just to answer "what does today's/last shift's order list look like".
export async function pushCurrentOrdersCache(): Promise<void> {
  if (!isDesktopApp()) return;
  const hubUp = await isLocalHubReachable();
  if (!hubUp) return;

  try {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const orders = await fetchOrders({ since });
    await pushOrdersCache(orders || []);
  } catch {
    // Best-effort - same reasoning as pushCurrentReferenceData.
  }
}

// Manage Staff's own full employee-list cache - see employeesCache.js for
// why this is separate from pushCurrentReferenceData's lightweight `staff`
// (waiter dropdown) field. EmployeesPage.tsx also does its own best-effort
// push right after a successful online load (see its `load()`), so this
// periodic one mainly covers "the till came back online on some other page
// and Manage Staff hasn't been opened yet this session".
// Customer Dues' own full-ledger cache - see customersCache.js /
// offline-dues-helpers.ts's loadCustomersFromLocalHub. Separate from
// pushCurrentReferenceData's lightweight `customers` field (a bare
// name+phone list for the POS checkout customer picker) - DuesPage.tsx
// needs the FULL ledger shape (previousDues, duesHistory, orders,
// purchases, netBalance, ...) fetchCustomerLedger returns.
export async function pushCurrentCustomersLedgerCache(): Promise<void> {
  if (!isDesktopApp()) return;
  const hubUp = await isLocalHubReachable();
  if (!hubUp) return;

  try {
    const customers = await fetchCustomerLedger();
    await pushCustomersCache(customers || []);
  } catch {
    // Best-effort - same reasoning as pushCurrentReferenceData.
  }
}

export async function pushCurrentEmployeesCache(): Promise<void> {
  if (!isDesktopApp()) return;
  const hubUp = await isLocalHubReachable();
  if (!hubUp) return;

  try {
    const employees = await shopApi.listEmployees();
    await pushEmployeesCache(employees || []);
  } catch {
    // Best-effort - same reasoning as pushCurrentReferenceData.
  }
}

// Mounted once near the app root (see DashboardShell.tsx) so the 5-minute
// timer runs for the lifetime of the dashboard session, independent of
// which page is currently open. Also exposes a manual trigger + live
// status for OfflineSyncPage.tsx.
export function useOfflineSync() {
  const { isOnline } = useNetworkStatus();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [lastResult, setLastResult] = useState<OfflineSyncResult | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const refreshStatus = useCallback(async () => {
    if (!isDesktopApp()) return;
    try {
      const hubUp = await isLocalHubReachable();
      if (hubUp) setStatus(await getSyncStatus());
    } catch {
      // Ignore - status is best-effort telemetry, not load-bearing.
    }
  }, []);

  const syncNow = useCallback(async () => {
    if (!isDesktopApp() || isSyncing) return;
    setIsSyncing(true);
    try {
      const result = await runSyncNow();
      setLastResult(result);
      setLastSyncAt(new Date());
      await pushCurrentReferenceData();
      await pushCurrentIngredientsCache();
      await pushCurrentOrdersCache();
      await pushCurrentEmployeesCache();
      await pushCurrentCustomersLedgerCache();
      await refreshStatus();
      return result;
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing, refreshStatus]);

  useEffect(() => {
    if (!isDesktopApp()) return;
    void refreshStatus();

    const intervalId = window.setInterval(() => {
      if (isOnlineRef.current) void syncNow();
    }, SYNC_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync the moment connectivity comes back, instead of waiting for the
  // next scheduled tick (up to 5 minutes away). This matters for more than
  // speed: until a backlog of offline orders syncs, the cloud's own ticket
  // counter hasn't advanced past wherever it was before this till went
  // offline - POSPage.tsx already refuses to hand out a cloud number to a
  // brand new order while any backlog is still pending (see its
  // hasLocalBacklog check), specifically to avoid a repeated/colliding
  // order number - but shrinking this window still means real cloud
  // numbers come back for new orders sooner rather than staying queued
  // locally for however long is left on the 5-minute clock.
  const wasOnline = useRef(isOnline);
  useEffect(() => {
    if (!isDesktopApp()) return;
    if (isOnline && !wasOnline.current) {
      void syncNow();
    }
    wasOnline.current = isOnline;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  return { status, lastSyncAt, lastResult, isSyncing, syncNow, refreshStatus };
}
