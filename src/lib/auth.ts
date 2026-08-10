import {
  AUTH_COOKIE_KEY,
  AUTH_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  AUTH_ROLE_KEY,
  AUTH_SHOP_ID_KEY,
  AUTH_PERMISSIONS_KEY,
  AUTH_USER_KEY,
  AUTH_SHOP_KEY,
  AUTH_LICENSE_KEY,
} from "@/lib/auth-constants";

export { AUTH_COOKIE_KEY, AUTH_TOKEN_KEY };

export type Role = "superadmin" | "shopowner" | "employee";

export interface SessionUser {
  id?: string;
  _id?: string;
  name?: string;
  username?: string;
  email?: string;
  role?: Role;
  shopId?: string | null;
}

export interface SessionShop {
  id?: string;
  name?: string;
  status?: "active" | "suspended";
  // Super Admin-controlled sidebar page visibility (see
  // lib/dashboard-pages.ts) - null/undefined means no restriction is
  // configured, so every page the user's own permissions allow stays
  // visible. Only set once a Super Admin has explicitly saved a selection
  // for this shop from the Shops page.
  enabledPages?: string[] | null;
}

export interface SessionLicense {
  status?: "trial" | "active" | "expired" | "suspended";
  expiryDate?: string;
  isExpired?: boolean;
}

export interface LoginSessionPayload {
  accessToken: string;
  refreshToken?: string;
  user?: SessionUser;
  shop?: SessionShop | null;
  license?: SessionLicense | null;
  permissions?: string[];
}

function storeBoth(key: string, value: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
  window.sessionStorage.setItem(key, value);
}

function readEither(key: string) {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(key) || window.sessionStorage.getItem(key);
}

function clearBoth(key: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(key);
  window.sessionStorage.removeItem(key);
}

export function getAuthRole(): Role | null {
  return (readEither(AUTH_ROLE_KEY) as Role) || null;
}

export function getAuthToken() {
  return readEither(AUTH_TOKEN_KEY);
}

export function getRefreshToken() {
  return readEither(REFRESH_TOKEN_KEY);
}

export function getAuthShopId() {
  return readEither(AUTH_SHOP_ID_KEY);
}

export function getAuthUser(): SessionUser | null {
  const raw = readEither(AUTH_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function getAuthShop(): SessionShop | null {
  const raw = readEither(AUTH_SHOP_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionShop;
  } catch {
    return null;
  }
}

export function getAuthLicense(): SessionLicense | null {
  const raw = readEither(AUTH_LICENSE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionLicense;
  } catch {
    return null;
  }
}

export function getPermissions(): string[] {
  const raw = readEither(AUTH_PERMISSIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Super Admin and Shop Owner implicitly have every permission within their
// own scope - only Employees are actually restricted by the permissions
// array embedded in their token. Mirrors backend/middleware/requirePermission.js.
export function hasPermission(key: string): boolean {
  const role = getAuthRole();
  if (role === "superadmin" || role === "shopowner") return true;
  return getPermissions().includes(key);
}

// Unlike hasPermission, this is NOT role-gated - a Shop Owner is only
// exempt from their own shop's role/permission rules, not from a Super
// Admin's platform-level page toggle (see Shop.enabledPages). A null/
// undefined list (never configured, or the Super Admin explicitly cleared
// it) means unrestricted - every page passes. This only controls sidebar
// visibility in DashboardShell.tsx; it is not a backend access boundary.
export function isPageEnabled(pageKey: string): boolean {
  const enabledPages = getAuthShop()?.enabledPages;
  if (!enabledPages) return true;
  return enabledPages.includes(pageKey);
}

export function setAuthSession(payload: LoginSessionPayload) {
  if (typeof window === "undefined") return;

  storeBoth(AUTH_TOKEN_KEY, payload.accessToken);
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${AUTH_COOKIE_KEY}=${encodeURIComponent(payload.accessToken)}; path=/; Max-Age=72000; SameSite=Lax${secure}`;

  if (payload.refreshToken) {
    storeBoth(REFRESH_TOKEN_KEY, payload.refreshToken);
  }
  if (payload.user?.role) {
    storeBoth(AUTH_ROLE_KEY, payload.user.role);
  }
  if (payload.user?.shopId) {
    storeBoth(AUTH_SHOP_ID_KEY, String(payload.user.shopId));
  } else {
    clearBoth(AUTH_SHOP_ID_KEY);
  }
  if (payload.user) {
    storeBoth(AUTH_USER_KEY, JSON.stringify(payload.user));
  }
  if (payload.shop) {
    storeBoth(AUTH_SHOP_KEY, JSON.stringify(payload.shop));
  } else {
    clearBoth(AUTH_SHOP_KEY);
  }
  if (payload.license) {
    storeBoth(AUTH_LICENSE_KEY, JSON.stringify(payload.license));
  } else {
    clearBoth(AUTH_LICENSE_KEY);
  }
  storeBoth(AUTH_PERMISSIONS_KEY, JSON.stringify(payload.permissions || []));
}

// Used after a silent token refresh - updates just the access/refresh
// tokens without touching the rest of the cached session (user/shop/etc).
export function updateTokens(accessToken: string, refreshToken?: string) {
  if (typeof window === "undefined") return;
  storeBoth(AUTH_TOKEN_KEY, accessToken);
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${AUTH_COOKIE_KEY}=${encodeURIComponent(accessToken)}; path=/; Max-Age=72000; SameSite=Lax${secure}`;
  if (refreshToken) {
    storeBoth(REFRESH_TOKEN_KEY, refreshToken);
  }
}

export function clearAuthSession() {
  if (typeof window === "undefined") return;

  [AUTH_TOKEN_KEY, REFRESH_TOKEN_KEY, AUTH_ROLE_KEY, AUTH_SHOP_ID_KEY, AUTH_PERMISSIONS_KEY, AUTH_USER_KEY, AUTH_SHOP_KEY, AUTH_LICENSE_KEY].forEach(clearBoth);

  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${AUTH_COOKIE_KEY}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${secure}`;
}

export function isAuthenticated() {
  return Boolean(getAuthToken());
}
