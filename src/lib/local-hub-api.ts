import axios from 'axios';
import { getIpcRenderer } from '@/lib/electron-bridge';
import { isDesktopApp } from '@/lib/api';

// Talks to THIS till's own Local Hub (backend/localHub/server.js), always
// on localhost since it's embedded in this same Electron app - never the
// cloud, and never another till's hub. See offline-sync.ts for the engine
// that uses these to actually push queued orders to the cloud, and
// OfflineSyncPage.tsx for the UI that shows pairing info / pending orders.
const LOCAL_HUB_BASE = 'http://localhost:5057';
const PAIRING_KEY_STORAGE = 'pos_local_hub_pairing_key';

const hub = axios.create({ baseURL: LOCAL_HUB_BASE, timeout: 6000 });

function getCachedPairingKey(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(PAIRING_KEY_STORAGE);
}

function setCachedPairingKey(key: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PAIRING_KEY_STORAGE, key);
}

hub.interceptors.request.use((config) => {
  const key = getCachedPairingKey();
  if (key) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>)['X-Pairing-Key'] = key;
  }
  return config;
});

export interface PairingInfo {
  ips: string[];
  port: number;
  pairingKey: string;
}

export interface LocalOrderRecord {
  id: string;
  localOrderNumber: number;
  payload: Record<string, unknown>;
  actor: { name?: string; deviceLabel?: string } | null;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  syncedAt: string | null;
  lastError: string | null;
}

export interface SyncStatus {
  pendingCount: number;
  failedCount: number;
  totalQueued: number;
  pendingEditCount?: number;
  failedEditCount?: number;
}

// Loopback-only calls (the till talking to its own hub) - fetches and
// caches the pairing key locally so every other call below can send it
// automatically via the request interceptor.
export async function getPairingInfo(): Promise<PairingInfo> {
  const response = await hub.get<PairingInfo>('/pairing-info');
  setCachedPairingKey(response.data.pairingKey);
  return response.data;
}

export async function rotatePairingKey(): Promise<string> {
  const response = await hub.post<{ pairingKey: string }>('/pairing/rotate');
  setCachedPairingKey(response.data.pairingKey);
  return response.data.pairingKey;
}

export async function isLocalHubReachable(): Promise<boolean> {
  try {
    await hub.get('/health', { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// Only meaningful right after isLocalHubReachable() returns false - asks
// Electron's main process (which actually owns the Local Hub's lifecycle,
// see main.js's startLocalHubServer) whether it ever managed to start at
// all, and why not. Lets the UI say "port 5057 is already in use" instead
// of a generic "not reachable" that looks identical to "just hasn't
// started yet" or "genuinely offline with no hub".
export async function getLocalHubStartDiagnostics(): Promise<{ started: boolean; error: string | null } | null> {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return null;
  try {
    return (await ipcRenderer.invoke('get-local-hub-status')) as { started: boolean; error: string | null };
  } catch {
    return null;
  }
}

export interface ReferenceDataSnapshot {
  updatedAt: string | null;
  shopName: string;
  products: unknown[];
  customers: unknown[];
  staff: unknown[];
}

export async function pushReferenceData(data: {
  shopName: string;
  products: unknown[];
  customers: unknown[];
  staff: unknown[];
}) {
  // Make sure the key is cached before this runs at least once per app
  // session - harmless if already cached (getPairingInfo is idempotent).
  if (!getCachedPairingKey()) await getPairingInfo();
  await hub.post('/reference-data', data);
}

// --- Orders cache (see backend/localHub/orderCache.js) -------------------
// The order-list counterpart to reference data above - a snapshot of this
// shop's recent cloud orders, read by Dashboard/Sales/Kitchen ALWAYS
// (never a direct live cloud call from those pages - see
// offline-order-helpers.ts's mergeOrdersForDisplay for how this gets
// combined with whatever's still only queued locally), refreshed in the
// background by offline-sync.ts's pushCurrentOrdersCache whenever online.

export interface OrdersCacheSnapshot {
  updatedAt: string | null;
  orders: unknown[];
}

export async function pushOrdersCache(orders: unknown[]) {
  if (!getCachedPairingKey()) await getPairingInfo();
  await hub.post('/orders-cache', { orders });
}

export async function getOrdersCache(): Promise<OrdersCacheSnapshot> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<OrdersCacheSnapshot>('/orders-cache');
  return response.data;
}

// Read back whatever was last pushed - what POSPage.tsx falls back to for
// its product grid (and waiter dropdown) when this till itself is
// offline, since fetchProducts()/fetchWaiters() (the normal cloud calls)
// have nothing to reach at that point.
export async function getReferenceData(): Promise<ReferenceDataSnapshot> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<ReferenceDataSnapshot>('/reference-data');
  return response.data;
}

export async function createLocalOrder(payload: object, actor?: { name?: string; deviceLabel?: string }) {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<LocalOrderRecord>('/orders', { payload, actor });
  return response.data;
}

export async function getPendingLocalOrders(): Promise<LocalOrderRecord[]> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<LocalOrderRecord[]>('/orders/pending');
  return response.data;
}

export async function ackLocalOrders(ids: string[]) {
  if (ids.length === 0) return;
  await hub.post('/orders/ack', { ids });
}

export async function markLocalOrderFailed(id: string, error: string) {
  await hub.post(`/orders/${id}/fail`, { error });
}

export async function getSyncStatus(): Promise<SyncStatus> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<SyncStatus>('/sync/status');
  return response.data;
}

