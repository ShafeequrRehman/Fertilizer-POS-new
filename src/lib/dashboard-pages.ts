// Single source of truth for the desktop sidebar's page list - shared by
// DashboardShell.tsx (renders the nav, filtered by permission + this
// shop's enabledPages) and the Super Admin Shops page (renders the
// select/unselect buttons that control per-shop enabledPages).
//
// Keep `key` values stable once shipped - they're what gets persisted in
// Shop.enabledPages in MongoDB, so renaming one here would silently
// "disable" that page for every shop that had it explicitly toggled,
// until a Super Admin re-saves their selection.
export interface DashboardPageDef {
  key: string;
  label: string;
  href: string;
  /** See lib/auth.ts hasPermission() - omitted means always visible to any logged-in shop member. */
  permission?: string;
}

export const DASHBOARD_PAGES: DashboardPageDef[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  { key: 'pos', label: 'POS', href: '/dashboard/pos', permission: 'sales.create' },
  { key: 'sales', label: 'Sales', href: '/dashboard/sales', permission: 'sales.create' },
  { key: 'accounting', label: 'Accounting', href: '/dashboard/accounting', permission: 'expenses.manage' },
  { key: 'purchase', label: 'Purchase', href: '/dashboard/purchase', permission: 'purchases.manage' },
  { key: 'management', label: 'Customers & HR', href: '/dashboard/management', permission: 'customers.manage' },
  { key: 'dues', label: 'Customer Dues', href: '/dashboard/dues', permission: 'dues.manage' },
  { key: 'ledger', label: 'Ledger', href: '/dashboard/ledger', permission: 'dues.manage' },
  { key: 'record', label: 'Record', href: '/dashboard/record', permission: 'orders.record.view' },
  { key: 'shifts', label: 'Shifts', href: '/dashboard/shifts', permission: 'shop.session.manage' },
  // Role-gated (shop owner only) rather than permission-gated in
  // DashboardShell.tsx - kept here anyway so it still shows up as a
  // toggleable row in the Super Admin's page picker.
  { key: 'payroll', label: 'Payroll', href: '/dashboard/payroll' },
  { key: 'reports', label: 'Reports', href: '/dashboard/reports', permission: 'reports.view' },
  { key: 'employees', label: 'Manage Staff', href: '/dashboard/employees' },
  { key: 'settings', label: 'Settings', href: '/dashboard/settings', permission: 'settings.manage' },
  { key: 'whatsapp', label: 'WhatsApp', href: '/dashboard/whatsapp', permission: 'whatsapp.manage' },
  { key: 'help', label: 'Help', href: '/dashboard/help' },
];
