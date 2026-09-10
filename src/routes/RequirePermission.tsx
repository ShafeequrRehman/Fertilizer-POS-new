import { Navigate, Outlet } from 'react-router-dom';
import { hasPermission, hasAnyPermission } from '@/lib/auth';

// Module-level gate for Employee dashboard routes, e.g.
// <Route element={<RequirePermission permission="expenses.manage" />}>.
// Super Admin and Shop Owner always pass (see hasPermission in
// lib/auth.ts - mirrors backend/middleware/requirePermission.js).
// Employees without the permission are bounced to the dashboard home
// instead of seeing a module they have no access to.
//
// Broken Access Control fix: this used to be the only route guard capable
// of checking a permission at all, but App.tsx only ever wrapped
// dining-tables/offline with it - every other page listed in
// dashboard-pages.ts's DASHBOARD_PAGES (pos, sales, purchase, ingredient
// stock, recipe management, management, dues, ledger, record, shifts,
// reports, settings, whatsapp, accounting) had its sidebar link hidden by
// permission but the ROUTE itself had no guard, so an employee could reach
// any of them (and their data-fetching APIs) just by typing the URL. Every
// one of those routes is now wrapped here too - see App.tsx. `permission`
// now accepts the same `string | string[]` shape DASHBOARD_PAGES already
// uses (an array means ANY ONE key is enough, via hasAnyPermission - e.g.
// Ingredient Stock's 'inventory.manage' OR 'stock.manage'), so this stays
// the exact same source of truth the sidebar filter and
// getFirstAccessiblePage already use - one permission model, checked in
// three places instead of silently only one.
export default function RequirePermission({ permission }: { permission: string | string[] }) {
  const allowed = Array.isArray(permission) ? hasAnyPermission(permission) : hasPermission(permission);
  if (!allowed) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
