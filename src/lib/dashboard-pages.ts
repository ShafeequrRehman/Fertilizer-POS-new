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
  /**
   * Visual Hotkey Badge Tags: the global page-switching hotkey this page
   * responds to (see DashboardShell.tsx's handleGlobalShortcut listener,
   * which handles F1 through F10 - F11/F12 are left alone since browsers
   * reserve those for fullscreen/devtools). F3 used to be a POS-internal
   * "focus product search" action rather than a page link; that behavior
   * was removed so F3 could join the same sequential F1-F10 page mapping
   * as every other hotkeyed page here, per the "systematically map
   * shortcut keys... no page left out" request - there are more sidebar
   * pages than safely-usable function keys, so only the first 10 (by this
   * array's own order) get one; everything after Ledger is intentionally
   * left without a badge. Omitted means no badge/shortcut. Rendered as a
   * small bracketed tag next to the label in NavItem, purely
   * presentational - this field does not itself wire up the keyboard
   * listener.
   */
  hotkey?: string;
}

export const DASHBOARD_PAGES: DashboardPageDef[] = [
  // Sidebar/Route Bypass Bug Fix: `permission: 'view.dashboard'` on top of
  // (not instead of) the existing hideDashboard role toggle - see
  // getIsDashboardHidden's own comment and config/permissions.js's
  // view.dashboard entry for why both independently gate this same item.
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard', permission: 'view.dashboard' },
  { key: 'pos', label: 'POS', href: '/dashboard/pos', permission: 'sales.create', hotkey: 'F1' },
  { key: 'sales', label: 'Sales', href: '/dashboard/sales', permission: 'sales.create', hotkey: 'F2' },
  { key: 'accounting', label: 'Accounting', href: '/dashboard/accounting', permission: 'expenses.manage', hotkey: 'F3' },
  { key: 'purchase', label: 'Purchase', href: '/dashboard/purchase', permission: 'purchases.manage', hotkey: 'F4' },
  // Moved out of Settings so they're directly reachable from the sidebar
  // instead of hidden behind a Settings sub-menu tab. Ingredient Stock
  // accepts EITHER 'inventory.manage' (Manager/Store Keeper, who should
  // reach both Ingredient Stock and Recipe Management) OR the narrower
  // 'stock.manage' (Stock Manager role - see config/permissions.js -
  // deliberately excluded from Recipe Management below, matching that
  // role's "Ingredient Stock only" restriction).
  { key: 'ingredient-stock', label: 'Ingredient Stock', href: '/dashboard/ingredient-stock', permission: ['inventory.manage', 'stock.manage'], hotkey: 'F5' },
  // Restored (was removed in an earlier pass along with Dining Tables/Create
  // Deal as part of a restaurant->fertilizer-shop declutter): a shop that
  // resells raw stock directly under a Product with the same name/unit as
  // its Ingredient (e.g. "Urea") still needs this to link the two, since
  // that's what services/stockService.js's automatic deduction on every
  // order actually reads - without a recipe here, selling a product never
  // touches its Ingredient stock at all, recipe or not. No hotkey assigned
  // here so the existing F6/F7/F8 badges on Customers & HR/Dues/Ledger below
  // don't have to shift.
  { key: 'recipe-management', label: 'Recipe Management', href: '/dashboard/recipe-management', permission: 'inventory.manage' },
  { key: 'management', label: 'Customers & HR', href: '/dashboard/management', permission: 'customers.manage', hotkey: 'F6' },
  { key: 'dues', label: 'Customer Dues', href: '/dashboard/dues', permission: 'dues.manage', hotkey: 'F7' },
  { key: 'ledger', label: 'Ledger', href: '/dashboard/ledger', permission: 'dues.manage', hotkey: 'F8' },
  { key: 'record', label: 'Record', href: '/dashboard/record', permission: 'orders.record.view' },
  { key: 'shifts', label: 'Shifts', href: '/dashboard/shifts', permission: 'shop.session.manage' },
  // Sidebar/Route Bypass Bug Fix: same story as Dining Tables above - used
  // to be ungated, now requires 'manage.devices'.
  { key: 'offline', label: 'Connect Devices', href: '/dashboard/offline', permission: 'manage.devices' },
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
  // getIsDashboardHidden/hasPermission both short-circuiting true for
  // those roles) - and Super Admin doesn't even use this page list at all
  // (see App.tsx's separate /superadmin tree). Checks BOTH independent
  // Dashboard gates (see config/permissions.js's view.dashboard comment) so
  // an employee who merely lacks the 'view.dashboard' permission (role
  // never granted it, or it was revoked just for them) gets routed to
  // their real first page immediately on login, instead of landing on
  // '/dashboard' first and only then being bounced by
  // DashboardPageClient.tsx's own route guard.
  if (role !== 'employee' || (!getIsDashboardHidden() && hasPermission('view.dashboard'))) return '/dashboard';

  const firstAllowed = DASHBOARD_PAGES.find((item) => {
    // role is narrowed to the literal 'employee' by the guard above, so
    // this is always true - kept (with an explicit string cast so TS
    // doesn't flag the comparison as unreachable) as a defensive check in
    // case that guard is ever loosened later.
    if ((item.key === 'employees' || item.key === 'payroll') && (role as string) !== 'shopowner') return false;
    if (item.key === 'dashboard') return false;
    if (item.permission) {
      const allowed = Array.isArray(item.permission) ? hasAnyPermission(item.permission) : hasPermission(item.permission);
      if (!allowed) return false;
    }
    return isPageEnabled(item.key);
  });

  return firstAllowed?.href || '/dashboard/help';
}
