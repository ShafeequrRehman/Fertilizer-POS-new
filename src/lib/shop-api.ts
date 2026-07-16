import { api } from "@/lib/api";

// Thin wrappers around backend/routes/shopOwnerRoutes.js (employees, roles,
// permission catalog, own-shop profile). Requires a Shop Owner session -
// enforced server-side via authenticate + requireShopOwner + requireLicenseValid.

export interface EmployeeSummary {
  _id: string;
  name: string;
  username: string;
  email?: string;
  phone?: string;
  isActive: boolean;
  employeeRoleId?: { _id: string; name: string; permissions: string[] } | string | null;
  createdAt?: string;
}

export interface RoleSummary {
  _id: string;
  name: string;
  permissions: string[];
  isSystem: boolean;
}

export interface PermissionDef {
  key: string;
  label: string;
  module: string;
  description: string;
}

export const shopApi = {
  listEmployees: () => api.get<EmployeeSummary[]>("/shop/employees").then((r) => r.data),
  createEmployee: (payload: Record<string, unknown>) => api.post("/shop/employees", payload).then((r) => r.data),
  updateEmployee: (id: string, payload: Record<string, unknown>) => api.patch(`/shop/employees/${id}`, payload).then((r) => r.data),
  deleteEmployee: (id: string) => api.delete(`/shop/employees/${id}`).then((r) => r.data),
  resetEmployeePassword: (id: string, newPassword: string) =>
    api.patch(`/shop/employees/${id}/reset-password`, { newPassword }).then((r) => r.data),

  listRoles: () => api.get<RoleSummary[]>("/shop/roles").then((r) => r.data),
  createRole: (payload: Record<string, unknown>) => api.post("/shop/roles", payload).then((r) => r.data),
  updateRole: (id: string, payload: Record<string, unknown>) => api.patch(`/shop/roles/${id}`, payload).then((r) => r.data),
  deleteRole: (id: string) => api.delete(`/shop/roles/${id}`).then((r) => r.data),

  listPermissions: () => api.get<PermissionDef[]>("/shop/permissions").then((r) => r.data),

  getProfile: () => api.get("/shop/profile").then((r) => r.data),
  updateProfile: (payload: Record<string, unknown>) => api.patch("/shop/profile", payload).then((r) => r.data),
};
