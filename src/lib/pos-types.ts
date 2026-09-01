export type OrderType = 'DineIn' | 'TakeAway' | 'Delivery';

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
}

export interface Waiter {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Table {
  id: string;
  name: string;
  isFamily: boolean;
  isActive: boolean;
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
}

export interface ShopSessionStatus {
  isOpen: boolean;
  session: ShopSession | null;
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
}

export interface OrderFormData {
  orderType: OrderType;
  phone: string;
  customer: string;
  address: string;
  previousDues: number;
  note: string;
  waiter: string;
  table: string;
}

export interface OrderPayload {
  orderId?: string;
  clientSyncId?: string;
  dailyOrderNumber?: number;
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
  }>;
  total: number;
  subtotal: number;
  tax: number;
  orderType: OrderType;
  customer: {
    name: string;
    phone: string;
    address: string;
  };
  address: string;
  note: string;
  waiter: string;
  table: string;
  status: 'pending' | 'completed' | 'cancelled' | 'paid';
  paymentMethod: 'Cash' | 'Card' | 'E-Wallet';
  createdAt: string;
  updatedAt?: string;
  version?: number;
  paidAmount?: number;
  remainingAmount?: number;
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
}

export interface SavedOrder extends OrderPayload {
  id: string;
  // Set by orderController.createOrder when the order itself saved fine but
  // the customer's contact info could not be synced to the Customers
  // collection (so they won't show up in Customers/Ledger) - see
  // config/seed.js's dropLegacyCustomerPhoneIndex for the historical cause.
  // Never blocks the order; only ever informational.
  customerSyncWarning?: string | null;
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
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
  discount?: Discount | null;
}
