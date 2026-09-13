export type OrderType = 'DineIn' | 'TakeAway' | 'Delivery';

// The order types a NEW order can be placed as (POSPage.tsx's order-type
// selector). 'DineIn' stays part of OrderType above only for backward
// compatibility with historical orders already saved with it (receipts,
// Sales/Record history, WhatsApp labels, etc. still need to render those
// correctly) - it is no longer offered as a choice when creating an order.
export type CreateOrderType = Exclude<OrderType, 'DineIn'>;

export interface Product {
  id: string | number;
  name: string;
  price: number;
  stock: number;
  category: string;
  variation: string;
  image: string;
  color: string;
  description: string;
  isDeal?: boolean;
  dealItems?: string[];
  // Product Code / SKU: optional, typed or barcode-scanned on the POS
  // screen to instantly add this product/deal to the cart - see
  // POSPage.tsx's product-code entry box. Unique per shop when set (see
  // backend/models/Product.js's partial unique index), but most
  // products/variations will simply leave it blank.
  productCode?: string;
  // Optional company/brand name (e.g. "Engro", "Fauji", "FFC") - a shop
  // selling branded goods (fertilizer, pesticide, seed, etc.) can record
  // who makes a product separately from the product's own name (see
  // ProductManagementSection.tsx's "Company" field). Purely informational -
  // not used for grouping/search key logic, which still keys off name+category.
  company?: string;
  // System-seeded "service" product marker - "" for every ordinary product.
  // See backend/models/Product.js's own comment; drives POSPage.tsx's
  // special Bill/Cash checkout fields and auto-settled payment.
  specialType?: '' | 'electricity_bill' | 'cash';
}

export interface ProductInput {
  name: string;
  price: number;
  stock: number;
  category: string;
  variation: string;
  image: string;
  color: string;
  description: string;
  isDeal?: boolean;
  dealItems?: string[];
  productCode?: string;
  company?: string;
  specialType?: '' | 'electricity_bill' | 'cash';
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  address: string;
  previousDues: number;
}

export interface LedgerOrder {
  id: string;
  dailyOrderNumber?: number;
  createdAt: string;
  orderType: OrderType;
  status: 'pending' | 'completed' | 'cancelled' | 'paid';
  paymentMethod: 'Cash' | 'Card' | 'E-Wallet';
  total: number;
  paidAmount: number;
  remainingAmount: number;
  // Electricity Bill / Cash special-product details - see
  // backend/models/Order.js's own comment. DuesPage.tsx's History dropdown
  // shows these on the matching order entry.
  billTid?: string;
  billName?: string;
  cashRecipientName?: string;
}

// One manual "+ Add Dues" / "- Pay Dues" / "Clear" entry from the Customer
// Dues page - see backend/models/Customer.js's duesHistory subdocument.
// Merged client-side with LedgerCustomer.orders (DuesPage.tsx's History
// dropdown) to give a single "here's everything that makes up what this
// customer owes" trail: a note for manual entries, an order number for
// order-based ones.
export interface DuesHistoryEntry {
  type: 'add' | 'settle';
  amount: number;
  note: string;
  balanceAfter: number;
  createdBy: string;
  createdAt: string;
}

export interface LedgerCustomer {
  id: string;
  name: string;
  phone: string;
  address: string;
  previousDues: number;
  orderCount: number;
  totalBilled: number;
  totalPaid: number;
  totalOrderBalance: number;
  totalDue: number;
  lastOrderAt: string | null;
  orders: LedgerOrder[];
  duesHistory: DuesHistoryEntry[];
}

export interface Waiter {
  id: string;
  name: string;
  isActive: boolean;
}

// Raw-ingredient inventory (Recipe/Stock Management) - distinct from
// Product.stock above, which counts finished, sellable menu items/units.
// Shared across Ingredient/IngredientPurchase/KitchenStockDetail/
// RecipeIngredientLine below so every "which unit is this tracked in" spot
// stays in lockstep with backend/config/ingredientUnits.js's own list -
// grams/kg for solids (cheese, chicken), millilitres/litres for liquids
// (oil, sauces), or "pcs" for unit-less items (pizza boxes, tissues) tracked
// purely by count, with no weight/liquid measurement enforced.
export type IngredientUnit = 'g' | 'kg' | 'ml' | 'l' | 'pcs';

