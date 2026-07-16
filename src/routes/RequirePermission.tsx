import { Navigate, Outlet } from 'react-router-dom';
import { hasPermission } from '@/lib/auth';

// Module-level gate for Employee dashboard routes, e.g.
// <Route element={<RequirePermission permission="expenses.manage" />}>.
// Super Admin and Shop Owner always pass (see hasPermission in
// lib/auth.ts - mirrors backend/middleware/requirePermission.js).
// Employees without the permission are bounced to the dashboard home
// instead of seeing a module they have no access to.
export default function RequirePermission({ permission }: { permission: string }) {
  if (!hasPermission(permission)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
