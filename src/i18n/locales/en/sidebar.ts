// One key per DASHBOARD_PAGES `key` (src/lib/dashboard-pages.ts) - the
// sidebar looks up `sidebar.<item.key>` for each nav link's label instead
// of using DASHBOARD_PAGES' own `.label` directly, so the same shared page
// list (also used by the Super Admin per-shop page-toggle picker, which
// stays English-only) can render a translated sidebar without changing
// that shared data structure.
export const sidebar = {
  dashboard: "Dashboard",
  pos: "POS",
  sales: "Sales",
  accounting: "Accounting",
  purchase: "Purchase",
  "ingredient-stock": "Ingredient Stock",
  management: "Customers & HR",
  dues: "Customer Dues",
  ledger: "Ledger",
  record: "Record",
  shifts: "Shifts",
  offline: "Connect Devices",
  payroll: "Payroll",
  reports: "Reports",
  employees: "Manage Staff",
  settings: "Settings",
  whatsapp: "WhatsApp",
  help: "Help",
} as const;
