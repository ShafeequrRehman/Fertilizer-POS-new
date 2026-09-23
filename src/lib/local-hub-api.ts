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

// A pairing key cached in this renderer's localStorage can go stale without
// ever being cleared - e.g. the Local Hub's own storage got reset/migrated,
// or the key was rotated from the Offline Sync page in a different window -
// while `getCachedPairingKey()` above still happily returns the old value,
// so every one of getOrCreatePairingKey's callers above skip re-fetching it
// (they only fetch when NOTHING is cached, not when what's cached is
// wrong). Left alone, that's every Local Hub call 401ing forever until the
// user manually clears localStorage. On a 401 here (and only here - a 401
// is never a legitimate response from any of these routes), drop the stale
// key, ask the hub for its current one via the loopback-only /pairing-info,
// and replay the original request exactly once with it.
let pairingRefresh: Promise<string> | null = null;

async function refreshPairingKeyOnce(): Promise<string> {
  if (!pairingRefresh) {
    pairingRefresh = hub
      .get<PairingInfo>('/pairing-info')
      .then((response) => {
        setCachedPairingKey(response.data.pairingKey);
        return response.data.pairingKey;
      })
      .finally(() => {
        pairingRefresh = null;
      });
  }
  return pairingRefresh;
}

hub.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error?.response?.status;
    const config = error?.config as (typeof error.config & { _retriedAfterKeyRefresh?: boolean }) | undefined;
    const isPairingInfoCall = String(config?.url || '').includes('/pairing-info');

    if (status === 401 && config && !config._retriedAfterKeyRefresh && !isPairingInfoCall) {
      config._retriedAfterKeyRefresh = true;
      try {
        const freshKey = await refreshPairingKeyOnce();
        config.headers = config.headers ?? {};
        (config.headers as Record<string, string>)['X-Pairing-Key'] = freshKey;
        return hub.request(config);
      } catch {
        // Hub itself is unreachable or refusing /pairing-info too - fall
        // through to the original 401, nothing more to try here.
      }
    }

    return Promise.reject(error);
  },
);

export interface PairingInfo {
  ips: string[];
  // address -> adapter name (e.g. "Wi-Fi", "vEthernet (WSL)") - see
  // server.js's listLanAddresses for why a bare IP list isn't enough to
  // tell a real WiFi adapter apart from a virtual one (Docker/WSL/Hyper-V/
  // VPN) that a phone on the same physical WiFi can never actually reach.
  // Optional only so an old cached hub build (pre-upgrade, before a
  // restart picks up the new server.js) doesn't break this type.
  interfaceNames?: Record<string, string>;
  port: number;
  pairingKey: string;
}

export interface LocalOrderRecord {
  id: string;
  localOrderNumber: number;
  // Shop-lifetime, never-resetting "Tr#" counter - see localOrders.js's
  // nextLifetimeNumber. Assigned automatically by queueOrder, unlike
  // localOrderNumber's cousin on the cloud side (requestedDailyOrderNumber),
  // there's no separate reserve step needed for the OFFLINE path since
  // queueOrder always reserves both numbers together in one call.
  shopSequenceNumber: number;
  payload: Record<string, unknown>;
  actor: { name?: string; deviceLabel?: string } | null;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  syncedAt: string | null;
  lastError: string | null;
  // Whether this till already attempted a kitchen/customer-receipt print
  // for this order the instant it was queued - see POSPage.tsx and
  // localOrders.js's queueOrder. Carried through to the cloud on sync so
  // DashboardShell.tsx's background print watchers never print it again.
  kitchenPrinted?: boolean;
  receiptPrinted?: boolean;
}

export interface SyncStatus {
  pendingCount: number;
  failedCount: number;
  totalQueued: number;
  pendingEditCount?: number;
  failedEditCount?: number;
  // Offline Manage Staff - see localStaff.js / server.js's /sync/status.
  pendingStaffCount?: number;
  failedStaffCount?: number;
  pendingStaffEditCount?: number;
  failedStaffEditCount?: number;
  pendingStaffDeleteCount?: number;
  failedStaffDeleteCount?: number;
  // Offline Cancel Order - see localOrders.js's "Cancelling an ALREADY-
  // SYNCED order while offline" section / server.js's /sync/status.
  pendingCancellationCount?: number;
  failedCancellationCount?: number;
  // Offline Customer Dues - see localCustomerActions.js / server.js's
  // /sync/status.
  pendingCustomerActionCount?: number;
  failedCustomerActionCount?: number;
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
  // Role catalog ({_id, name, permissions}) - see referenceData.js. Lets
  // EmployeesPage.tsx's staff form populate its Role dropdown while
  // offline.
  roles: unknown[];
}

