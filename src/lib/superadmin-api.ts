import { api } from "@/lib/api";

// Thin wrappers around backend/routes/superAdminRoutes.js. All of these
// require a Super Admin session - the backend enforces that via
// authenticate + requireSuperAdmin on every route in that file, this is
// just a typed convenience layer for the Super Admin dashboard pages.

export interface ShopSummary {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  status: "active" | "suspended";
  notes?: string;
  planId?: { _id: string; name: string; price?: number; durationMonths?: number } | null;
  license?: {
    status: "trial" | "active" | "expired" | "suspended";
    expiryDate: string;
    isExpired: boolean;
  } | null;
  owner?: { _id: string; name?: string; username: string; email?: string; phone?: string } | null;
  createdAt?: string;
  // Whether this shop already has a Cancel Order Key set (see
  // superAdminController.exports.listShops) - the key itself is never sent
  // to the client, only whether one exists, so the Shops table can flag
  // shops that still need one set up (staff can't cancel orders without
  // it) instead of that only being discoverable by trial and error in the
  // POS.
  hasCancelOrderKey?: boolean;
  // Whether this shop's Page Visibility Key has been set - lets the Shop
  // Owner toggle their own sidebar pages (see lib/dashboard-pages.ts) from
  // their Settings page once they have it. The key itself is never sent to
  // the client, only whether one exists (same convention as
  // hasCancelOrderKey above).
  hasPageVisibilityKey?: boolean;
}

export interface PlanSummary {
  _id: string;
  name: string;
  price: number;
  currency: string;
  durationMonths: number;
  maxEmployees: number;
  features: string[];
  isActive: boolean;
}

export interface PaymentSummary {
  _id: string;
  shopId: { _id: string; name: string } | string;
  planId?: { _id: string; name: string } | string | null;
  amount: number;
  currency: string;
  method: string;
  monthsCovered: number;
  date: string;
  note?: string;
}

export interface StatsSummary {
  totalShops: number;
  activeShops: number;
  suspendedShops: number;
  totalOwners: number;
  totalEmployees: number;
  licensesExpiringSoon: number;
  expiredOrSuspendedLicenses: number;
  totalRevenue: number;
}

export const superAdminApi = {
  listShops: () => api.get<ShopSummary[]>("/superadmin/shops").then((r) => r.data),
  getShop: (id: string) => api.get(`/superadmin/shops/${id}`).then((r) => r.data),
  createShop: (payload: Record<string, unknown>) => api.post("/superadmin/shops", payload).then((r) => r.data),
  updateShop: (id: string, payload: Record<string, unknown>) => api.patch(`/superadmin/shops/${id}`, payload).then((r) => r.data),
  deleteShop: (id: string) => api.delete(`/superadmin/shops/${id}`).then((r) => r.data),
  setShopStatus: (id: string, status: "active" | "suspended") =>
    api.patch(`/superadmin/shops/${id}/status`, { status }).then((r) => r.data),
  resetOwnerPassword: (id: string, newPassword: string) =>
    api.patch(`/superadmin/shops/${id}/owner/reset-password`, { newPassword }).then((r) => r.data),
  resetCancelOrderKey: (id: string, newKey: string) =>
    api.patch(`/superadmin/shops/${id}/cancel-order-key`, { newKey }).then((r) => r.data),
  resetPageVisibilityKey: (id: string, newKey: string) =>
    api.patch(`/superadmin/shops/${id}/page-visibility-key`, { newKey }).then((r) => r.data),
  updateOwner: (id: string, payload: Record<string, unknown>) =>
    api.patch(`/superadmin/shops/${id}/owner`, payload).then((r) => r.data),
  extendLicense: (id: string, months: number, note?: string) =>
    api.post(`/superadmin/shops/${id}/license/extend`, { months, note }).then((r) => r.data),
  setLicenseStatus: (id: string, status: string) =>
    api.patch(`/superadmin/shops/${id}/license/status`, { status }).then((r) => r.data),
  setLicenseExpiry: (id: string, expiryDate: string, note?: string) =>
    api.patch(`/superadmin/shops/${id}/license/expiry`, { expiryDate, note }).then((r) => r.data),

  listPlans: () => api.get<PlanSummary[]>("/superadmin/plans").then((r) => r.data),
  createPlan: (payload: Record<string, unknown>) => api.post("/superadmin/plans", payload).then((r) => r.data),
  updatePlan: (id: string, payload: Record<string, unknown>) => api.patch(`/superadmin/plans/${id}`, payload).then((r) => r.data),
  deletePlan: (id: string) => api.delete(`/superadmin/plans/${id}`).then((r) => r.data),

  listPayments: (shopId?: string) => api.get<PaymentSummary[]>("/superadmin/payments", { params: shopId ? { shopId } : {} }).then((r) => r.data),
  recordPayment: (payload: Record<string, unknown>) => api.post("/superadmin/payments", payload).then((r) => r.data),

  getStats: () => api.get<StatsSummary>("/superadmin/stats").then((r) => r.data),

  getSettings: () => api.get("/superadmin/settings").then((r) => r.data),
  updateSettings: (payload: Record<string, unknown>) => api.patch("/superadmin/settings", payload).then((r) => r.data),

  getLogs: () => api.get("/superadmin/logs").then((r) => r.data),
};
