import { useEffect, useState } from "react";
import { Store, CheckCircle2, XCircle, Users, UserCog, AlertTriangle, Banknote } from "lucide-react";
import { superAdminApi, type StatsSummary } from "@/lib/superadmin-api";

export default function OverviewPage() {
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    superAdminApi
      .getStats()
      .then(setStats)
      .catch((err) => setError(err?.response?.data?.message || "Failed to load statistics"));
  }, []);

  const cards = stats
    ? [
        { label: "Total Shops", value: stats.totalShops, icon: <Store size={20} />, tone: "text-blue-300" },
        { label: "Active Shops", value: stats.activeShops, icon: <CheckCircle2 size={20} />, tone: "text-green-300" },
        { label: "Suspended Shops", value: stats.suspendedShops, icon: <XCircle size={20} />, tone: "text-red-300" },
        { label: "Shop Owners", value: stats.totalOwners, icon: <UserCog size={20} />, tone: "text-purple-300" },
        { label: "Employees", value: stats.totalEmployees, icon: <Users size={20} />, tone: "text-cyan-300" },
        { label: "Licenses Expiring Soon", value: stats.licensesExpiringSoon, icon: <AlertTriangle size={20} />, tone: "text-amber-300" },
        { label: "Expired / Suspended Licenses", value: stats.expiredOrSuspendedLicenses, icon: <AlertTriangle size={20} />, tone: "text-red-300" },
        { label: "Total Recorded Revenue", value: `PKR ${(stats.totalRevenue ?? 0).toLocaleString()}`, icon: <Banknote size={20} />, tone: "text-[#E2F33C]" },
      ]
    : [];

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">System Overview</h1>
      <p className="mb-6 text-sm text-gray-400">Snapshot of every shop running on this software.</p>

      {error ? <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div> : null}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className={`mb-3 ${card.tone}`}>{card.icon}</div>
            <div className="text-2xl font-bold">{card.value}</div>
            <div className="mt-1 text-xs text-gray-400">{card.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