export async function pushReferenceData(data: {
  shopName: string;
  products: unknown[];
  customers: unknown[];
  staff: unknown[];
  // Optional and omittable on purpose - see referenceData.js's set(). A
  // caller that doesn't have a fresh roles list handy (e.g. POSPage.tsx's
  // frequent products/waiters-only push) can leave this out entirely
  // rather than being forced to explicitly wipe it with [].
  roles?: unknown[];
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

// --- Customer Dues ledger cache (see backend/localHub/customersCache.js) -
// same read-through-cache shape as Orders above: DuesPage.tsx always reads
// this first (see offline-dues-helpers.ts's loadCustomersFromLocalHub),
// refreshed in the background whenever the till successfully loads the
// ledger from the cloud.
export interface CustomersCacheSnapshot {
  updatedAt: string | null;
  customers: unknown[];
}

export async function pushCustomersCache(customers: unknown[]) {
  if (!getCachedPairingKey()) await getPairingInfo();
  await hub.post('/customers-cache', { customers });
}

export async function getCustomersCache(): Promise<CustomersCacheSnapshot> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<CustomersCacheSnapshot>('/customers-cache');
  return response.data;
}

// --- Customer Dues offline write queue (see
// backend/localHub/localCustomerActions.js) - one shared queue for
// Add Customer / + Add Dues / - Pay Dues, each tagged with its own kind
// so a mixed batch replays in one sync pass. See offline-dues-helpers.ts.
export interface LocalCustomerActionRecord {
  id: string;
  kind: 'create' | 'add_due' | 'settle_due';
  payload: Record<string, unknown>;
  actor: { name?: string } | null;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  syncedAt: string | null;
  lastError: string | null;
}

export async function queueCustomerAction(
  kind: 'create' | 'add_due' | 'settle_due',
  payload: Record<string, unknown>,
  actor?: { name?: string },
): Promise<LocalCustomerActionRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<LocalCustomerActionRecord>('/customer-actions', { kind, payload, actor });
  return response.data;
}

export async function getPendingCustomerActions(): Promise<LocalCustomerActionRecord[]> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<LocalCustomerActionRecord[]>('/customer-actions/pending');
  return response.data;
}

export async function ackCustomerActions(ids: string[]) {
  if (ids.length === 0) return;
  await hub.post('/customer-actions/ack', { ids });
}

export async function markCustomerActionFailed(id: string, error: string) {
  await hub.post(`/customer-actions/${id}/fail`, { error });
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

// --- Ingredient Stock / Recipe Management offline snapshot ----------------
// See backend/localHub/ingredientsCache.js for the full design - a
// read-only cache (ingredients, categories, recipes) pushed down while
// online, read back by IngredientStockSection.tsx/RecipeManagementSection.tsx
// the moment a live cloud call fails, so those screens show cached data
// with an offline estimate layered on top (see
// offline-ingredient-helpers.ts) instead of a blank error state.
export interface IngredientsCacheSnapshot {
  updatedAt: string | null;
  ingredients: unknown[];
  categories: unknown[];
  recipes: unknown[];
}

export async function pushIngredientsCache(data: { ingredients: unknown[]; categories: unknown[]; recipes: unknown[] }) {
  if (!getCachedPairingKey()) await getPairingInfo();
  await hub.post('/ingredients-cache', data);
}

export async function getIngredientsCache(): Promise<IngredientsCacheSnapshot> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<IngredientsCacheSnapshot>('/ingredients-cache');
  return response.data;
}

export async function createLocalOrder(
  payload: object,
  actor?: { name?: string; deviceLabel?: string },
  printFlags?: { kitchen?: boolean; receipt?: boolean },
) {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<LocalOrderRecord>('/orders', { payload, actor, printFlags });
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

// Reserves the next ticket number from THIS till's Local Hub without
// queuing an order record - called right before placing an order straight
// online (see POSPage.tsx), so the number is always decided locally first,
// online or offline. Throws if the Local Hub can't be reached; the caller
// falls back to letting the cloud assign its own number in that case
// (see orderController.js's createOrder - requestedDailyOrderNumber is
// optional).
export async function reserveLocalOrderNumber(): Promise<number> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<{ number: number }>('/orders/reserve-number');
  return response.data.number;
}

