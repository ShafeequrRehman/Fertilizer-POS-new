import { api, getSystemApiBaseUrl } from '@/lib/api';
export { isAuthenticated } from '@/lib/auth';
import { AxiosError } from 'axios';
import { CancelOrderPayload, CloseShopResult, Customer, LedgerCustomer, OrderPayload, OrderUpdatePayload, Product, ProductInput, SavedOrder, ShopSession, ShopSessionStatus, Waiter } from '@/lib/pos-types';

export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function fetchPrinters() {
  try {
    const response = await api.get<{ printers: string[] }>('/printers', {
      baseURL: 'http://localhost:5000/api',
    });
    return response.data.printers;
  } catch (error) {
    handleApiError(error);
  }
}

interface ProductsResponse {
  categories: string[];
  products: Array<Product & { _id?: string }>;
}

function normalizeProduct(product: Product & { _id?: string }) {
  return {
    ...product,
    id: product.id ?? product._id ?? '',
  };
}

function normalizeCustomer(customer: Customer & { _id?: string; updatedAt?: string }) {
  return {
    ...customer,
    id: customer.id ?? customer._id ?? customer.phone,
    address: customer.address ?? '',
    previousDues: Number(customer.previousDues ?? 0),
    updatedAt: customer.updatedAt,
  } satisfies Customer & { updatedAt?: string };
}

function normalizeOrder(order: SavedOrder & { _id?: string }) {
  return {
    ...order,
    id: order.id ?? order._id ?? '',
  };
}

function handleApiError(error: unknown): never {
  if (error instanceof AxiosError) {
    const message = (error.response?.data as { error?: string; message?: string } | undefined)?.error
      || (error.response?.data as { error?: string; message?: string } | undefined)?.message
      || error.message;
    throw new ApiError(message, error.response?.status);
  }

  throw error instanceof Error ? error : new Error('Request failed');
}

export async function fetchProducts(search?: string) {
  try {
    const params = search ? { search } : undefined;
    const response = await api.get<ProductsResponse>('/products', { params });
    return {
      categories: response.data.categories,
      products: response.data.products.map(normalizeProduct),
    };
  } catch (error) {
    handleApiError(error);
  }
}

