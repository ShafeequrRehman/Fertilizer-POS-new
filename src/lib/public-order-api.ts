import { api } from './api';

// Talks to backend/routes/publicOrderRoutes.js - the customer-facing QR
// ordering endpoints, reachable with no login at all. Reuses the same
// shared `api` axios instance as every authenticated call in this app
// since there's nothing session-specific about it: no token ever gets
// attached (a customer visiting this page was never logged in), and these
// routes never return the 401/402 statuses that instance's interceptors
// act on.

export interface PublicMenuProduct {
  id: string;
  name: string;
  price: number;
  category: string;
  variation: string;
  image: string;
  // Same per-product color chip POSPage.tsx's own product grid shows
  // behind each icon (see lib/asset-path.ts's getProductImageUrl, used
  // identically here) - keeps the customer ordering page visually
  // synchronized with the exact catalog set up on desktop.
  color: string;
  description: string;
  isDeal: boolean;
}

export interface PublicMenuResponse {
  shopName: string;
  isOpen: boolean;
  // Which online methods are actually usable for this shop - see
  // Shop.paymentGateway (blank/unconfigured until the Shop Owner enters
  // real merchant credentials in Settings). A method that's false here is
  // simply not offered on the payment step - "Cash" is always available.
  paymentMethods: { jazzCash: boolean; easyPaisa: boolean };
  products: PublicMenuProduct[];
}

export async function fetchPublicMenu(shopId: string): Promise<PublicMenuResponse> {
  const response = await api.get<PublicMenuResponse>(`/public/${shopId}/menu`);
  return response.data;
}

export interface PublicTablesResponse {
  tables: string[];
  occupied: string[];
}

export async function fetchPublicTables(shopId: string): Promise<PublicTablesResponse> {
  const response = await api.get<PublicTablesResponse>(`/public/${shopId}/tables`);
  return response.data;
}

export interface PublicCustomerStatus {
  hasActiveDineInOrder: boolean;
  order: { id: string; dailyOrderNumber: number; table: string; createdAt: string } | null;
}

export async function fetchPublicCustomerStatus(shopId: string, phone: string): Promise<PublicCustomerStatus> {
  const response = await api.get<PublicCustomerStatus>(`/public/${shopId}/customer-status`, { params: { phone } });
  return response.data;
}

export type TrackingStatus = 'awaiting_confirmation' | 'confirmed' | 'preparing' | 'ready' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'awaiting_confirmation' | 'paid' | 'failed';

export interface PublicOrderStatus {
  id: string;
  dailyOrderNumber: number;
  orderType: string;
  table: string;
  status: string;
  trackingStatus: TrackingStatus;
  paymentStatus: PaymentStatus;
  total: number;
  createdAt: string;
}

export async function fetchPublicOrderStatus(shopId: string, orderId: string): Promise<PublicOrderStatus> {
  const response = await api.get<PublicOrderStatus>(`/public/${shopId}/orders/${orderId}`);
  return response.data;
}

export interface PublicOrderPayload {
  orderType: 'DineIn' | 'TakeAway' | 'Delivery';
  table?: string;
  customer: { name: string; phone: string; address?: string };
  paymentMethod: 'Cash' | 'JazzCash' | 'EasyPaisa';
  note?: string;
  items: Array<{ name: string; variation: string; quantity: number }>;
  // Real-time GPS captured from the customer's own phone at order-placement
  // time, for a Delivery order - see CustomerOrderPage.tsx's
  // captureLocation. Omitted/undefined if the browser declined or the
  // order isn't Delivery.
  location?: { lat: number; lng: number; accuracy?: number };
}

export interface PublicOrderResult {
  id: string;
  dailyOrderNumber: number;
  orderType: string;
  table: string;
  total: number;
  status: string;
  trackingStatus: TrackingStatus;
  paymentStatus: PaymentStatus;
  requiresOnlinePayment: boolean;
  paymentMethod: string | null;
}

// Errors here carry a `reason` code (see publicOrderController.js) - the
// page reads err.response?.data on failure to show the backend's own
// specific message instead of a generic "something went wrong".
export async function createPublicOrder(shopId: string, payload: PublicOrderPayload): Promise<PublicOrderResult> {
  const response = await api.post<PublicOrderResult>(`/public/${shopId}/orders`, payload);
  return response.data;
}

export interface PaymentRedirect {
  url: string;
  fields: Record<string, string>;
}

// Returns a signed form payload the customer's browser should
// auto-POST straight to JazzCash/EasyPaisa's own hosted checkout page -
// see CustomerOrderPage.tsx's PaymentRedirectForm and
// paymentGatewayService.js for how `fields` is built/signed.
export async function initiatePublicPayment(
  shopId: string,
  orderId: string,
  provider: 'jazzcash' | 'easypaisa',
): Promise<PaymentRedirect> {
  const response = await api.post<PaymentRedirect>(`/public/${shopId}/orders/${orderId}/pay/${provider}`);
  return response.data;
}

// Builds the link a customer scans/opens to reach CustomerOrderPage.tsx for
// this shop. Deliberately NOT based on window.location.origin - when this
// runs inside the Electron shell (the Shop Owner generating their QR code
// from Settings), that origin is an internal app:// / file:// URL a phone
// could never reach. VITE_API_URL (see lib/api.ts) is the one value that's
// actually the server's real public domain in every deployment - just
// strip the trailing /api since the frontend's own build is served from
// that same domain's root (see backend/index.js's express.static(dist)
// mount). Falls back to window.location.origin only when VITE_API_URL was
// never set (e.g. local dev), which is the one case that value happens to
// be correct anyway.
export function getShopOrderingUrl(shopId: string): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  const origin = configured
    ? configured.replace(/\/api\/?$/, '')
    : typeof window !== 'undefined'
    ? window.location.origin
    : '';
  return `${origin}/#/order/${shopId}`;
}