// Same idea as reserveLocalOrderNumber above, but for the shop-lifetime
// Tr# counter (backend/models/Shop.js's orderSequenceCounter) - see
// localOrders.js's reserveNextLifetimeNumber. Also throws on failure; the
// caller falls back to letting the cloud assign its own number.
export async function reserveLifetimeOrderNumber(): Promise<number> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<{ number: number }>('/orders/reserve-lifetime-number');
  return response.data.number;
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
  // Whether this till already attempted a kitchen print for this edit's
  // delta items the instant it was queued - see offline-order-helpers.ts's
  // computeKitchenPrintDelta and orderController.js's importOfflineOrderUpdates.
  kitchenPrinted?: boolean;
  // Same idea, for the customer/cashier receipt - set when this edit is a
  // completeAndSettle that already printed the receipt offline (DineIn/
  // Delivery orders print their receipt at completion, not placement - see
  // SalesPage.tsx's saveUpdate).
  receiptPrinted?: boolean;
  // Conflict resolution - the order.version this till last knew about when
  // the edit was queued. See orderController.js's importOfflineOrderUpdates
  // for how a mismatch (another till changed this order first) gets
  // rejected and flagged instead of silently applied.
  expectedVersion?: number;
}

// Mutates a still-unsynced local order's own queued payload directly -
// localId is the order's Local Hub id with the "local-" prefix already
// stripped off (see SalesPage.tsx's localOrderToSavedOrder). receiptPrinted
// mirrors queueOrderEdit's own param below - see localOrders.js's
// updateQueuedOrder.
export async function updateQueuedLocalOrder(localId: string, payload: object, receiptPrinted = false): Promise<LocalOrderRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.patch<LocalOrderRecord>(`/orders/local/${localId}`, { payload, receiptPrinted });
  return response.data;
}

// Queues an edit against an order that already has a real cloud _id, to be
// replayed by the sync engine (offline-sync.ts) via the cloud's
// POST /orders/import-offline-updates once back online.
export async function queueOrderEdit(
  orderId: string,
  payload: object,
  actor?: { name?: string; deviceLabel?: string },
  kitchenPrinted = false,
  receiptPrinted = false,
  expectedVersion?: number,
): Promise<LocalOrderEditRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<LocalOrderEditRecord>(`/orders/${orderId}/edits`, { payload, actor, kitchenPrinted, receiptPrinted, expectedVersion });
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

// --- Cancelling an ALREADY-SYNCED order while offline ---------------------
// See backend/localHub/localOrders.js's own "Cancelling an ALREADY-SYNCED
// order while offline" section - a completely separate queue from
// queueOrderEdit above, since a cancellation has to be replayed against
// the real, bcrypt-gated cancelOrder logic (POST /orders/import-offline-
// cancellations), not applyOrderPatch. CancelOrderModal.tsx picks between
// this and a plain updateQueuedLocalOrder({status:'cancelled', ...}) call
// the same way saveUpdate() already does for edits - based on whether the
// order's id starts with "local-".

export interface LocalOrderCancellationRecord {
  id: string;
  orderId: string;
  key: string | null;
  reason: string;
  actor: { name?: string; deviceLabel?: string } | null;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  syncedAt: string | null;
  lastError: string | null;
}

export async function queueOrderCancellation(
  orderId: string,
  key: string,
  reason?: string,
  actor?: { name?: string; deviceLabel?: string },
): Promise<LocalOrderCancellationRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<LocalOrderCancellationRecord>(`/orders/${orderId}/cancellations`, { key, reason, actor });
  return response.data;
}

export async function getPendingOrderCancellations(): Promise<LocalOrderCancellationRecord[]> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<LocalOrderCancellationRecord[]>('/orders/cancellations/pending');
  return response.data;
}

export async function ackOrderCancellations(ids: string[]) {
  if (ids.length === 0) return;
  await hub.post('/orders/cancellations/ack', { ids });
}

export async function markOrderCancellationFailed(id: string, error: string) {
  await hub.post(`/orders/cancellations/${id}/fail`, { error });
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

// Same idea as syncOrderCounter above, for the shop-lifetime Tr# counter -
// see localOrders.js's syncLifetimeCounter. No reset equivalent - this
// counter is never reset on shop open, only ever reconciled upward.
export async function syncLifetimeCounter(shopSequenceCounter: number): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    if (!getCachedPairingKey()) await getPairingInfo();
    await hub.post('/lifetime-counter-sync', { value: shopSequenceCounter });
  } catch {
    // Best-effort, same reasoning as syncOrderCounter above.
  }
}

