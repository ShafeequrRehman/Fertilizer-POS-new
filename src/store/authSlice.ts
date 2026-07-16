import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  clearAuthSession,
  getAuthRole,
  getAuthShop,
  getAuthShopId,
  getAuthToken,
  getAuthLicense,
  getAuthUser,
  getPermissions,
  isAuthenticated,
  setAuthSession,
  type LoginSessionPayload,
  type Role,
  type SessionLicense,
  type SessionShop,
  type SessionUser,
} from '@/lib/auth';

// Thin Redux wrapper around the lib/auth.ts session helpers (localStorage/
// sessionStorage + cookie), which remain the source of truth. This slice
// mirrors that state into Redux so components re-render on auth changes.
// Extended for multi-tenancy: role, shopId, shop, license, and permissions
// (denormalized from the employee's Role at login - see
// backend/auth/tokenService.js) ride alongside the token/session flag.
export interface AuthState {
  token: string | null;
  role: Role | null;
  shopId: string | null;
  user: SessionUser | null;
  shop: SessionShop | null;
  license: SessionLicense | null;
  permissions: string[];
  isAuthenticated: boolean;
}

function readInitialState(): AuthState {
  return {
    token: getAuthToken(),
    role: getAuthRole(),
    shopId: getAuthShopId(),
    user: getAuthUser(),
    shop: getAuthShop(),
    license: getAuthLicense(),
    permissions: getPermissions(),
    isAuthenticated: isAuthenticated(),
  };
}

const initialState: AuthState = readInitialState();

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    login(state, action: PayloadAction<LoginSessionPayload>) {
      setAuthSession(action.payload);
      state.token = action.payload.accessToken;
      state.role = (action.payload.user?.role as Role) ?? state.role;
      state.shopId = action.payload.user?.shopId ? String(action.payload.user.shopId) : null;
      state.user = action.payload.user ?? state.user;
      state.shop = action.payload.shop ?? null;
      state.license = action.payload.license ?? null;
      state.permissions = action.payload.permissions ?? [];
      state.isAuthenticated = true;
    },
    logout(state) {
      clearAuthSession();
      state.token = null;
      state.role = null;
      state.shopId = null;
      state.user = null;
      state.shop = null;
      state.license = null;
      state.permissions = [];
      state.isAuthenticated = false;
    },
    // Re-syncs Redux state from the underlying storage/cookie helpers.
    // Useful on app boot or after any direct lib/auth.ts call that
    // bypasses the actions above.
    refreshFromStorage(state) {
      state.token = getAuthToken();
      state.role = getAuthRole();
      state.shopId = getAuthShopId();
      state.user = getAuthUser();
      state.shop = getAuthShop();
      state.license = getAuthLicense();
      state.permissions = getPermissions();
      state.isAuthenticated = isAuthenticated();
    },
  },
});

export const { login, logout, refreshFromStorage } = authSlice.actions;
export default authSlice.reducer;