// The one canonical {value, label} list for every unit dropdown in the app
// (Ingredient Stock's own unit picker, Recipe Management's per-line unit
// display) - defined once here so both always offer the exact same options
// in the exact same order and can never drift text out of sync with each
// other.
export const INGREDIENT_UNIT_OPTIONS: { value: IngredientUnit; label: string }[] = [
  { value: 'g', label: 'Grams (g)' },
  { value: 'kg', label: 'Kilograms (kg)' },
  { value: 'ml', label: 'Millilitres (ml)' },
  { value: 'l', label: 'Litres (l)' },
  { value: 'pcs', label: 'Pieces / None (pcs)' },
];

// Recipe Management's Sub-Unit Support (mirrors
// backend/config/ingredientUnits.js's own RECIPE_SUB_UNITS exactly - keep
// both in sync): a recipe line against a kg-tracked ingredient may also be
// entered in g; against an l-tracked one, also in ml - finer precision than
// typing "0.012kg" by hand. A g/ml/pcs-tracked ingredient has no finer
// sub-unit, so it only ever offers its own unit. Order matters - the
// ingredient's own base unit always comes first, so a dropdown built
// straight from this defaults to it.
const RECIPE_SUB_UNITS: Record<IngredientUnit, IngredientUnit[]> = {
  kg: ['kg', 'g'],
  l: ['l', 'ml'],
  g: ['g'],
  ml: ['ml'],
  pcs: ['pcs'],
};

// Every unit a recipe line is allowed to be entered in for an ingredient
// tracked in `baseUnit` - what RecipeManagementSection.tsx builds its
// per-line unit dropdown from. The backend's own recipeController validates
// a submitted unit against the exact same list (via the same-named
// getRecipeUnitOptions in ingredientUnits.js), so this never offers an
// option the save would then reject.
export function getRecipeUnitOptions(baseUnit: IngredientUnit): IngredientUnit[] {
  return RECIPE_SUB_UNITS[baseUnit] || [baseUnit];
}

// Mirrors backend/config/ingredientUnits.js's own UNIT_FAMILY/
// UNIT_TO_SMALLEST_FACTOR/convertQuantity exactly - keep all three in sync.
// Used client-side only by src/lib/offline-ingredient-helpers.ts, to
// estimate (never authoritative - see that file's own comment) how much of
// an ingredient this till's own still-queued offline orders have already
// implicitly consumed, converting each recipe line's unit into the
// ingredient's real stock unit the exact same way the backend's
// stockService.js does at actual deduction time.
const UNIT_FAMILY: Record<IngredientUnit, 'mass' | 'volume' | 'count'> = { g: 'mass', kg: 'mass', ml: 'volume', l: 'volume', pcs: 'count' };
const UNIT_TO_SMALLEST_FACTOR: Record<IngredientUnit, number> = { g: 1, kg: 1000, ml: 1, l: 1000, pcs: 1 };

export function convertQuantity(value: number, fromUnit: IngredientUnit, toUnit: IngredientUnit): number {
  if (fromUnit === toUnit) return value;
  if (UNIT_FAMILY[fromUnit] !== UNIT_FAMILY[toUnit]) return value;
  const fromFactor = UNIT_TO_SMALLEST_FACTOR[fromUnit] ?? 1;
  const toFactor = UNIT_TO_SMALLEST_FACTOR[toUnit] ?? 1;
  return (value * fromFactor) / toFactor;
}