// --- Manage Staff's own full employee-list cache (see employeesCache.js) -
// EmployeesPage.tsx's cache-first counterpart to getOrdersCache/
// pushOrdersCache above. Separate from getReferenceData's `staff` field on
// purpose - see employeesCache.js's header comment.

export interface EmployeesCacheSnapshot {
  updatedAt: string | null;
  employees: unknown[];
}

export async function pushEmployeesCache(employees: unknown[]) {
  if (!getCachedPairingKey()) await getPairingInfo();
  await hub.post('/employees-cache', { employees });
}

export async function getEmployeesCache(): Promise<EmployeesCacheSnapshot> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<EmployeesCacheSnapshot>('/employees-cache');
  return response.data;
}

// --- Offline Manage Staff (see backend/localHub/localStaff.js for the
// full design) ------------------------------------------------------------

export interface LocalEmployeeRecord {
  id: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  syncedAt: string | null;
  lastError: string | null;
}

export interface LocalEmployeeEditRecord {
  id: string;
  employeeId: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  syncedAt: string | null;
  lastError: string | null;
}

export interface LocalEmployeeDeleteRecord {
  id: string;
  employeeId: string;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  syncedAt: string | null;
  lastError: string | null;
}

// Queues a brand-new staff member - no real cloud _id exists yet.
export async function queueEmployeeCreate(payload: object): Promise<LocalEmployeeRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<LocalEmployeeRecord>('/employees', { payload });
  return response.data;
}

export async function getPendingEmployeeCreates(): Promise<LocalEmployeeRecord[]> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<LocalEmployeeRecord[]>('/employees/pending');
  return response.data;
}

export async function ackEmployeeCreates(ids: string[]) {
  if (ids.length === 0) return;
  await hub.post('/employees/ack', { ids });
}

export async function markEmployeeCreateFailed(id: string, error: string) {
  await hub.post(`/employees/${id}/fail`, { error });
}

// Mutates a still-unsynced queued create's own payload directly - localId
// is the record's own id (with any "local-" display prefix already
// stripped by the caller, mirroring updateQueuedLocalOrder above).
export async function updateQueuedLocalEmployee(localId: string, payload: object): Promise<LocalEmployeeRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.patch<LocalEmployeeRecord>(`/employees/local/${localId}`, { payload });
  return response.data;
}

export async function deleteQueuedLocalEmployee(localId: string): Promise<void> {
  if (!getCachedPairingKey()) await getPairingInfo();
  await hub.delete(`/employees/local/${localId}`);
}

// Queues an edit/delete against a staff member that already has a real
// cloud _id, to be replayed by the sync engine once back online.
export async function queueEmployeeEdit(employeeId: string, payload: object): Promise<LocalEmployeeEditRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<LocalEmployeeEditRecord>(`/employees/${employeeId}/edits`, { payload });
  return response.data;
}

export async function getPendingEmployeeEdits(): Promise<LocalEmployeeEditRecord[]> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<LocalEmployeeEditRecord[]>('/employees/edits/pending');
  return response.data;
}

export async function ackEmployeeEdits(ids: string[]) {
  if (ids.length === 0) return;
  await hub.post('/employees/edits/ack', { ids });
}

export async function markEmployeeEditFailed(id: string, error: string) {
  await hub.post(`/employees/edits/${id}/fail`, { error });
}

export async function queueEmployeeDelete(employeeId: string): Promise<LocalEmployeeDeleteRecord> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.post<LocalEmployeeDeleteRecord>(`/employees/${employeeId}/delete`, {});
  return response.data;
}

export async function getPendingEmployeeDeletes(): Promise<LocalEmployeeDeleteRecord[]> {
  if (!getCachedPairingKey()) await getPairingInfo();
  const response = await hub.get<LocalEmployeeDeleteRecord[]>('/employees/deletes/pending');
  return response.data;
}

export async function ackEmployeeDeletes(ids: string[]) {
  if (ids.length === 0) return;
  await hub.post('/employees/deletes/ack', { ids });
}

export async function markEmployeeDeleteFailed(id: string, error: string) {
  await hub.post(`/employees/deletes/${id}/fail`, { error });
}

