import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { clearAuthSession, getAuthLicense, getAuthRole, isAuthenticated, type Role } from '@/lib/auth';

const VALID_ROLES: Role[] = ['superadmin', 'shopowner', 'employee'];

// Client-side route guard - the backend is the real enforcement point
// (every shop-data route runs authenticate + requireShopMember/
// requireSuperAdmin + requireLicenseValid), but gating routes here avoids
// flashing a dashboard the user isn't allowed to see before the first API
// call comes back with a 401/402/403.
//
// `allowedRoles` restricts which of the three account tiers can reach the
// wrapped routes at all - e.g. <ProtectedRoute allowedRoles={['superadmin']} />
// for the Super Admin dashboard, or ['shopowner', 'employee'] for the shop
// dashboard. Omit it to just require "logged in, any role".
export default function ProtectedRoute({ allowedRoles }: { allowedRoles?: Role[] }) {
  const location = useLocation();

  if (!isAuthenticated()) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  const role = getAuthRole();

  // ROOT CAUSE of the black screen: a token/role pair left over from
  // BEFORE this multi-tenant redesign (e.g. role stored as the old
  // "admin" string) is truthy, so `isAuthenticated()` passes, but `role`
  // is not one of the three valid tiers. The old code below then computed
  // a fallback of `role === 'superadmin' ? '/superadmin' : '/dashboard'`
  // - since a stale role is never exactly 'superadmin', that always
  // evaluated to '/dashboard'. When the guard protecting /dashboard itself
  // is what's rejecting the role, this redirects to the SAME path you're
  // already on. <Navigate> to the current location renders nothing and
  // triggers no further navigation, so the screen goes blank with zero
  // console errors - exactly the reported symptom.
  //
  // Fix: an unrecognized role means the cached session is stale/invalid,
  // not just "wrong tier" - clear it and force a real re-login instead of
  // computing a "home" that might be the page we're already stuck on.
  if (!role || !VALID_ROLES.includes(role)) {
    clearAuthSession();
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(role)) {
    // Logged in with a recognized role, just the wrong tier for this
    // section - send them to their own home instead of the login screen
    // (they don't need to re-auth). This never self-loops: 'superadmin'
    // only ever lands here failing a /dashboard-tier check (-> /superadmin,
    // a different path), and 'shopowner'/'employee' only ever land here
    // failing a /superadmin-tier check (-> /dashboard, a different path).
    return <Navigate to={role === 'superadmin' ? '/superadmin' : '/dashboard'} replace />;
  }

  // A shop's license can lapse while the cached session is still "logged
  // in" (the access token is valid for up to 2h independent of license
  // status). Catch it here for an instant redirect instead of waiting for
  // the first failed API call - the backend still enforces this
  // server-side regardless (requireLicenseValid).
  if (role === 'shopowner' || role === 'employee') {
    const license = getAuthLicense();
    if (license?.isExpired && location.pathname !== '/license-expired') {
      return <Navigate to="/license-expired" replace />;
    }
  }

  return <Outlet />;
}
