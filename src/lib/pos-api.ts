import { api, getSystemApiBaseUrl } from '@/lib/api';
export { isAuthenticated } from '@/lib/auth';
import { AxiosError } from 'axios';
import { CancelOrderPayload, CloseShopResult, CompanyLedgerEntry, Customer, DayEndReport, Expense, Ingredient, IngredientCategory, IngredientPurchase, IngredientUnit, InventoryReport, LedgerCustomer, LedgerTransactionsResponse, MySalesReport, OrderPayload, OrderUpdatePayload, Product, ProductInput, PurchaseOrderInput, PurchaseOrderReceiveItemInput, Recipe, SavedOrder, ShopSession, ShopSessionStatus, Supplier, Waiter } from '@/lib/pos-types';

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

// startDate/endDate are optional plain YYYY-MM-DD strings (LedgerPage.tsx's
// Date Range picker, same format as its `type="date"` inputs) - when both
// are given, the backend scopes orderCount/totalBilled/totalPaid/orders/
// lastOrderAt to that period, while totalOrderBalance/totalDue/
// previousDues stay the customer's real current balance regardless (see
// getCustomerLedger's own comment in backend/controllers/customerController.js).
export async function fetchCustomerLedger(params?: { startDate?: string; endDate?: string }) {
  try {
    const response = await api.get<LedgerCustomer[]>('/customers/ledger', { params });
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

export async function updateCustomerDues(phone: string, previousDues: number, note?: string) {
  try {
    const response = await api.patch<Customer & { _id?: string }>(`/customers/dues/${phone}`, { previousDues, note });
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
export async function settleCustomerDues(phone: string, amount: number, note?: string) {
  try {
    const response = await api.post<{ appliedAmount: number; unapplied: number }>(`/customers/${phone}/settle-dues`, { amount, note });
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

export interface Rider {
  id: string;
  name: string;
  phone: string;
  isActive: boolean;
  vehicleNumber?: string;
  idCardNumber?: string;
  address?: string;
}

// Staff with designation "Delivery Rider" (see EmployeesPage.tsx's Manage
// Staff form / waiterController.getRiders) - the picker
// OnlineOrderControls in SalesPage.tsx builds from this.
export async function fetchRiders() {
  try {
    const response = await api.get<Rider[]>('/waiters/riders');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// See orderController.exports.assignRider - hands a Delivery order to one
// specific rider and WhatsApps them the customer's details + a Maps link.
// riderNotified in the response tells the caller whether that message
// actually sent (the shop's WhatsApp might not be connected).
export async function assignOrderRider(orderId: string, rider: { id: string; name: string; phone: string }) {
  try {
    const response = await api.patch<SavedOrder & { _id?: string; riderNotified?: boolean }>(`/orders/${orderId}/assign-rider`, {
      riderId: rider.id,
      riderName: rider.name,
      riderPhone: rider.phone,
    });
    return { order: normalizeOrder(response.data), riderNotified: Boolean(response.data.riderNotified) };
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

// --- Ingredient Stock (Task 1: raw-ingredient inventory + categories) ---

function normalizeIngredientCategory(category: IngredientCategory & { _id?: string }) {
  return { ...category, id: category.id ?? category._id ?? '' };
}

function normalizeIngredient(ingredient: Ingredient & { _id?: string }) {
  return { ...ingredient, id: ingredient.id ?? ingredient._id ?? '' };
}

export async function fetchIngredientCategories() {
  try {
    const response = await api.get<Array<IngredientCategory & { _id?: string }>>('/ingredients/categories');
    return response.data.map(normalizeIngredientCategory);
  } catch (error) {
    handleApiError(error);
  }
}

export async function createIngredientCategory(name: string) {
  try {
    const response = await api.post<IngredientCategory & { _id?: string }>('/ingredients/categories', { name });
    return normalizeIngredientCategory(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateIngredientCategory(id: string, payload: Partial<Pick<IngredientCategory, 'name' | 'isActive'>>) {
  try {
    const response = await api.patch<IngredientCategory & { _id?: string }>(`/ingredients/categories/${id}`, payload);
    return normalizeIngredientCategory(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function deleteIngredientCategory(id: string) {
  try {
    await api.delete(`/ingredients/categories/${id}`);
  } catch (error) {
    handleApiError(error);
  }
}

export async function fetchIngredients(params?: { search?: string; categoryId?: string }) {
  try {
    const response = await api.get<Array<Ingredient & { _id?: string }>>('/ingredients', { params });
    return response.data.map(normalizeIngredient);
  } catch (error) {
    handleApiError(error);
  }
}

export interface IngredientInput {
  name: string;
  unit: IngredientUnit;
  categoryId?: string | null;
  currentStock?: number;
  lowStockThreshold?: number;
}

export async function createIngredient(payload: IngredientInput) {
  try {
    const response = await api.post<Ingredient & { _id?: string }>('/ingredients', payload);
    return normalizeIngredient(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateIngredient(id: string, payload: Partial<IngredientInput & { isActive: boolean }>) {
  try {
    const response = await api.patch<Ingredient & { _id?: string }>(`/ingredients/${id}`, payload);
    return normalizeIngredient(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

// Adds `quantity` (in the ingredient's own unit) to its running stock - the
// normal "today's/this month's delivery came in" entry point. Pass a
// negative quantity for a manual wastage/correction write-off.
export async function restockIngredient(id: string, quantity: number, note?: string) {
  try {
    const response = await api.patch<Ingredient & { _id?: string }>(`/ingredients/${id}/restock`, { quantity, note });
    return normalizeIngredient(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function deleteIngredient(id: string) {
  try {
    await api.delete(`/ingredients/${id}`);
  } catch (error) {
    handleApiError(error);
  }
}

// --- Recipe Management (Task 2: per-size recipe definition) ---

function normalizeRecipe(recipe: Recipe & { _id?: string }) {
  return { ...recipe, id: recipe.id ?? recipe._id ?? '' };
}

export async function fetchRecipes() {
  try {
    const response = await api.get<Array<Recipe & { _id?: string }>>('/recipes');
    return response.data.map(normalizeRecipe);
  } catch (error) {
    handleApiError(error);
  }
}

// --- Ingredient Purchases (Purchasing/Financial Logic Task 1) ---

function normalizeIngredientPurchase(purchase: IngredientPurchase & { _id?: string }) {
  return { ...purchase, id: purchase.id ?? purchase._id ?? '' };
}

export async function fetchIngredientPurchases(params?: { ingredientId?: string; supplierId?: string; startDate?: string; endDate?: string; status?: 'pending' | 'received' }) {
  try {
    const response = await api.get<Array<IngredientPurchase & { _id?: string }>>('/ingredient-purchases', { params });
    return response.data.map(normalizeIngredientPurchase);
  } catch (error) {
    handleApiError(error);
  }
}

export interface IngredientPurchaseInput {
  ingredientId: string;
  quantity: number;
  rate: number;
  paidAmount?: number;
  companyName?: string;
  productDetails?: string;
  supplierId?: string | null;
  purchaseDate?: string;
  note?: string;
}

// Records a batch (rate/total/paid/due), restocks the ingredient, and folds
// the rate into its moving-average cost - all three happen together on the
// backend (see ingredientPurchaseController.createPurchase), which hands
// back both the new purchase record and the now-updated ingredient in one
// response so the caller never has to re-derive the average-cost math
// itself.
export async function createIngredientPurchase(payload: IngredientPurchaseInput) {
  try {
    const response = await api.post<{ purchase: IngredientPurchase & { _id?: string }; ingredient: Ingredient & { _id?: string } }>('/ingredient-purchases', payload);
    return {
      purchase: normalizeIngredientPurchase(response.data.purchase),
      ingredient: normalizeIngredient(response.data.ingredient),
    };
  } catch (error) {
    handleApiError(error);
  }
}

// Dual-Status Stock Inventory Workflow, Phase 1 (Order Placed): the
// Purchase page's "New Purchase Order" - one Supplier Company, one or more
// ingredient lines, all sharing one auto-generated purchaseOrderNumber.
// Deliberately does NOT touch stock/averageCost yet (see
// ingredientPurchaseController.createPurchaseOrder) - only
// receivePurchaseOrder below does that, once delivery is actually
// confirmed.
export async function createPurchaseOrder(payload: PurchaseOrderInput) {
  try {
    const response = await api.post<{ purchaseOrderNumber: string; lines: Array<IngredientPurchase & { _id?: string }> }>('/ingredient-purchases/orders', payload);
    return {
      purchaseOrderNumber: response.data.purchaseOrderNumber,
      lines: response.data.lines.map(normalizeIngredientPurchase),
    };
  } catch (error) {
    handleApiError(error);
  }
}

// Phase 2 (Delivery Fulfillment & Billing) redesign: this IS the billing
// screen submit - `items` carries one { purchaseId, rate } pair per pending
// line of the order (the Actual Supplier Rate the manager just entered for
// each delivered ingredient), and `paidAmount` is the TOTAL paid for the
// WHOLE order right now, computed against the fresh Total Bill those rates
// produce (the order's own freshly-computed total for "Full Payment", or
// anything less for "Partial" - the difference routes to the company's
// Dues). Flips every line of the order to "received" and, only now, folds
// each line into its own ingredient's currentStock/averageCost - see
// ingredientPurchaseController.receivePurchaseOrder for the exact per-line
// total computation and proportional payment split. Hands back both the
// updated purchase lines AND the now-updated ingredients, so the Purchase
// page never has to re-derive the average-cost math itself.
export async function receivePurchaseOrder(purchaseOrderNumber: string, items: PurchaseOrderReceiveItemInput[], paidAmount: number) {
  try {
    const response = await api.patch<{
      purchaseOrderNumber: string;
      lines: Array<IngredientPurchase & { _id?: string }>;
      ingredients: Array<Ingredient & { _id?: string }>;
    }>(`/ingredient-purchases/orders/${encodeURIComponent(purchaseOrderNumber)}/receive`, { items, paidAmount });
    return {
      purchaseOrderNumber: response.data.purchaseOrderNumber,
      lines: response.data.lines.map(normalizeIngredientPurchase),
      ingredients: response.data.ingredients.map(normalizeIngredient),
    };
  } catch (error) {
    handleApiError(error);
  }
}

// Settles part (or all) of a batch's outstanding supplier due. Additive -
// pass how much is being paid now, not the new total.
export async function payIngredientPurchase(id: string, amount: number) {
  try {
    const response = await api.patch<IngredientPurchase & { _id?: string }>(`/ingredient-purchases/${id}/pay`, { amount });
    return normalizeIngredientPurchase(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

// Task 4 (Ledger Integration): company-wise supplier dues, grouped by the
// free-text companyName typed on each purchase. `startDate`/`endDate` are
// optional and only scope purchaseCount/totalPurchased/totalPaid - totalDue
// is always this company's real balance right now (see
// ingredientPurchaseController.getCompanyLedger's own comment).
export async function fetchCompanyLedger(params?: { startDate?: string; endDate?: string }) {
  try {
    const response = await api.get<CompanyLedgerEntry[]>('/ingredient-purchases/company-ledger', { params });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// --- Expenses (Task 3's "Other Expenses" - gas, electricity, wages, waste) ---

function normalizeExpense(expense: Expense & { _id?: string }) {
  return { ...expense, id: expense.id ?? expense._id ?? '' };
}

export async function fetchExpenses(params?: { employeeId?: string }) {
  try {
    const response = await api.get<Array<Expense & { _id?: string }>>('/expenses', { params });
    return response.data.map(normalizeExpense);
  } catch (error) {
    handleApiError(error);
  }
}

export async function createExpense(payload: { category: string; amount: number; date?: string; note?: string; employeeId?: string | null }) {
  try {
    const response = await api.post<Expense & { _id?: string }>('/expenses', payload);
    return normalizeExpense(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

// Minimal (name/username only) staff list for the expense-logging form's
// "Employee" picker and the Reports page's employee filter - see
// expenseController.getEmployeesLite's own comment on why this is separate
// from shopApi.listEmployees (that one's Shop-Owner-only, returns the full
// HR record).
export async function fetchEmployeesLite() {
  try {
    const response = await api.get<Array<{ _id: string; name: string; username: string }>>('/expenses/employees');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function deleteExpense(id: string) {
  try {
    await api.delete(`/expenses/${id}`);
  } catch (error) {
    handleApiError(error);
  }
}

// --- Day-End Profit Report (Task 3) ---
// startDate/endDate are plain YYYY-MM-DD strings - same Date Range
// convention as fetchCustomerLedger. Both required so ReportsPage.tsx's
// Daily/Monthly/Yearly/Custom picker always sends an explicit range (the
// backend itself falls back to "today" if they're ever omitted).
export async function fetchDayEndReport(startDate: string, endDate: string) {
  try {
    const response = await api.get<DayEndReport>('/reports/day-end', { params: { startDate, endDate } });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// Shop Ledger (feature 6): the unified transaction list backing
// AccountingPage.tsx's General Ledger table - cash sales, credit sales,
// due payments, purchases and expenses, all in one flat, date-sorted
// array. See reportController.getLedgerTransactions for the row shape.
export async function fetchLedgerTransactions(startDate: string, endDate: string) {
  try {
    const response = await api.get<LedgerTransactionsResponse>('/reports/ledger-transactions', { params: { startDate, endDate } });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// Role-Based Security: what an account with only 'reports.view.own_sales'
// (the Receptionist role) can load - one calendar day (defaults to today
// server-side if omitted), only their own orders. See
// reportController.getMySalesReport's own comment.
export async function fetchMySalesReport(date?: string) {
  try {
    const response = await api.get<MySalesReport>('/reports/my-sales', { params: date ? { date } : undefined });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// Role-Based Security: what an account with only 'reports.view.inventory'
// (the Stock Manager role) can load - kitchen stock purchase logs in range
// plus every company's all-time due. See
// reportController.getInventoryReport's own comment.
export async function fetchInventoryReport(startDate: string, endDate: string) {
  try {
    const response = await api.get<InventoryReport>('/reports/inventory', { params: { startDate, endDate } });
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// --- Suppliers (Task 4/5: the registered "Company Name" directory the
// Ingredient Directory's dynamic filter tabs are generated from, and whose
// `phone` a stock export gets sent to on WhatsApp) ---

function normalizeSupplier(supplier: Supplier & { _id?: string }) {
  return { ...supplier, id: supplier.id ?? supplier._id ?? '' };
}

export async function fetchSuppliers() {
  try {
    const response = await api.get<Array<Supplier & { _id?: string }>>('/suppliers');
    return response.data.map(normalizeSupplier);
  } catch (error) {
    handleApiError(error);
  }
}

export async function createSupplier(payload: { name: string; phone?: string; email?: string; address?: string; notes?: string }) {
  try {
    const response = await api.post<Supplier & { _id?: string }>('/suppliers', payload);
    return normalizeSupplier(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateSupplier(id: string, payload: { name?: string; phone?: string; email?: string; address?: string; notes?: string; isActive?: boolean }) {
  try {
    const response = await api.patch<Supplier & { _id?: string }>(`/suppliers/${id}`, payload);
    return normalizeSupplier(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

export async function deleteSupplier(id: string) {
  try {
    await api.delete(`/suppliers/${id}`);
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

export async function fetchOrders(params?: { date?: string; since?: string; status?: SavedOrder['status']; orderType?: SavedOrder['orderType']; summary?: boolean }) {
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

// Same as fetchOrders above but requests the server's `list=true`
// projection (every field EXCEPT items, plus a server-computed itemCount -
// see orderController.js's getOrders) instead of full documents. Built for
// SalesPage.tsx/RecordPage.tsx's card-list views, which need almost every
// field (unlike fetchOrdersSummary's 5-field projection) but not the
// items array of every order in the list at once - only whichever ONE
// order the cashier actually opens, fetched full via fetchOrder at that
// point. Each returned order has items: [] and itemCount set - see
// SavedOrder['itemCount']'s own comment for why that combination is what
// callers check to know an entry is still the lean placeholder.
export async function fetchOrdersList(params?: { date?: string; since?: string; status?: SavedOrder['status'] }) {
  try {
    const response = await api.get<Array<SavedOrder & { _id?: string }>>('/orders', {
      params: { ...params, list: true },
      timeout: ORDERS_FETCH_TIMEOUT_MS,
    });
    return response.data.map(normalizeOrder);
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

export type TrackingStatus = 'awaiting_confirmation' | 'confirmed' | 'preparing' | 'ready' | 'cancelled';

// See orderController.exports.updateTrackingStatus - staff-side control
// for a customer-qr order's tracking lifecycle (see SalesPage.tsx's
// OnlineOrderControls). Only ever valid for orders with source ===
// "customer-qr"; the backend rejects anything else.
export async function updateOrderTrackingStatus(id: string, trackingStatus: TrackingStatus, reason?: string) {
  try {
    const response = await api.patch<SavedOrder & { _id?: string }>(`/orders/${id}/tracking-status`, { trackingStatus, reason });
    return normalizeOrder(response.data);
  } catch (error) {
    handleApiError(error);
  }
}

// See orderController.exports.respondToChangeRequest - staff-side
// approve/reject for a customer's own request to add/remove items on an
// order they already placed (see SavedOrder.customerChangeRequest below,
// and SalesPage.tsx's OnlineOrderControls for the UI).
export async function respondToOrderChangeRequest(id: string, action: 'approve' | 'reject', reason?: string) {
  try {
    const response = await api.patch<SavedOrder & { _id?: string }>(`/orders/${id}/change-request`, { action, reason });
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
  // Already stored/returned by the backend (Shop.phone, spread straight
  // through by shopOwnerController.getOwnShop - see its own comment on
  // which fields it strips vs. keeps) but never declared here since
  // nothing in this app's UI read it before the Shop Closing Summary's
  // "Send WhatsApp to Owner" button, which prefills its phone-number field
  // from this.
  phone?: string;
  address?: string;
  enabledPages?: string[] | null;
  hasPageVisibilityKey?: boolean;
  hasCancelOrderKey?: boolean;
  // This shop's custom DineIn table labels (Shop.tables) - see
  // src/lib/table-options.ts. Empty/absent means no custom layout.
  tables?: string[];
  // Whether the customer receipt should print automatically the instant an
  // order is completed & settled, broken out per order type - see
  // models/Shop.js's own comment and SalesPage.tsx's completeOrder, the
  // only place this is actually read. Absent (an older shop that's never
  // saved this) should be treated the same as all-false.
  receiptAutoPrint?: { dineIn: boolean; takeAway: boolean; delivery: boolean };
}

export async function fetchShopProfile() {
  try {
    const response = await api.get<ShopProfile>('/shop/profile');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

// PATCH /shop/profile - see shopOwnerController.exports.updateOwnShop. Used
// for the receiptAutoPrint checkboxes in Settings (Hardware/POS) and the
// Shop Name/Shop Address fields in Settings (Store Profile) - phone/email
// are also accepted server-side but nothing in this app's UI edits those
// through this call yet.
export async function updateShopProfile(payload: { name?: string; address?: string; receiptAutoPrint?: Partial<{ dineIn: boolean; takeAway: boolean; delivery: boolean }> }) {
  try {
    const response = await api.patch<ShopProfile>('/shop/profile', payload);
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

export interface JazzCashConfig {
  merchantId: string;
  password: string;
  integritySalt: string;
  environment: 'sandbox' | 'live';
}
export interface EasyPaisaConfig {
  storeId: string;
  hashKey: string;
  environment: 'sandbox' | 'live';
}
export interface OrderingSettings {
  riderPhones: string[];
  paymentGateway: { jazzCash?: Partial<JazzCashConfig>; easyPaisa?: Partial<EasyPaisaConfig> };
}

// See shopOwnerController.exports.getOrderingSettings/updateOrderingSettings
// - kept separate from fetchShopProfile above specifically because this
// one carries real payment-gateway secrets (JazzCash password/Integrity
// Salt, EasyPaisa Hash Key), so it's only ever fetched by
// CustomerOrderingSection.tsx, never the general shop-profile call used
// broadly across the dashboard.
export async function fetchOrderingSettings() {
  try {
    const response = await api.get<OrderingSettings>('/shop/ordering-settings');
    return response.data;
  } catch (error) {
    handleApiError(error);
  }
}

export async function updateOrderingSettings(payload: {
  riderPhones?: string[];
  jazzCash?: Partial<JazzCashConfig>;
  easyPaisa?: Partial<EasyPaisaConfig>;
}) {
  try {
    const response = await api.patch<OrderingSettings>('/shop/ordering-settings', payload);
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
