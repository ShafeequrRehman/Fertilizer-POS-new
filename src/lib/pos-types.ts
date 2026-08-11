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
  // Set by POSPage.tsx when placing an order straight online with a Local
  // Hub available - see local-hub-api.ts's reserveLocalOrderNumber and
  // orderController.js's createOrder. Never set for a plain browser tab
  // (no Local Hub to reserve from) or pos-mobile's own direct online
  // orders - those still get a fresh cloud-assigned number as before.
  requestedDailyOrderNumber?: number;
  items: Array<{
    name: string;
    price: number;
    quantity: number;
    variation: string;
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