export interface IngredientCategory {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Ingredient {
  id: string;
  name: string;
  unit: IngredientUnit;
  categoryId: string | null;
  currentStock: number;
  // Weighted-average purchase cost per single g/kg/ml/l/pcs - moved only by logging
  // a Purchase (see IngredientPurchase below), never by selling/consuming
  // stock. This is what a sold order's costPrice/grossProfit are priced
  // against (Purchasing/Financial Logic Task 2).
  averageCost: number;
  lowStockThreshold: number;
  isActive: boolean;
}

// One incoming batch of an ingredient (Purchasing/Financial Logic Task 1) -
// the Stock Manager's purchase rate/total/paid/due entry that both restocks
// the ingredient and folds its rate into Ingredient.averageCost above.
export interface IngredientPurchase {
  id: string;
  // Auto-generated, permanent invoice number ("PO-000123") assigned by
  // ingredientPurchaseController.createPurchase off the shop's own
  // never-resetting counter - what a Daily Purchase Details Sheet or
  // supplier-facing export identifies this exact batch by.
  purchaseOrderNumber: string;
  ingredientId: string;
  ingredientName: string;
  unit: IngredientUnit;
  supplierId: string | null;
  // Free-text vendor/company name - grouped by this exact string in the
  // Ledger's company-wise dues view (see CompanyLedgerEntry below).
  companyName: string;
  // Free-text specifics of the batch beyond just which ingredient it
  // restocks (brand, packaging, grade, ...) - shown alongside ingredientName
  // in the Day-End report's Kitchen Stock detail table.
  productDetails: string;
  quantity: number;
  rate: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  purchaseDate: string;
  // Dual-Status Stock Inventory Workflow: "pending" (Order Placed/
  // Dispatched - a PO has been raised but nothing has arrived yet, so this
  // line has NOT been folded into Ingredient.currentStock/averageCost) vs
  // "received" (Maal Received & Paid - it has). The legacy single-batch Log
  // Purchase form (IngredientStockSection.tsx) always creates its rows
  // already "received" - see ingredientPurchaseController.createPurchase's
  // own comment - only the Purchase page's multi-item New Purchase Order /
  // Receive flow ever actually uses "pending".
  status: 'pending' | 'received';
  // Set the moment status flips to "received" - null while still pending.
  receivedAt: string | null;
  note: string;
}

// One ingredient line typed into the Purchase page's "New Purchase Order"
// form - see PurchaseOrderInput below. Rate-Less Order Placement redesign:
// deliberately NO rate/price field here at all - Phase 1 only ever asks for
// Ingredient + Quantity (the manager doesn't know, and isn't asked, what the
// supplier will actually charge until delivery - see
// PurchaseOrderReceiveItemInput below, where the real rate is entered).
export interface PurchaseOrderItemInput {
  ingredientId: string;
  quantity: number;
  productDetails?: string;
}

// Payload for createPurchaseOrder (pos-api.ts) - POST /ingredient-purchases/orders.
// One Supplier Company, one or more ingredient lines, one shared
// auto-generated purchaseOrderNumber - Phase 1 (Order Placed) of the
// Dual-Status workflow. No payment or rate fields here on purpose: nothing's
// been priced or paid because nothing has arrived yet (see
// receivePurchaseOrder for Phase 2, where the real supplier rate AND payment
// are both actually logged together, at the same moment).
export interface PurchaseOrderInput {
  companyName?: string;
  supplierId?: string | null;
  purchaseDate?: string;
  note?: string;
  items: PurchaseOrderItemInput[];
}

// One delivered line's Actual Supplier Rate, entered on the Phase 2 billing
// screen (ReceivePurchaseOrderModal) - `purchaseId` is that specific
// IngredientPurchase line's own id (IngredientPurchase.id above), so the
// backend knows exactly which pending line each entered rate belongs to.
// Every pending line of the order must be represented or receivePurchaseOrder
// rejects the request - see that function's own comment on why a
// partially-priced order can't be billed.
export interface PurchaseOrderReceiveItemInput {
  purchaseId: string;
  rate: number;
}

// A Purchase Order as shown in the Purchase page's log - NOT its own
// backend collection, just IngredientPurchase rows that share one
// purchaseOrderNumber, grouped together client-side (see
// groupPurchasesByOrder in PurchasePage.tsx). Every line of one PO always
// shares the same status/companyName/supplierId/purchaseDate, since
// createPurchaseOrder stamps them identically and receivePurchaseOrder
// always flips every line of an order together in one call.
export interface PurchaseOrderGroup {
  purchaseOrderNumber: string;
  companyName: string;
  supplierId: string | null;
  status: 'pending' | 'received';
  purchaseDate: string;
  receivedAt: string | null;
  items: IngredientPurchase[];
  itemCount: number;
  totalQuantityLabel: string;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
}

// A registered vendor/company (Task 4/5: "Dynamic Company Tabs" - the
// Ingredient Directory's filter tabs are generated from this list, one per
// Supplier, not from raw free-text strings typed into a purchase). `phone`
// doubles as the WhatsApp number a stock export gets sent to (Task 5's
// "Send WhatsApp" button) - this app has exactly one contact number per
// supplier, so there's no separate whatsappNumber field to keep in sync.
export interface Supplier {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
}

// One row of the Ledger's "Suppliers" (company-wise dues) view - Task 4:
// "track outstanding supplier balances dynamically so the user can filter
// or view exactly how much due amount is owed to which specific company."
// totalDue is always this company's REAL balance right now, across every
// purchase ever logged - never scoped to a picked date range (same
// "current balance vs. period activity" split as LedgerCustomer's own
// totalDue). purchaseCount/totalPurchased/totalPaid ARE scoped to whatever
// range was requested (or all-time if none was).
export interface CompanyLedgerEntry {
  companyName: string;
  purchaseCount: number;
  totalPurchased: number;
  totalPaid: number;
  totalDue: number;
  lastPurchaseAt: string | null;
}

// A manually-logged daily operational cost (gas, electricity, wages,
// damage/waste, ...) - Task 3's "Other Expenses" in the Day-End Net Profit
// formula.
export interface Expense {
  id: string;
  category: string;
  amount: number;
  date: string;
  note: string;
  // Employee Expenses (e.g. "Employee Meal") - null/undefined for every
  // ordinary shop-wide expense (rent, utilities, waste...). Populated to
  // {_id, name, username} when the backend has it and an employee is
  // actually attached; a plain id string only ever appears if some future
  // caller creates one without requesting population. Never affects that
  // employee's Payroll "remaining salary" math - see backend/models/
  // Expense.js's own comment on why this stays a separate, informational
  // link rather than an implicit salary deduction.
  employeeId?: { _id: string; name: string; username: string } | string | null;
}

export interface DayEndExpenseBreakdown {
  category: string;
  total: number;
  count: number;
  // True only for the "Kitchen Stock" row (ingredient purchases) - shown in
  // the breakdown for visibility, but deliberately left out of
  // otherExpenses/netProfit since that cost is already counted once, via
  // costOfGoods, when the ingredient is actually consumed by a sale.
  excludedFromNetProfit?: boolean;
}

// One line of the Kitchen Stock detail table (Task 3's "Granular Expense
// Report Breakdown": Company Name, Product Name, Quantity, and the
// financial totals) - one row per IngredientPurchase batch logged in range.
export interface KitchenStockDetail {
  id: string;
  companyName: string;
  ingredientName: string;
  productDetails: string;
  quantity: number;
  unit: IngredientUnit;
  rate: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  purchaseDate: string;
  // When this batch actually became "received" (Dual-Status Stock
  // Inventory Workflow) - what the Day-End/Inventory report's own date
  // range is now scoped against, since purchaseDate only ever means "when
  // it was ordered". Always set - both reports only ever query
  // status:"received" rows in the first place.
  receivedAt: string | null;
}

// Task 3: the Day-End Closing matrix - Net Profit = Revenue - Total
// Product Cost (COGS) - Other Expenses, over whatever date range was
// requested (Daily/Monthly/Yearly/Custom - see fetchDayEndReport).
export interface DayEndReport {
  startDate: string;
  endDate: string;
  revenue: number;
  costOfGoods: number;
  otherExpenses: number;
  // Total logged against IngredientPurchase batches in range - informational
  // only (see expenseBreakdown's "Kitchen Stock" row), never subtracted in
  // netProfit.
  kitchenStockPurchases: number;
  kitchenStockPurchaseCount: number;
  netProfit: number;
  orderCount: number;
  // Day-End Shop Closing Summary: order count split by orderType, always
  // all three keys present (0 for a type with no orders in range) - see
  // reportController.getDayEndReport's own comment.
  orderTypeBreakdown: { DineIn: number; TakeAway: number; Delivery: number };
  // Total still-owed amount (sum of Order.remainingAmount) across every
  // non-cancelled order in range - what the Close Shop screen shows as
  // "Outstanding Due".
  totalDue: number;
  expenseCount: number;
  expenseBreakdown: DayEndExpenseBreakdown[];
  kitchenStockDetails: KitchenStockDetail[];
}

// Role-Based Security: what "reports.view.own_sales" actually returns (see
// reportController.getMySalesReport) - one calendar day, only the orders
// THIS logged-in account created. Deliberately no cost/profit fields at
// all, unlike DayEndReport above.
export interface MySalesOrderRow {
  id: string;
  dailyOrderNumber: number | null;
  orderType: string;
  status: string;
  total: number;
  paidAmount: number;
  remainingAmount: number;
  createdAt: string;
}

export interface MySalesReport {
  date: string;
  orderCount: number;
  cancelledCount: number;
  revenue: number;
  totalCollected: number;
  totalDue: number;
  orders: MySalesOrderRow[];
}

// Role-Based Security: what "reports.view.inventory" actually returns (see
// reportController.getInventoryReport) - kitchen stock purchase logs in
// range plus every company's all-time outstanding balance. Deliberately no
// revenue/costOfGoods/netProfit fields at all, unlike DayEndReport above.
export interface SupplierDueRow {
  companyName: string;
  totalDue: number;
}

export interface InventoryReport {
  startDate: string;
  endDate: string;
  kitchenStockPurchases: number;
  kitchenStockPurchaseCount: number;
  kitchenStockDetails: KitchenStockDetail[];
  supplierDues: SupplierDueRow[];
  totalSupplierDue: number;
}

export interface RecipeIngredientLine {
  ingredientId: string;
  ingredientName: string;
  unit: IngredientUnit;
  quantity: number;
}

// One product SIZE's recipe (e.g. "Chicken Pizza" / "Large") - a Recipe is
// keyed 1:1 to a single Product document, since each size is already its
// own Product document (see backend/models/Product.js's own comment).
export interface Recipe {
  id: string;
  productId: string;
  productName: string;
  variation: string;
  ingredients: RecipeIngredientLine[];
}

export interface ShopSessionSummary {
  orderCount: number;
  cancelledCount: number;
  totalSales: number;
  totalPaid: number;
  totalDue: number;
  paymentBreakdown: { Cash: number; Card: number; 'E-Wallet': number };
}

export interface ShopSession {
  id: string;
  status: 'open' | 'closed';
  openedAt: string;
  openedByName: string;
  closedAt: string | null;
  closedByName: string;
  closedWithUnpaidOrders: boolean;
  summary: ShopSessionSummary;
  /** Only present on the currently open session (GET /shop-session/current) - live running totals. */
  liveSummary?: ShopSessionSummary;
  /** Real, authoritative order-number counter for this session (backend/models/ShopSession.js). Used to keep the Local Hub's own offline order counter in step - see local-hub-api.ts's syncOrderCounter. */
  orderCounter?: number;
}

export interface ShopSessionStatus {
  isOpen: boolean;
  session: ShopSession | null;
  /** Shop-lifetime, never-resetting order count (backend/models/Shop.js's orderSequenceCounter) - printed on receipts as "Tr#". Present regardless of whether the shop is currently open, unlike session.orderCounter. Used to keep the Local Hub's own lifetime counter in step - see local-hub-api.ts's syncLifetimeCounter. */
  shopSequenceCounter?: number;
}

export interface UnresolvedOrder {
  id: string;
  dailyOrderNumber?: number;
  total: number;
  remainingAmount: number;
  status: string;
  orderType: string;
  customerName: string;
  createdAt: string;
}

export interface CloseShopResult {
  closed: boolean;
  session?: ShopSession;
  needsConfirmation?: boolean;
  unresolvedOrders?: UnresolvedOrder[];
}

export interface Discount {
  type: 'value' | 'percent';
  value: number;
  amount: number;
}

export interface CartItem {
  id: string | number;
  name: string;
  price: number;
  quantity: number;
  variation: string;
  image: string;
  // Carried straight off the Product this cart row was added from - see
  // Product.specialType's own comment. "" / undefined for every ordinary item.
  specialType?: '' | 'electricity_bill' | 'cash';
}

export interface OrderFormData {
  orderType: CreateOrderType;
  phone: string;
  customer: string;
  address: string;
  previousDues: number;
  note: string;
  waiter: string;
  // Quick Delivery Charges preset (Free/30/50/Custom row) - only ever
  // meaningful for orderType 'Delivery'. Undefined/0 for every other order.
  deliveryFee?: number;
  // Electricity Bill / Cash special-product fields - only ever shown/typed
  // when the cart has the matching special item in it (see POSPage.tsx's
  // hasElectricityBillItem/hasCashItem). Empty otherwise.
  billTid?: string;
  billName?: string;
  cashRecipientName?: string;
}

export interface OrderPayload {
  orderId?: string;
  clientSyncId?: string;
  dailyOrderNumber?: number;
  // Shop-lifetime, never-resetting order count - printed on receipts as
  // "Tr#" (see backend/models/Order.js's shopSequenceNumber). Unlike
  // dailyOrderNumber, this is never reassigned/reset by a new shop-open.
  shopSequenceNumber?: number;
  // Set by POSPage.tsx when placing an order straight online with a Local
  // Hub available - see local-hub-api.ts's reserveLocalOrderNumber and
  // orderController.js's createOrder. Never set for a plain browser tab
  // (no Local Hub to reserve from) or pos-mobile's own direct online
  // orders - those still get a fresh cloud-assigned number as before.
  requestedDailyOrderNumber?: number;
  // Same idea as requestedDailyOrderNumber above, but for the shop-lifetime
  // Tr# counter (backend/models/Shop.js's orderSequenceCounter) - see
  // local-hub-api.ts's reserveLifetimeOrderNumber.
  requestedShopSequenceNumber?: number;
  items: Array<{
    name: string;
    price: number;
    quantity: number;
    variation: string;
    // The product's own image reference (icon filename, or a hosted/data
    // URL for a custom photo) carried onto the order line so Sales/Record
    // cards can show the exact same photo the POS grid used, instead of
    // re-guessing one from the item's plain-text name after the fact.
    image?: string;
    // See CartItem.specialType / backend/models/Order.js's orderItemSchema.
    specialType?: '' | 'electricity_bill' | 'cash';
  }>;
  total: number;
  subtotal: number;
  tax: number;
  // Quick Delivery Charges preset (POSPage.tsx's Free/30/50/Custom row) -
  // folded into `total` server-side by recalculateTotals (orderController.js),
  // never trusted as authoritative from this payload alone. 0/undefined for
  // every non-Delivery order.
  deliveryFee?: number;
  orderType: OrderType;
  customer: {
    name: string;
    phone: string;
    address: string;
  };
  address: string;
  note: string;
  waiter: string;
  // No longer settable when creating an order (Dining Tables removed from
  // the POS order flow) - stays optional for backward compatibility with
  // historical Dine-In orders that already have one saved.
  table?: string;
  // Electricity Bill / Cash special-product order details - see
  // backend/models/Order.js's own comment on these three fields.
  billTid?: string;
  billName?: string;
  cashRecipientName?: string;
  status: 'pending' | 'completed' | 'cancelled' | 'paid';
  paymentMethod: 'Cash' | 'Card' | 'E-Wallet';
  createdAt: string;
  updatedAt?: string;
  version?: number;
  paidAmount?: number;
  remainingAmount?: number;
  // Change-Return Calculation: the raw cash amount tendered at checkout -
  // see OrderUpdatePayload's matching field below (which is where this
  // actually gets set, via SalesPage.tsx's Complete Payment modal) for the
  // full explanation of how this differs from paidAmount.
  cashReceived?: number;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
  discount?: Discount | null;
  userId?: string;
  // Real-time table-timer alert (see TableTimerAlertWatcher.tsx) -
  // cumulative minutes staff have added via "Extend +10 Minutes", and
  // whether staff dismissed the alert via "Clear Table" (frees the table
  // immediately without changing this order's own status).
  timerExtendedMinutes?: number;
  tableTimerCleared?: boolean;
  // "staff" (the default) for anything rung up from the till/POSPage.tsx/
  // pos-mobile as normal - "customer-qr" only for an order a customer
  // placed themselves via the QR ordering page (see
  // backend/controllers/publicOrderController.js). See SalesPage.tsx's
  // OnlineOrderControls for where trackingStatus is shown/advanced.
  source?: 'staff' | 'customer-qr';
  trackingStatus?: 'awaiting_confirmation' | 'confirmed' | 'preparing' | 'ready' | 'cancelled';
  paymentStatus?: 'unpaid' | 'awaiting_confirmation' | 'paid' | 'failed';
  deliveryLocation?: { lat: number; lng: number; accuracy?: number | null; capturedAt?: string | null } | null;
  // See orderController.exports.assignRider - which staff member (a
  // "Delivery Rider") this Delivery order was handed to, if any.
  assignedRider?: { id: string; name: string; phone: string; assignedAt?: string | null } | null;
  // A customer's own request to add/remove items on this order after
  // placing it (see publicOrderController.requestOrderChange /
  // orderController.respondToChangeRequest) - null until they ask for
  // one. SalesPage.tsx's OnlineOrderControls is where staff approve/
  // reject it.
  customerChangeRequest?: {
    addItems: Array<{ name: string; price: number; quantity: number; variation: string }>;
    removeItems: Array<{ name: string; variation: string; quantity: number }>;
    note: string;
    status: 'pending' | 'approved' | 'rejected';
    requestedAt?: string | null;
    respondedAt?: string | null;
    respondedBy?: string;
  } | null;
}

export interface SavedOrder extends OrderPayload {
  id: string;
  // Set by orderController.createOrder when the order itself saved fine but
  // the customer's contact info could not be synced to the Customers
  // collection (so they won't show up in Customers/Ledger) - see
  // config/seed.js's dropLegacyCustomerPhoneIndex for the historical cause.
  // Never blocks the order; only ever informational.
  customerSyncWarning?: string | null;
  // Set the moment a TakeAway order's customer receipt is actually printed
  // (by whichever till claims it first - see claimReceiptPrint in
  // pos-api.ts). SalesPage.tsx checks this before auto-printing again at
  // Complete Payment, so a TakeAway customer never gets two copies of the
  // same receipt. Always null/undefined for DineIn and Delivery orders,
  // which still only print their customer receipt at Complete Payment.
  customerReceiptPrintedAt?: string | null;
  // Only ever present on objects returned by fetchOrdersList (GET
  // /api/orders?list=true) - `items` on those is always [] (the whole
  // point of the lean endpoint is to not transfer it), and itemCount is
  // the real count computed server-side instead. Anything that fetches a
  // FULL order (fetchOrder, fetchOrders, or any update response) never
  // sets this field at all, which is what makes `itemCount !== undefined`
  // a reliable "this is still the lean placeholder, not the real order"
  // check - see SalesPage.tsx's isSelectedOrderHydrated.
  itemCount?: number;
}

export interface CancelOrderPayload {
  key: string;
  reason?: string;
}

export interface OrderUpdatePayload {
  action?: 'addItems' | 'replaceItems' | 'completeAndSettle';
  items?: Array<{
    name: string;
    price: number;
    quantity: number;
    variation: string;
    image?: string;
  }>;
  note?: string;
  waiter?: string;
  table?: string;
  paymentMethod?: 'Cash' | 'Card' | 'E-Wallet';
  customer?: SavedOrder['customer'];
  address?: string;
  status?: SavedOrder['status'];
  paidAmount?: number;
  remainingAmount?: number;
  // Change-Return Calculation: the raw cash amount the customer physically
  // handed over at checkout - independent of paidAmount above, which is
  // always clamped to however much of THIS bill (plus any other dues) it
  // actually settles. Only meaningful for a Cash payment where the
  // customer tendered more than the bill - see SalesPage.tsx's Complete
  // Payment modal and ThermalReceipt.tsx's "CASH TENDERED"/"CHANGE
  // RETURNED" rows, both of which read this back off the saved order.
  cashReceived?: number;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
  discount?: Discount | null;
}
