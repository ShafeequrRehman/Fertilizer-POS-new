import { getAuthRole, hasPermission, hasAnyPermission, isPageEnabled, getIsDashboardHidden } from '@/lib/auth';

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
  /**
   * See lib/auth.ts hasPermission() - omitted means always visible to any
   * logged-in shop member. An array means ANY ONE of these keys is enough
   * (lib/auth.ts hasAnyPermission()) - for a page two different roles can
   * reach via two different, non-overlapping permission keys (e.g. Stock
   * Manager's narrow 'stock.manage' vs. Manager/Store Keeper's broader
   * 'inventory.manage').
   */
  permission?: string | string[];
}

export const DASHBOARD_PAGES: DashboardPageDef[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  { key: 'pos', label: 'POS', href: '/dashboard/pos', permission: 'sales.create' },
  { key: 'sales', label: 'Sales', href: '/dashboard/sales', permission: 'sales.create' },
  { key: 'accounting', label: 'Accounting', href: '/dashboard/accounting', permission: 'expenses.manage' },
  { key: 'purchase', label: 'Purchase', href: '/dashboard/purchase', permission: 'purchases.manage' },
  // Moved out of Settings so they're directly reachable from the sidebar
  // instead of hidden behind a Settings sub-menu tab. Ingredient Stock
  // accepts EITHER 'inventory.manage' (Manager/Store Keeper, who should
  // reach both Ingredient Stock and Recipe Management) OR the narrower
  // 'stock.manage' (Stock Manager role - see config/permissions.js -
  // deliberately excluded from Recipe Management below, matching that
  // role's "Ingredient Stock only" restriction). Dining Tables is
  // deliberately left ungated: table CRUD itself has no permission
  // requirement on the backend (see tableRoutes.js's own comment - only the
  // turnover-timer setting needs 'settings.manage'), so every shop member
  // can reach it, matching that same boundary.
  { key: 'ingredient-stock', label: 'Ingredient Stock', href: '/dashboard/ingredient-stock', permission: ['inventory.manage', 'stock.manage'] },
  { key: 'recipe-management', label: 'Recipe Management', href: '/dashboard/recipe-management', permission: 'inventory.manage' },
  { key: 'dining-tables', label: 'Dining Tables', href: '/dashboard/dining-tables' },
  { key: 'management', label: 'Customers & HR', href: '/dashboard/management', permission: 'customers.manage' },
  { key: 'dues', label: 'Customer Dues', href: '/dashboard/dues', permission: 'dues.manage' },
  { key: 'ledger', label: 'Ledger', href: '/dashboard/ledger', permission: 'dues.manage' },
  { key: 'record', label: 'Record', href: '/dashboard/record', permission: 'orders.record.view' },
  { key: 'shifts', label: 'Shifts', href: '/dashboard/shifts', permission: 'shop.session.manage' },
  { key: 'offline', label: 'Connect Devices', href: '/dashboard/offline' },
  // Role-gated (shop owner only) rather than permission-gated in
  // DashboardShell.tsx - kept here anyway so it still shows up as a
  // toggleable row in the Super Admin's page picker.
  { key: 'payroll', label: 'Payroll', href: '/dashboard/payroll' },
  // Accepts the full 'reports.view' OR either of its two narrower scoped
  // keys (Receptionist's own_sales, Stock Manager's inventory) - ReportsPage
  // itself renders a different, more restricted view depending on which one
  // the logged-in account actually has (see its own comment).
  { key: 'reports', label: 'Reports', href: '/dashboard/reports', permission: ['reports.view', 'reports.view.own_sales', 'reports.view.inventory'] },
  { key: 'employees', label: 'Manage Staff', href: '/dashboard/employees' },
  { key: 'settings', label: 'Settings', href: '/dashboard/settings', permission: 'settings.manage' },
  { key: 'whatsapp', label: 'WhatsApp', href: '/dashboard/whatsapp', permission: 'whatsapp.manage' },
  { key: 'help', label: 'Help', href: '/dashboard/help' },
];

// Dashboard Permission Gate: where an employee whose Role has "Hide
// Dashboard" checked should land instead of '/dashboard' - right after
// login (LoginPage.tsx), on the already-authenticated redirect (LoginPage.tsx/
// App.tsx's '/' and '*' routes), and if they ever reach '/dashboard'
// directly anyway (DashboardPageClient.tsx bounces them here too). Mirrors
// DashboardShell.tsx's own nav-item filter exactly (same permission/
// enabledPages/role checks, same 'employees'+'payroll' shop-owner-only
// exclusion) so this never picks a page the sidebar wouldn't also show.
//
// Falls back to '/dashboard/help' (always visible to any logged-in shop
// member, no permission needed) on the vanishingly unlikely chance every
// single other page is also unavailable - so this can never return a
// route that only loops right back into being redirected away again.
export function getFirstAccessiblePage(): string {
  const role = getAuthRole();
  // Shop Owner/Super Admin can never have Dashboard hidden (see
  // getIsDashboardHidden) - and Super Admin doesn't even use this page
  // list at all (see App.tsx's separate /superadmin tree).
  if (role !== 'employee' || !getIsDashboardHidden()) return '/dashboard';

  const firstAllowed = DASHBOARD_PAGES.find((item) => {
    if ((item.key === 'employees' || item.key === 'payroll') && role !== 'shopowner') return false;
    if (item.key === 'dashboard') return false;
    if (item.permission) {
      const allowed = Array.isArray(item.permission) ? hasAnyPermission(item.permission) : hasPermission(item.permission);
      if (!allowed) return false;
    }
    return isPageEnabled(item.key);
  });

  return firstAllowed?.href || '/dashboard/help';
}
