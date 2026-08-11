import axios from 'axios';

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
