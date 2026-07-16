import { Navigate, Outlet } from 'react-router-dom';
import { getAuthRole, isAuthenticated } from '@/lib/auth';

// Mirrors the old proxy.ts behavior of redirecting an already-authenticated
// user away from /login - now role-aware, since a Super Admin's home is
// /superadmin, not /dashboard.
export default function PublicOnlyRoute() {
  if (isAuthenticated()) {
    const role = getAuthRole();
    return <Navigate to={role === 'superadmin' ? '/superadmin' : '/dashboard'} replace />;
  }

  return <Outlet />;
}
