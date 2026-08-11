import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isDesktopApp } from '@/lib/api';
import { getAuthShop } from '@/lib/auth';
import { useNetworkStatus } from '@/lib/network-status';
import {
  ackLocalOrders,
  ackOrderEdits,
  getPendingLocalOrders,
  getPendingOrderEdits,
  getSyncStatus,
  isLocalHubReachable,
  pushOrdersCache,
  pushReferenceData,
  syncOrderCounter,
  type SyncStatus,
} from '@/lib/local-hub-api';
import { ApiError, fetchOrders, fetchProducts, fetchAllCustomers, fetchWaiters, openShopSession, fetchShopSessionStatus } from '@/lib/pos-api';
import { hasPendingLocalShopOpen, clearPendingLocalShopOpen } from '@/lib/shop-session';

// The offline sync engine: every SYNC_INTERVAL_MS, if this till is online,
// (1) pushes queued orders from the Local Hub (backend/localHub/) to the
// cloud's POST /orders/import-offline, acking whichever ones the cloud
// confirms it has, and (2) pushes a fresh copy of products/customers/
// waiters DOWN into the Local Hub so it's ready to serve offline order
// data (to this till's own offline POS view, and to any paired phone) the
// next time the internet drops. Only meaningful inside the Electron app -
// there's no Local Hub to talk to in a plain browser tab.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

export interface OfflineSyncResult {
  imported: number;
  skipped: number;
  failed: number;
  editsApplied?: number;
  editsFailed?: number;
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
async function syncOrderEdits(): Promise<{ applied: number; failed: number }> {
  const pendingEdits = await getPendingOrderEdits();
  if (pendingEdits.length === 0) return { applied: 0, failed: 0 };

  try {
    const response = await api.post('/orders/import-offline-updates', {
      updates: pendingEdits.map((edit) => ({
        localEditId: edit.id,
        orderId: edit.orderId,
        offlineUpdatedAt: edit.queuedAt,
        payload: edit.payload,
      })),
    });

    const { applied = [], skipped = [] } = response.data as {
      applied: Array<{ localEditId: string }>;
      skipped: Array<{ localEditId: string }>;
      failed: Array<{ localEditId: string; error: string }>;
    };

    // A skipped edit (e.g. the order it targeted somehow no longer
    // exists) is still acked - retrying it forever would never succeed,
    // and it'd just sit there confusing the pending-edit count.
    const confirmedIds = [...applied, ...skipped].map((entry) => entry.localEditId);
    await ackOrderEdits(confirmedIds);

    return { applied: applied.length, failed: pendingEdits.length - confirmedIds.length };
  } catch {
    return { applied: 0, failed: pendingEdits.length };
  }
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
          error: 'Could not reconcile the offline shop-open with the server yet - will retry automatically.',
        };
      }
    }
  }

  const pending = await getPendingLocalOrders();
  let result: OfflineSyncResult = { imported: 0, skipped: 0, failed: 0 };

  if (pending.length > 0) {
    try {
      const response = await api.post('/orders/import-offline', {
        orders: pending.map((order) => ({
          localOrderId: order.id,
          localOrderNumber: order.localOrderNumber,
          offlineCreatedAt: order.queuedAt,
          payload: order.payload,
        })),
      });

      const { imported = [], skipped = [] } = response.data as {
        imported: Array<{ localOrderId: string }>;
        skipped: Array<{ localOrderId: string }>;
        failed: Array<{ localOrderId: string; error: string }>;
      };

      const confirmedIds = [...imported, ...skipped].map((entry) => entry.localOrderId);
      await ackLocalOrders(confirmedIds);

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
  } catch {
    // Best-effort - not worth failing the whole sync tick over.
  }

  return { ...result, editsApplied: editsResult.applied, editsFailed: editsResult.failed };
}

export async function pushCurrentReferenceData(): Promise<void> {
  if (!isDesktopApp()) return;
  const hubUp = await isLocalHubReachable();
  if (!hubUp) return;

  try {
    const [productsResult, customers, waiters] = await Promise.all([
      fetchProducts(),
      fetchAllCustomers(),
      fetchWaiters(),
    ]);

    await pushReferenceData({
      shopName: getAuthShop()?.name || '',
      products: productsResult?.products || [],
      customers: customers || [],
      staff: waiters || [],
    });
  } catch {
    // Best-effort - the next 5-minute tick will just try again. Nothing
    // here should ever interrupt normal online usage.
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
      await pushCurrentOrdersCache();
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