// --- Editing an order while offline -------------------------------------
// See backend/localHub/localOrders.js's "Editing an order while offline"
// section for the full split between these two cases (still-local order
// vs. one that already has a real cloud _id) - SalesPage.tsx's saveUpdate()
// picks between the two functions below based on whether the order's id
// starts with "local-".

export interface LocalOrderEditRecord {
  id: string;
  orderId: string;
  payload: Record<string, unknown>;
  actor: { name?: string; deviceLabel?: string } | null;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  syncedAt: string | null;
  lastError: string | null;
}

// Mutates a still-unsynced local order's own queued payload directly -
// localId is the order's Local Hub id with the "local-" prefix already
// stripped off (see SalesPage.tsx's localOrderToSavedOrder).
export async function updateQueuedLocalOrder(localId: string, payload: object): Promise<LocalOrderRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.patch<LocalOrderRecord>(`/orders/local/${localId}`, { payload });
  return response.data;
}

// Queues an edit against an order that already has a real cloud _id, to be
// replayed by the sync engine (offline-sync.ts) via the cloud's
// POST /orders/import-offline-updates once back online.
export async function queueOrderEdit(orderId: string, payload: object, actor?: { name?: string; deviceLabel?: string }): Promise<LocalOrderEditRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<LocalOrderEditRecord>(`/orders/${orderId}/edits`, { payload, actor });
  return response.data;
}

export async function getPendingOrderEdits(): Promise<LocalOrderEditRecord[]> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<LocalOrderEditRecord[]>('/orders/edits/pending');
  return response.data;
}

export async function ackOrderEdits(ids: string[]) {
  if (ids.length === 0) return;
  await hub.post('/orders/edits/ack', { ids });
}

export async function markOrderEditFailed(id: string, error: string) {
  await hub.post(`/orders/edits/${id}/fail`, { error });
}

// --- Keeping the local order counter in step with the cloud's real
// ShopSession.orderCounter, regardless of connectivity -------------------
// See backend/localHub/localOrders.js's syncOrderCounter for the full
// reasoning. Call this every time the till successfully learns the
// cloud's current session id + orderCounter (shop-session.tsx's refresh(),
// and right after any successful online order create/import) - it's what
// makes order numbering present as ONE unbroken sequence per shift no
// matter how many times connectivity drops and comes back mid-shift, while
// still correctly starting a genuinely new shift back at 1.
export async function syncOrderCounter(sessionId: string | null, orderCounter: number): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    if (!getCachedPairingKey()) await getPairingInfo();
    await hub.post('/order-counter-sync', { sessionId, orderCounter });
  } catch {
    // Best-effort - if this particular push fails, the next successful one
    // (there are several opportunities per online moment) will catch it up.
  }
}

// Called the instant Open Shop is tapped while offline - see
// shop-session.tsx's openLocally(). There's no cloud session to learn a
// fresh orderCounter from yet at that moment, so this is what makes a
// brand new shift's numbering start at 1 immediately even if the till
// stays offline for a while after opening - see localOrders.js's
// resetCounter for why syncOrderCounter alone can't cover this case.
export async function resetLocalOrderCounter(): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    if (!getCachedPairingKey()) await getPairingInfo();
    await hub.post('/order-counter/reset');
  } catch {
    // Best-effort, same reasoning as syncOrderCounter above.
  }
}
