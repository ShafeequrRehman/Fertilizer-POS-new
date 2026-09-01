import { api, getSystemApiBaseUrl } from '@/lib/api';
export { isAuthenticated } from '@/lib/auth';
import { AxiosError } from 'axios';
import { CancelOrderPayload, CloseShopResult, Customer, LedgerCustomer, OrderPayload, OrderUpdatePayload, Product, ProductInput, SavedOrder, ShopSession, ShopSessionStatus, Table, Waiter } from '@/lib/pos-types';

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

export async function fetchTables() {
  try {
    const response = await api.get<Array<Table & { _id?: string }>>('/tables');
    return response.data.map((table) => ({ ...table, id: table.id ?? table._id ?? '' }));
  } catch (error) {
    handleApiError(error);
  }
}

export async function createTable(payload: { name: string; isFamily?: boolean; isActive?: boolean }) {
  try {
    const response = await api.post<Table & { _id?: string }>('/tables', payload);
    return { ...response.data, id: response.data.id ?? response.data._id ?? '' };
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateTable(id: string, payload: Partial<Pick<Table, 'name' | 'isFamily' | 'isActive'>>) {
  try {
    const response = await api.patch<Table & { _id?: string }>(`/tables/${id}`, payload);
    return { ...response.data, id: response.data.id ?? response.data._id ?? '' };
  } catch (error) {
    handleApiError(error);
  }
}

export async function deleteTable(id: string) {
  try {
    await api.delete(`/tables/${id}`);
  } catch (error) {
    handleApiError(error);
  }
}

// The estimated combined preparation + dining duration (minutes) that
// drives the Dine-In table availability countdown - see
// components/TableManagementSection.tsx (shop-person setting) and
// POSPage.tsx (countdown + lock display). Defaults to 45 on both ends if
// the request fails, matching the backend default.
export async function fetchTableSettings() {
  try {
    const response = await api.get<{ tableTurnoverMinutes: number }>('/tables/settings');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateTableSettings(payload: { tableTurnoverMinutes: number }) {
  try {
    const response = await api.patch<{ tableTurnoverMinutes: number }>('/tables/settings', payload);
    return response.data;
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

export async function fetchOrders(params?: { date?: string; status?: SavedOrder['status']; orderType?: SavedOrder['orderType'] }) {
  try {
    const response = await api.get<Array<SavedOrder & { _id?: string }>>('/orders', { params });
    return response.data.map(normalizeOrder);
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

// The two actions on the real-time table-timer alert popup (see
// TableTimerAlertWatcher.tsx) - "Extend +10 Minutes" pushes this order's
// effective turnover window back instead of freeing the table, "Clear
// Table" frees the table immediately (everywhere - the backend occupancy
// check and every terminal's next poll) without changing the order's own
// status.
export async function extendOrderTableTimer(id: string) {
  try {
    const response = await api.post<SavedOrder & { _id?: string }>(`/orders/${id}/extend-timer`, {});
    return normalizeOrder(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function clearOrderTableTimer(id: string) {
  try {
    const response = await api.post<SavedOrder & { _id?: string }>(`/orders/${id}/clear-table`, {});
    return normalizeOrder(response.data);
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

export async function sendWhatsappDocument(phone: string, filePath: string, fileName: string) {
  try {
    const response = await api.post<{ success: boolean; error?: string }>('/whatsapp/send-document', { phone, filePath, fileName }, {
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
