import { useNavigate } from "react-router-dom";
import { AlertTriangle, LogOut, Phone, Mail } from "lucide-react";
import { clearAuthSession, getAuthLicense, getAuthShop } from "@/lib/auth";
import { logoutRequest } from "@/lib/api";

// Shown after login validation blocks a Shop Owner/Employee whose shop's
// license has expired, or is suspended (see authController.login step 5,
// and requireLicenseValid.js for the server-side enforcement on every
// shop-data route). No dashboard content is reachable from here - the
// only way out is a renewed license, which only the Super Admin can grant.
export default function LicenseExpiredPage() {
  const navigate = useNavigate();
  const shop = getAuthShop();
  const license = getAuthLicense();

  const handleLogout = async () => {
    await logoutRequest();
    clearAuthSession();
    navigate("/login", { replace: true });
  };

  const expiryText = license?.expiryDate
    ? new Date(license.expiryDate).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 px-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10">
            <AlertTriangle className="text-amber-400" size={32} />
          </div>
          <h1 className="text-2xl font-bold text-white">Subscription Required</h1>
          <p className="mt-2 text-sm text-gray-400">
            {shop?.name ? `Access for "${shop.name}" ` : "Access "}
            has been paused because your subscription license {license?.status === "suspended" ? "has been suspended" : "has expired"}.
          </p>
        </div>

        <div className="mb-6 space-y-3 rounded-xl border border-white/10 bg-black/20 p-4 text-sm">
          <div className="flex justify-between text-gray-300">
            <span>Status</span>
            <span className="font-semibold capitalize text-amber-300">{license?.status || "expired"}</span>
          </div>
          {expiryText ? (
            <div className="flex justify-between text-gray-300">
              <span>License Expired</span>
              <span className="font-semibold text-white">{expiryText}</span>
            </div>
          ) : null}
        </div>

        <p className="mb-6 text-center text-sm text-gray-400">
          To restore access, please contact the software provider to renew your subscription. Your data is safe and will
          be available as soon as your license is renewed.
        </p>

        <div className="mb-6 space-y-2 text-center text-sm text-gray-300">
          <div className="flex items-center justify-center gap-2">
            <Mail size={14} className="text-gray-400" />
            <span>Contact your software provider's support channel</span>
          </div>
          <div className="flex items-center justify-center gap-2 text-gray-500">
            <Phone size={14} />
            <span>Reference your Shop ID when reaching out</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-gray-700 py-2.5 font-semibold text-white transition hover:bg-gray-600"
        >
          <LogOut size={16} />
          Log Out
        </button>
      </div>
    </div>
  );
}
