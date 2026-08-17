import axios, { AxiosError } from "axios";
import { clearAuthSession, getAuthToken, getRefreshToken, updateTokens, type LoginSessionPayload } from "@/lib/auth";

const DATA_API_BASE_KEY = "api_base_url";
const CLOUD_API_BASE_KEY = "cloud_api_base_url";
const LOCAL_API_BASE = "http://localhost:5000/api";
const IN_APP_SYSTEM_API_BASE = "/api/system";
const AXIOS_REQUEST_TIMEOUT_MS = 8000;

// VITE_API_URL (pos-web/.env, baked in at `npm run build` time) comes
// first when set - that's how a till gets pointed at a centrally-hosted
// backend (see backend/README-deploy.md) instead of the one it used to
// run in-process (see main.js's startBackendServer, now skipped when this
// is set). LOCAL_API_BASE stays as a fallback candidate either way, so a
// shop that never sets VITE_API_URL keeps working exactly as before.
const DEFAULT_CLOUD_API_BASES = [
  import.meta.env.VITE_API_URL,
  LOCAL_API_BASE,
].filter((value): value is string => Boolean(value));

function unique(values: string[]) {
  return [...new Set(values)];
}

function isNonEmptyString(value: string | undefined): value is string {
  return Boolean(value);
}

export function isDesktopApp() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.navigator.userAgent.includes("Electron");
}

export function getApiBaseCandidates() {
  return unique(DEFAULT_CLOUD_API_BASES);
}

function getRuntimeCloudApiBaseCandidates() {
  if (typeof window !== "undefined") {
    // Clear any old remote URLs that might be cached in the browser
    window.localStorage.removeItem(CLOUD_API_BASE_KEY);
    window.localStorage.removeItem(DATA_API_BASE_KEY);
  }

  const browserCandidates = [
    import.meta.env.VITE_API_URL,
    LOCAL_API_BASE,
  ];

  return unique(browserCandidates.filter(isNonEmptyString));
}

export function getStoredApiBaseUrl() {
  if (isDesktopApp()) {
    return getStoredCloudApiBaseUrl();
  }

  if (typeof window === "undefined") {
    return getApiBaseCandidates()[0];
  }

  return getRuntimeCloudApiBaseCandidates()[0];
}

export function setStoredApiBaseUrl(_baseUrl: string) {
  // Disabled: we strictly use the local backend now.
  return;
}

export function getStoredCloudApiBaseUrl() {
  if (typeof window === "undefined") {
    return getApiBaseCandidates()[0];
  }

  return getRuntimeCloudApiBaseCandidates()[0];
}

export function setStoredCloudApiBaseUrl(_baseUrl: string) {
  // Disabled: we strictly use the local backend now.
  return;
}

export function getSystemApiBaseUrl() {
  if (isDesktopApp()) {
    return getStoredCloudApiBaseUrl();
  }
  return IN_APP_SYSTEM_API_BASE;
}

export function buildApiUrl(path: string, baseUrl = getStoredApiBaseUrl()) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

export const API_BASE_URL = getStoredApiBaseUrl();

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: AXIOS_REQUEST_TIMEOUT_MS,
});

api.interceptors.request.use((config) => {
  config.baseURL = config.baseURL || getStoredApiBaseUrl();
  if (typeof window !== "undefined") {
    const token = getAuthToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }

  return config;
});

function getRetryBases(currentBaseUrl?: string | null) {
  return getRuntimeCloudApiBaseCandidates().filter((baseUrl) => baseUrl !== currentBaseUrl);
}

function shouldRetryAgainstOtherBase(error: AxiosError) {
  const status = error.response?.status;
  return !error.response || status === 502 || status === 503 || status === 504 || (typeof status === "number" && status >= 500);
}

