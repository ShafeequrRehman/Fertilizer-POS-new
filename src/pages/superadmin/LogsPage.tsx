import { useEffect, useState } from "react";
import { superAdminApi } from "@/lib/superadmin-api";

interface LogEntry {
  type: string;
  date: string;
  shop?: { id: string; name: string } | null;
  detail: string;
  note?: string;
  recordedBy?: string | null;
}

// Best-effort activity feed assembled from License renewal history and
// Payment records - there is no standing AuditLog collection (see
// backend/controllers/superAdminController.js getLogs comment for why
// that was scoped out of this pass).
export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    superAdminApi.getLogs().then(setLogs).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Activity Logs</h1>
      <p className="mb-6 text-sm text-gray-400">License renewals and payments across every shop, most recent first.</p>

      <div className="overflow-hidden rounded-2xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase text-gray-400">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Shop</th>
              <th className="px-4 py-3">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">Loading...</td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No activity yet.</td></tr>
            ) : (
              logs.map((log, idx) => (
                <tr key={idx} className="hover:bg-white/5">
                  <td className="px-4 py-3 text-gray-400">{new Date(log.date).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${log.type === "payment" ? "bg-[#E2F33C]/20 text-[#E2F33C]" : "bg-blue-500/20 text-blue-300"}`}>
                      {log.type === "payment" ? "Payment" : "License Renewal"}
                    </span>
                  </td>
                  <td className="px-4 py-3">{log.shop?.name || "—"}</td>
                  <td className="px-4 py-3 text-gray-300">{log.detail}{log.note ? ` — ${log.note}` : ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
