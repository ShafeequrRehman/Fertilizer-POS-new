import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isDesktopApp } from '@/lib/api';
import { getAuthShop } from '@/lib/auth';
import { useNetworkStatus } from '@/lib/network-status';
import {
  ackLocalOrders,
  getPendingLocalOrders,
  getSyncStatus,
  isLocalHubReachable,
  pushReferenceData,
  type SyncStatus,
} from '@/lib/local-hub-api';
import { fetchProducts, fetchAllCustomers, fetchWaiters } from '@/lib/pos-api';

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
  error?: string;
}

export async function runSyncNow(): Promise<OfflineSyncResult> {
  if (!isDesktopApp()) return { imported: 0, skipped: 0, failed: 0 };

  const hubUp = await isLocalHubReachable();
  if (!hubUp) return { imported: 0, skipped: 0, failed: 0, error: 'Local Hub is not reachable on this till.' };

  const pending = await getPendingLocalOrders();
  if (pending.length === 0) return { imported: 0, skipped: 0, failed: 0 };

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

    return { imported: imported.length, skipped: skipped.length, failed: pending.length - confirmedIds.length };
  } catch (error) {
    return {
      imported: 0,
      skipped: 0,
      failed: pending.length,
      error: error instanceof Error ? error.message : 'Sync failed - will retry automatically.',
    };
  }
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

  return { status, lastSyncAt, lastResult, isSyncing, syncNow, refreshStatus };
}