export async function createProduct(payload: ProductInput) {
  try {
    const response = await api.post<Product & { _id?: string }>('/products', payload);
    return normalizeProduct(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateProduct(id: string | number, payload: Partial<ProductInput>) {
  try {
    const response = await api.patch<Product & { _id?: string }>(`/products/${id}`, payload);
    return normalizeProduct(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function deleteProduct(id: string | number) {
  try {
    await api.delete(`/products/${id}`);
  } catch (error) {
    handleApiError(error);
  }
}

export async function fetchCustomerSearch(query: string, searchBy: 'name' | 'phone' | 'both' = 'both') {
  try {
    const response = await api.get<Customer[]>('/customers/search', { params: { q: query, searchBy } });
    return response.data.map((customer) => normalizeCustomer(customer as Customer & { _id?: string; updatedAt?: string }));
  } catch (error) {
    handleApiError(error);
  }
}

export async function fetchAllCustomers() {
  try {
    const response = await api.get<Customer[]>('/customers');
    return response.data.map((customer) => normalizeCustomer(customer as Customer & { _id?: string; updatedAt?: string }));
  } catch (error) {
    handleApiError(error);
  }
}

export async function fetchCustomerLedger() {
  try {
    const response = await api.get<LedgerCustomer[]>('/customers/ledger');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function createCustomer(payload: Omit<Customer, 'id'>) {
  try {
    const response = await api.post<Customer & { _id?: string }>('/customers', payload);
    return normalizeCustomer(response.data as Customer & { _id?: string; updatedAt?: string });
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateCustomer(id: string, payload: Partial<Customer>) {
  try {
    const response = await api.patch<Customer & { _id?: string }>(`/customers/${id}`, payload);
    return normalizeCustomer(response.data as Customer & { _id?: string; updatedAt?: string });
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateCustomerDues(phone: string, previousDues: number) {
  try {
    const response = await api.patch<Customer & { _id?: string }>(`/customers/dues/${phone}`, { previousDues });
    return normalizeCustomer(response.data as Customer & { _id?: string; updatedAt?: string });
  } catch (error) {
    handleApiError(error);
  }
}

// A real payment collected against everything a customer owes - the
// manual previousDues lump-sum AND their unpaid orders, oldest-first (same
// distribution backend/controllers/orderController.js's completeAndSettle
// cascade already uses when a payment collected on one order pays down
// others too). Unlike updateCustomerDues above, this can mark an order
// "completed" if the payment fully covers it - see
// customerController.settleCustomerDues for the full reasoning.
export async function settleCustomerDues(phone: string, amount: number) {
  try {
    const response = await api.post<{ appliedAmount: number; unapplied: number }>(`/customers/${phone}/settle-dues`, { amount });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// A customer can now have more than one order open at once (the old "one
// pending order at a time" block was removed from POSPage.tsx), so this is
// what tells the Sales page's Complete Payment panel the customer's real
// total owed right now - every other non-cancelled order's unpaid balance
// plus the older lump-sum previousDues - separate from whatever order is
// currently being paid (excludeOrderId).
export async function fetchCustomerOutstanding(phone: string, excludeOrderId?: string) {
  try {
    const response = await api.get<{ outstanding: number; ordersBalance: number; previousDues: number; pendingOrderCount: number }>(
      `/customers/${phone}/outstanding`,
      { params: excludeOrderId ? { excludeOrderId } : undefined }
    );
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function fetchWaiters() {
  try {
    const response = await api.get<Array<Waiter & { _id?: string }>>('/waiters');
    return response.data.map((waiter) => ({ ...waiter, id: waiter.id ?? waiter._id ?? '' }));
  } catch (error) {
    handleApiError(error);
  }
}

export async function createWaiter(payload: { name: string; isActive?: boolean }) {
  try {
    const response = await api.post<Waiter & { _id?: string }>('/waiters', payload);
    return { ...response.data, id: response.data.id ?? response.data._id ?? '' };
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateWaiter(id: string, payload: Partial<Pick<Waiter, 'name' | 'isActive'>>) {
  try {
    const response = await api.patch<Waiter & { _id?: string }>(`/waiters/${id}`, payload);
    return { ...response.data, id: response.data.id ?? response.data._id ?? '' };
  } catch (error) {
    handleApiError(error);
  }
}

export async function deleteWaiter(id: string) {
  try {
    await api.delete(`/waiters/${id}`);
  } catch (error) {
    handleApiError(error);
  }
}

export async function checkPendingOrder(phone: string) {
  try {
    const response = await api.get<{ exists: boolean }>(`/orders/pending/${phone}`);
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function createOrder(payload: OrderPayload) {
  try {
    const response = await api.post<SavedOrder & { _id?: string }>('/orders', payload);
    return normalizeOrder(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

// This route's real response time on a shop with substantial order history
// has been measured (server-side debug timing) at 9-10 seconds for a full-
// document, 14-day-bounded fetch - genuinely slower than ideal (data volume
// over the connection to the database, not a bug in the query itself - see
// the matching timing/index work in orderController.js/Order.js), but it
// DOES reliably complete and return correct data. The shared 8-second
// AXIOS_REQUEST_TIMEOUT_MS default was written for ordinary requests and
// was cutting this one off right as it was about to succeed, surfacing a
// hard failure (and, on Sales/Record, a blank/zeroed page) for a request
// that was actually fine - just slower than most. Overriding the timeout
// here specifically (not raised globally, which would make genuinely stuck
// requests elsewhere hang around longer for no benefit) buys enough room
// for this one to actually finish.
const ORDERS_FETCH_TIMEOUT_MS = 25000;

export async function fetchOrders(params?: { date?: string; since?: string; status?: SavedOrder['status']; summary?: boolean }) {
  try {
    const response = await api.get<Array<SavedOrder & { _id?: string }>>('/orders', { params, timeout: ORDERS_FETCH_TIMEOUT_MS });
    return response.data.map(normalizeOrder);
  } catch (error) {
    handleApiError(error);
  }
}

// Same as fetchOrders above but requests the server's lightweight
// `summary=true` projection (status/total/createdAt/customer.phone/waiter
// only - see orderController.js's getOrders) instead of full documents.
// Built for DashboardPageClient.tsx's own 45-second poll, which only ever
// reads those five fields for its stats/chart - on a shop with a lot of
// order history, fetching full documents (complete items array, full
// customer object, etc.) x however many hundred orders is real, measured
// data-transfer weight, not just a hydration cost (see getOrders' own
// comment on this). Deliberately a SEPARATE function rather than a
// `summary: true` call to fetchOrders itself, so nothing accidentally
// pushes this stripped-down shape into the shared Local Hub order cache
// that Sales/Kitchen/Record's own offline fallbacks depend on having full
// order data in - see DashboardPageClient.tsx's own comment on why it
// never calls pushOrdersCache with this result.
export type OrderSummary = Pick<SavedOrder, 'id' | 'status' | 'total' | 'createdAt' | 'waiter'> & {
  customer: { phone: string };
};
export async function fetchOrdersSummary(params: { since: string }): Promise<OrderSummary[]> {
  try {
    const response = await api.get<Array<Partial<SavedOrder> & { _id?: string }>>('/orders', {
      params: { ...params, summary: true },
      // Same reasoning as ORDERS_FETCH_TIMEOUT_MS above - this variant is
      // normally fast (that's the whole point of the summary projection),
      // but giving it the same headroom costs nothing and protects a
      // busier shop or a slower moment from a spurious timeout here too.
      timeout: ORDERS_FETCH_TIMEOUT_MS,
    });
    return response.data.map((order) => ({ ...order, id: order.id ?? order._id ?? '' })) as OrderSummary[];
  } catch (error) {
    handleApiError(error);
  }
}

// Every table currently tied to a still-pending DineIn order, shop-wide,
// with NO date bound - see orderController.js's getOccupiedDineInTables
// for why this is safe to leave unbounded (the result set is capped by the
// shop's physical table count, not by order history size). Used by
// POSPage.tsx to block re-selecting a table that already has an open
// order, even one placed days ago that just never got completed.
export async function fetchOccupiedDineInTables() {
  try {
    const response = await api.get<{ tables: string[] }>('/orders/dinein/occupied-tables');
    return response.data.tables || [];
  } catch (error) {
    handleApiError(error);
  }
}

// Orders with no kitchen ticket printed yet, shop-wide - regardless of
// which client (this till's own POS screen, or a cashier's phone via
// pos-mobile) created them. Polled by DashboardShell.tsx's background
// print loop.
export async function fetchUnprintedKitchenOrders() {
  try {
    const response = await api.get<Array<SavedOrder & { _id?: string }>>('/orders/kitchen/unprinted');
    return response.data.map(normalizeOrder);
  } catch (error) {
    handleApiError(error);
  }
}

// Atomically claims an order for kitchen printing - always called BEFORE
// actually sending it to the printer, never after. Throws an ApiError with
// status 409 if another till already claimed/printed it first - the poll
// loop checks for exactly that status to skip silently instead of treating
// it as a real failure (see handleApiError above, which preserves
// error.response.status on the thrown ApiError).
export async function claimKitchenPrint(orderId: string) {
  try {
    const response = await api.patch<SavedOrder & { _id?: string }>(`/orders/${orderId}/claim-kitchen-print`);
    return normalizeOrder(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

// Orders with no customer receipt printed yet, shop-wide - the
// receipt-printing sibling of fetchUnprintedKitchenOrders above. Returns
// TakeAway orders (still pending, printed immediately at placement) and any
// order of any type that just reached "completed" without a till already
// claiming it locally - see backend/controllers/orderController.js's
// getUnprintedReceiptOrders for the exact query.
export async function fetchUnprintedReceiptOrders() {
  try {
    const response = await api.get<Array<SavedOrder & { _id?: string }>>('/orders/receipts/unprinted');
    return response.data.map(normalizeOrder);
  } catch (error) {
    handleApiError(error);
  }
}

// Same claim-before-print contract as claimKitchenPrint - 409 means another
// till already claimed/printed this order's customer receipt.
export async function claimReceiptPrint(orderId: string) {
  try {
    const response = await api.patch<SavedOrder & { _id?: string }>(`/orders/${orderId}/claim-receipt-print`);
    return normalizeOrder(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

// Orders with items queued to notify the kitchen about (addItems, or a
// replaceItems quantity increase) since their original kitchen ticket
// already printed - kitchenPrintedAt only ever fires once per order, so
// this is what makes a LATER edit (including one made from pos-mobile,
// which has no printer of its own) still reach the kitchen. See
// backend/controllers/orderController.js's getUnprintedKitchenUpdateOrders.
export async function fetchUnprintedKitchenUpdateOrders() {
  try {
    const response = await api.get<Array<SavedOrder & { _id?: string }>>('/orders/kitchen-updates/unprinted');
    return response.data.map(normalizeOrder);
  } catch (error) {
    handleApiError(error);
  }
}

// Same claim-before-print contract as claimKitchenPrint, but this one can
// fire again later for the same order (pendingKitchenUpdate gets queued and
// cleared any number of times over an order's life, unlike the one-shot
// kitchenPrintedAt) - returns both the updated order and just the item
// delta that was claimed, ready to hand straight to the kitchen printer.
export async function claimKitchenUpdatePrint(orderId: string) {
  try {
    const response = await api.patch<{ order: SavedOrder & { _id?: string }; items: SavedOrder['items'] }>(`/orders/${orderId}/claim-kitchen-update-print`);
    return { order: normalizeOrder(response.data.order), items: response.data.items };
  } catch (error) {
    handleApiError(error);
  }
}

export async function fetchOrder(id: string) {
  try {
    const response = await api.get<SavedOrder & { _id?: string }>(`/orders/${id}`);
    return normalizeOrder(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateOrder(id: string, payload: OrderUpdatePayload) {
  try {
    const response = await api.patch<SavedOrder & { _id?: string }>(`/orders/${id}`, payload);
    return normalizeOrder(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

// The only way to actually cancel an order (see backend/controllers/
// orderController.js exports.cancelOrder - the generic PATCH above
// explicitly rejects status: 'cancelled'). `key` is the shop's Cancel
// Order Key, set up per-shop by the Super Admin - never hardcoded here.
export async function cancelOrder(id: string, payload: CancelOrderPayload) {
  try {
    const response = await api.post<SavedOrder & { _id?: string }>(`/orders/${id}/cancel`, payload);
    return normalizeOrder(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

// GET /shop/profile - includes enabledPages (this shop's current sidebar
// page selection, null if never configured) and hasPageVisibilityKey
// (whether the Super Admin has set up the key needed to change it). Never
// includes the key hash itself - see backend/controllers/
// shopOwnerController.js exports.getOwnShop.
export interface ShopProfile {
  _id?: string;
  name?: string;
  enabledPages?: string[] | null;
  hasPageVisibilityKey?: boolean;
  hasCancelOrderKey?: boolean;
}

export async function fetchShopProfile() {
  try {
    const response = await api.get<ShopProfile>('/shop/profile');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// The only way to actually change which sidebar pages this shop's
// dashboard shows (see backend/controllers/shopOwnerController.js
// exports.updateEnabledPages). `key` is the shop's Page Visibility Key,
// set up per-shop by the Super Admin - never hardcoded here.
export async function updateEnabledPages(enabledPages: string[], key: string) {
  try {
    const response = await api.patch<{ enabledPages: string[] }>('/shop/pages', { enabledPages, key });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function fetchWhatsappStatus() {
  try {
    const response = await api.get<{ isConnected: boolean; hasQR: boolean; socketReady: boolean }>('/whatsapp/status', {
      baseURL: getSystemApiBaseUrl(),
    });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function fetchWhatsappQR() {
  try {
    const response = await api.get<{ qr: string; message?: string }>('/whatsapp/qr', {
      baseURL: getSystemApiBaseUrl(),
    });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function sendWhatsappMessage(phone: string, message: string) {
  try {
    const response = await api.post<{ success: boolean; error?: string }>('/whatsapp/send', { phone, message }, {
      baseURL: getSystemApiBaseUrl(),
    });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// fileBase64: the actual PDF bytes, base64-encoded - NOT a filesystem
// path. The backend may run on a different machine than this till (see
// pos-web/backend/README-deploy.md), so a local path would mean nothing
// to it; sending the real bytes works no matter where the backend runs.
export async function sendWhatsappDocument(phone: string, fileBase64: string, fileName: string) {
  try {
    const response = await api.post<{ success: boolean; error?: string }>('/whatsapp/send-document', { phone, fileBase64, fileName }, {
      baseURL: getSystemApiBaseUrl(),
    });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// --- Shop open/close ("shift") --------------------------------------------
// See backend/controllers/shopSessionController.js. Exactly one session can
// be "open" per shop at a time; new orders are rejected server-side while
// none is open (backend/controllers/orderController.js createOrder).

export async function fetchShopSessionStatus() {
  try {
    const response = await api.get<ShopSessionStatus>('/shop-session/current');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function openShopSession() {
  try {
    const response = await api.post<ShopSession>('/shop-session/open');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// Returns { closed: false, needsConfirmation: true, unresolvedOrders } instead
// of throwing when the shop has pending/unpaid orders and force wasn't
// passed - callers show those to the user and retry with force=true rather
// than treating this as a hard failure.
export async function closeShopSession(force = false): Promise<CloseShopResult | undefined> {
  try {
    const response = await api.post<ShopSession>('/shop-session/close', { force });
    return { closed: true, session: response.data };
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 409 && (error.response.data as { needsConfirmation?: boolean })?.needsConfirmation) {
      const data = error.response.data as { unresolvedOrders?: CloseShopResult['unresolvedOrders'] };
      return { closed: false, needsConfirmation: true, unresolvedOrders: data.unresolvedOrders || [] };
    }
    handleApiError(error);
  }
}

export async function fetchShopSessionHistory() {
  try {
    const response = await api.get<ShopSession[]>('/shop-session/history');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}
