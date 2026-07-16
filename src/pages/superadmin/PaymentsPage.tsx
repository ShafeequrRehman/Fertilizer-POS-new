import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { superAdminApi, type PaymentSummary, type ShopSummary } from "@/lib/superadmin-api";

// Internal record-keeping only, per explicit product decision - there is
// no live payment gateway integration. The Super Admin manually logs a
// payment here, then separately extends the license from the Shops page
// (kept as two deliberate steps - see backend/controllers/superAdminController.js
// recordPayment comment).
export default function PaymentsPage() {
  const [payments, setPayments] = useState<PaymentSummary[]>([]);
  const [shops, setShops] = useState<ShopSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ shopId: "", amount: "", method: "cash", monthsCovered: "1", note: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    Promise.all([superAdminApi.listPayments(), superAdminApi.listShops()])
      .then(([p, s]) => { setPayments(p); setShops(s); })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await superAdminApi.recordPayment({
        shopId: form.shopId,
        amount: Number(form.amount) || 0,
        method: form.method,
        monthsCovered: Number(form.monthsCovered) || 1,
        note: form.note,
      });
      setForm({ shopId: "", amount: "", method: "cash", monthsCovered: "1", note: "" });
      setShowForm(false);
      load();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to record payment");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Payments</h1>
          <p className="text-sm text-gray-400">Internal record of payments received from shops (no gateway integration).</p>
        </div>
        <button type="button" onClick={() => setShowForm((v) => !v)} className="flex items-center gap-2 rounded-full bg-[#E2F33C] px-4 py-2.5 text-sm font-bold text-black">
          <Plus size={16} /> Record Payment
        </button>
      </div>

      {showForm ? (
        <div className="mb-6 max-w-xl rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <select value={form.shopId} onChange={(e) => setForm({ ...form, shopId: e.target.value })} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <option value="">Select shop</option>
              {shops.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
            </select>
            <input placeholder="Amount" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2" />
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              {["cash", "bank_transfer", "jazzcash", "easypaisa", "card", "other"].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input placeholder="Months covered" type="number" value={form.monthsCovered} onChange={(e) => setForm({ ...form, monthsCovered: e.target.value })} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2" />
            <input placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="col-span-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2" />
          </div>
          {error ? <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">{error}</div> : null}
          <button type="button" disabled={submitting || !form.shopId || !form.amount} onClick={submit} className="mt-4 rounded-full bg-[#E2F33C] px-4 py-2 text-sm font-bold text-black disabled:opacity-50">
            {submitting ? "Saving..." : "Save Payment"}
          </button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase text-gray-400">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Shop</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3">Months</th>
              <th className="px-4 py-3">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading...</td></tr>
            ) : payments.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No payments recorded yet.</td></tr>
            ) : (
              payments.map((p) => (
                <tr key={p._id} className="hover:bg-white/5">
                  <td className="px-4 py-3">{new Date(p.date).toLocaleDateString()}</td>
                  <td className="px-4 py-3">{typeof p.shopId === "object" ? p.shopId.name : p.shopId}</td>
                  <td className="px-4 py-3 font-semibold">{p.currency} {p.amount}</td>
                  <td className="px-4 py-3 capitalize">{p.method.replace("_", " ")}</td>
                  <td className="px-4 py-3">{p.monthsCovered}</td>
                  <td className="px-4 py-3 text-gray-400">{p.note || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
