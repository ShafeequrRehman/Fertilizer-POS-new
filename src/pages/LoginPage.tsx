import { FormEvent, useEffect, useState } from "react";
import { AxiosError } from "axios";
import { Eye, EyeOff } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authLoginRequest } from "@/lib/api";
import { isAuthenticated, setAuthSession, getAuthRole } from "@/lib/auth";
import { getFirstAccessiblePage } from "@/lib/dashboard-pages";

export default function LoginPage() {
  return <LoginPageContent />;
}

// Where an already-authenticated user (or a fresh login) lands, based on
// role - Super Admin never sees the shop dashboard, and vice versa.
function defaultPathForRole(role: string | null) {
  if (role === "superadmin") return "/superadmin";
  // Dashboard Permission Gate: an employee whose Role has "Hide Dashboard"
  // checked lands on the first page their permissions DO allow instead of
  // '/dashboard' - see lib/dashboard-pages.ts's getFirstAccessiblePage.
  // A no-op ('/dashboard') for a Shop Owner, or an employee without that
  // restriction, same as before this existed.
  return getFirstAccessiblePage();
}

function LoginPageContent() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedNext = searchParams.get("next");

  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Epoch ms the lock (if any) expires at. This mirrors the server's
  // temporary lockUntil (see backend/controllers/authController.js) - it
  // is always a short countdown, never a permanent disable.
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (isAuthenticated()) {
      navigate(defaultPathForRole(getAuthRole()), { replace: true });
    }
  }, [navigate]);

  // Live countdown while locked; automatically re-enables the form once
  // the lock expires, no page refresh or restart needed.
  useEffect(() => {
    if (!lockedUntil) {
      setSecondsLeft(0);
      return;
    }

    const tick = () => {
      const remaining = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        setSecondsLeft(0);
        setLockedUntil(null);
        setErrorMessage("");
      } else {
        setSecondsLeft(remaining);
      }
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [lockedUntil]);

  const isLocked = secondsLeft > 0;

  const handleLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (isLocked) {
      console.log("[Login] Blocked client-side: form is currently locked", { secondsLeft });
      return;
    }

    setErrorMessage("");
    setIsSubmitting(true);

    const trimmedUsername = username.trim();

    try {
      const res = await authLoginRequest(trimmedUsername, password);

      setAuthSession(res);

      // 402 (license expired / shop suspended) never reaches here - the
      // backend rejects login before issuing tokens in that case (see
      // authController.login). By the time we have a token, the shop (if
      // any) is active and licensed.
      const role = res.user?.role ?? null;
      // Dashboard Permission Gate: the backend's own `redirectTo` (see
      // authController.js's redirectPathFor) can't know this employee's
      // full permission-gated page list, so it always just says
      // "/dashboard" for any non-Super-Admin login - trusting it verbatim
      // here would send a Hide-Dashboard employee straight to the one page
      // they're not supposed to land on. Route that specific case back
      // through defaultPathForRole (which DOES know, via
      // getFirstAccessiblePage) instead; any other redirectTo value
      // (e.g. "/superadmin") is trusted as-is.
      const target = requestedNext || (res.redirectTo && res.redirectTo !== "/dashboard" ? res.redirectTo : defaultPathForRole(role));
      // NOT window.location.assign(target) - this app is HashRouter-based
      // (src/main.tsx), so a bare path like "/dashboard" has no meaning as
      // a real navigation target. In dev that's masked by the Vite server
      // silently serving index.html for any path; under Electron's
      // packaged file:// build there's no server to mask it, and the
      // browser tries to load that path as an actual file on disk -
      // "Not allowed to load local resource: file:///C:/dashboard" is
      // exactly that failure. navigate() stays inside the SPA's hash
      // routing regardless of dev vs. packaged, same as the
      // already-authenticated redirect above.
      navigate(target, { replace: true });
    } catch (error) {
      console.error("[Login] Request failed", error);

      if (error instanceof AxiosError) {
        const data = error.response?.data as
          | { message?: string; secondsRemaining?: number; lockUntil?: string; reason?: string }
          | undefined;

        if (error.response?.status === 423) {
          const seconds = data?.secondsRemaining ?? 60;
          setLockedUntil(Date.now() + seconds * 1000);
          setErrorMessage(data?.message || `Too many failed attempts. Try again in ${seconds}s.`);
        } else if (error.response?.status === 402) {
          // License expired / shop suspended - a professional, specific
          // message rather than a generic "invalid credentials" error.
          setErrorMessage(data?.message || "Your restaurant's license has expired or the restaurant has been suspended. Please contact the software provider.");
        } else if (!error.response) {
          // Request never got a response at all: backend unreachable,
          // CORS failure, or timeout. This is a network-layer failure,
          // not a credentials problem - say so explicitly instead of
          // showing a generic "Login failed".
          setErrorMessage(
            error.code === "ECONNABORTED"
              ? "Login request timed out. Is the backend running on port 5000?"
              : "Could not reach the backend server (network error). Is it running on port 5000?"
          );
        } else {
          setErrorMessage(data?.message || "Login failed");
        }
      } else {
        setErrorMessage("Login failed (unexpected error - see console)");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return <LoginShell
    errorMessage={errorMessage}
    isSubmitting={isSubmitting}
    isLocked={isLocked}
    secondsLeft={secondsLeft}
    showPassword={showPassword}
    username={username}
    password={password}
    onSubmit={handleLogin}
    onUsernameChange={setUsername}
    onPasswordChange={setPassword}
    onTogglePassword={() => setShowPassword((current) => !current)}
  />;
}

function LoginShell({
  errorMessage = "",
  isSubmitting = false,
  isLocked = false,
  secondsLeft = 0,
  showPassword = false,
  username = "",
  password = "",
  onSubmit,
  onUsernameChange,
  onPasswordChange,
  onTogglePassword,
}: {
  errorMessage?: string;
  isSubmitting?: boolean;
  isLocked?: boolean;
  secondsLeft?: number;
  showPassword?: boolean;
  username?: string;
  password?: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  onUsernameChange?: (value: string) => void;
  onPasswordChange?: (value: string) => void;
  onTogglePassword?: () => void;
}) {
  const fieldsDisabled = isSubmitting || isLocked;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur-xl">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold text-white">POS System</h1>
          <p className="mt-1 text-sm text-gray-400">
            Login is required every time the app opens
          </p>
        </div>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="text-sm text-gray-300">Username</label>
            <input
              type="text"
              placeholder="Enter your username"
              value={username}
              onChange={(e) => onUsernameChange?.(e.target.value)}
              autoComplete="username"
              required
              disabled={fieldsDisabled}
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-white transition focus:outline-none focus:ring-2 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          <div>
            <label className="text-sm text-gray-300">Password</label>
            <div className="relative mt-1">
              <input
                type={showPassword ? "text" : "password"}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => onPasswordChange?.(e.target.value)}
                autoComplete="current-password"
                required
                disabled={fieldsDisabled}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 pr-10 text-white transition focus:outline-none focus:ring-2 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-60"
              />

              <button
                type="button"
                onClick={onTogglePassword}
                disabled={fieldsDisabled}
                className="absolute right-3 top-2.5 text-gray-400 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {errorMessage ? (
            <div
              className={`rounded-lg border px-3 py-2 text-sm ${
                isLocked
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                  : "border-red-500/30 bg-red-500/10 text-red-200"
              }`}
            >
              {errorMessage}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={fieldsDisabled}
            className="w-full rounded-lg bg-green-600 py-2 font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isLocked ? `Try again in ${secondsLeft}s` : isSubmitting ? "Checking..." : "Login"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-400">
          Your login stays available for backend order syncing until you log out or the token expires.
        </p>
      </div>
    </div>
  );
}
