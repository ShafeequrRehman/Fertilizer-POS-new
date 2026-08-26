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
  // Manage Staff directory fields (backend/models/User.js)
  designation?: string;
  idCardNumber?: string;
  address?: string;
  // Vehicle/bike registration number - only really relevant when
  // designation is "Delivery Rider", but stored on every employee (see
  // backend/models/User.js).
  vehicleNumber?: string;
  reference?: string;
  comment?: string;
  monthlySalary?: number;
}

export interface PayrollRow {
  employeeId: string;
  name: string;
  username: string;
  designation: string;
  isActive: boolean;
  monthlySalary: number;
  paidThisMonth: number;
  bonusThisMonth: number;
  remaining: number;
}

export interface PayrollSummary {
  totalMonthlySalary: number;
  totalPaidThisMonth: number;
  totalRemaining: number;
}

export interface PayrollResponse {
  month: string;
  rows: PayrollRow[];
  summary: PayrollSummary;
}

export interface StaffPayment {
  _id: string;
  employeeId: { _id: string; name: string; username: string } | string;
  amount: number;
  type: "salary" | "advance" | "bonus" | "deduction";
  note: string;
  date: string;
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

  // Payroll
  getPayroll: (month?: string) =>
    api.get<PayrollResponse>("/shop/payroll", { params: month ? { month } : undefined }).then((r) => r.data),
  listPayments: (params?: { employeeId?: string; month?: string }) =>
    api.get<StaffPayment[]>("/shop/payroll/payments", { params }).then((r) => r.data),
  recordPayment: (payload: { employeeId: string; amount: number; type: string; note?: string; date?: string }) =>
    api.post<StaffPayment>("/shop/payroll/payments", payload).then((r) => r.data),
  deletePayment: (id: string) => api.delete(`/shop/payroll/payments/${id}`).then((r) => r.data),
};