api.interceptors.response.use(
  (response) => {
    if (response.config.baseURL && !isDesktopApp()) {
      setStoredApiBaseUrl(response.config.baseURL);
    }

    return response;
  },
  async (error) => {
    const requestUrl = String(error?.config?.url || "");
    const isLoginRequest = requestUrl.includes("/auth/login");
    const axiosError = error instanceof AxiosError ? error : null;
    const originalConfig = axiosError?.config;
    const isRetry = Boolean((originalConfig as { _retriedWithBase?: string } | undefined)?._retriedWithBase);

    if (!isDesktopApp() && axiosError && originalConfig && !isRetry && !isLoginRequest && shouldRetryAgainstOtherBase(axiosError)) {
      const attemptedBase = String(originalConfig.baseURL || "");
      const retryBases = getRetryBases(attemptedBase);

      for (const retryBase of retryBases) {
        try {
          const retriedResponse = await api.request({
            ...originalConfig,
            baseURL: retryBase,
            _retriedWithBase: retryBase,
          } as typeof originalConfig & { _retriedWithBase?: string });
          setStoredApiBaseUrl(retryBase);
          return retriedResponse;
        } catch (retryError) {
          if (!(retryError instanceof AxiosError) || !shouldRetryAgainstOtherBase(retryError)) {
            return Promise.reject(retryError);
          }
        }
      }
    }

    const isRefreshRequest = requestUrl.includes("/auth/refresh");

    // A shop's license can expire, or the shop can be suspended, while a
    // session is already open in the app (not just at login time) - the
    // backend enforces this server-side via requireLicenseValid on every
    // shop-data route (see backend/middleware/requireLicenseValid.js).
    // Route the user to the License Expired screen instead of leaving them
    // on a broken dashboard full of failed requests.
    if (typeof window !== "undefined" && error?.response?.status === 402 && !isLoginRequest) {
      // This app is HashRouter-based (see src/main.tsx) so the current
      // route lives in window.location.hash ("#/dashboard"), never in
      // window.location.pathname - that's always the loaded HTML file's
      // own path (e.g. "/dist/index.html", or under Electron's packaged
      // file:// protocol, the drive-root-relative file path). Comparing
      // pathname against a route name here was always false, and setting
      // window.location.href to a bare route path ("/license-expired")
      // made the browser/Electron try to load that as an actual file -
      // exactly the "Not allowed to load local resource: file:///C:/..."
      // error seen after packaging. Hash assignment is the fix: it's a
      // same-document navigation that HashRouter already listens for.
      if (!window.location.hash.startsWith("#/license-expired")) {
        window.location.hash = "/license-expired";
      }
      return Promise.reject(error);
    }

    if (
      typeof window !== "undefined" &&
      error?.response?.status === 401 &&
      !isLoginRequest &&
      !isRefreshRequest &&
      axiosError &&
      originalConfig &&
      !(originalConfig as { _retriedAfterRefresh?: boolean })._retriedAfterRefresh
    ) {
      const refreshed = await tryRefreshAccessToken();
      if (refreshed) {
        try {
          return await api.request({
            ...originalConfig,
            _retriedAfterRefresh: true,
          } as typeof originalConfig & { _retriedAfterRefresh?: boolean });
        } catch (retryError) {
          return Promise.reject(retryError);
        }
      }

      clearAuthSession();
      // Same HashRouter fix as the 402 branch above - hash, not pathname/href.
      if (!window.location.hash.startsWith("#/login")) {
        window.location.hash = "/login";
      }
    }

    return Promise.reject(error);
  },
);

// Exchanges the stored refresh token for a new access token (see
// backend/controllers/authController.js `refresh`). A single in-flight
// promise is shared so concurrent 401s from several parallel requests
// don't each fire their own refresh call.
let refreshPromise: Promise<boolean> | null = null;

async function tryRefreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  if (!refreshPromise) {
    refreshPromise = axios
      .post(
        `${getStoredApiBaseUrl()}/auth/refresh`,
        { refreshToken },
        { headers: { "Content-Type": "application/json" }, timeout: AXIOS_REQUEST_TIMEOUT_MS },
      )
      .then((response) => {
        const data = response.data as { accessToken: string; refreshToken?: string };
        updateTokens(data.accessToken, data.refreshToken);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

export async function authLoginRequest(username: string, password: string) {
  let lastError: unknown = null;
  const candidates = getRuntimeCloudApiBaseCandidates();

  for (const baseURL of candidates) {
    const url = `${baseURL}/auth/login`;

    try {
      const response = await axios.post(
        url,
        { username, password },
        {
          headers: { "Content-Type": "application/json" },
          timeout: AXIOS_REQUEST_TIMEOUT_MS,
        },
      );
      setStoredCloudApiBaseUrl(baseURL);
      return response.data as LoginSessionPayload & { redirectTo?: string };
    } catch (error) {
      lastError = error;
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        // 423 = temporarily locked, 402 = shop suspended / license expired
        // (see authController.login) - surface these immediately instead
        // of retrying against another backend URL.
        if (status === 400 || status === 401 || status === 402 || status === 423) {
          throw error;
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Login failed");
}

export async function logoutRequest() {
  const refreshToken = getRefreshToken();
  try {
    await api.post("/auth/logout", { refreshToken });
  } catch {
    // Best-effort - the client clears its own session regardless (see
    // clearAuthSession usage in DashboardShell/SuperAdminShell logout).
  }
}

export async function getUsers() {
  const response = await api.get("/users");
  return response.data;
}

export async function createUser(data: any) {
  const response = await api.post("/users", data);
  return response.data;
}

export async function updateUser(id: string, data: any) {
  const response = await api.put(`/users/${id}`, data);
  return response.data;
}

export async function deleteUser(id: string) {
  const response = await api.delete(`/users/${id}`);
  return response.data;
}
