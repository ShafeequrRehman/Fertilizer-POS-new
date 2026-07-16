import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { superAdminApi, type PlanSummary } from "@/lib/superadmin-api";
import { useToast } from "@/lib/toast";

export default function PlansPage() {
  const { toast, confirm } = useToast();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", price: "", durationMonths: "1", maxEmployees: "10" });
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    superAdminApi.listPlans().then(setPlans).catch((err) => setError(err?.response?.data?.message || "Failed to load plans")).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const createPlan = async () => {
    setSubmitting(true);
    setError("");
    try {
      await superAdminApi.createPlan({
        name: form.name,
        price: Number(form.price) || 0,
        durationMonths: Number(form.durationMonths) || 1,
        maxEmployees: Number(form.maxEmployees) || 10,
      });
      setForm({ name: "", price: "", durationMonths: "1", maxEmployees: "10" });
      load();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to create plan");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (plan: PlanSummary) => {
    await superAdminApi.updatePlan(plan._id, { isActive: !plan.isActive });
    load();
  };

  const remove = async (plan: PlanSummary) => {
    const confirmed = await confirm(`Delete plan "${plan.name}"?`, { title: "Delete plan", confirmText: "Delete", tone: "danger" });
    if (!confirmed) return;
    try {
      await superAdminApi.deletePlan(plan._id);
      load();
      toast.success(`Plan "${plan.name}" deleted.`);
    } catch (err: any) {
      toast.error(err?.response?.data?.message || "Failed to delete plan");
    }
  };

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Plans</h1>
      <p className="mb-6 text-sm text-gray-400">Subscription tiers shops can be assigned to.</p>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        {plans.map((plan) => (
          <div key={plan._id} className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-bold">{plan.name}</span>
              <button type="button" onClick={() => remove(plan)} className="text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>
            </div>
            <div className="text-2xl font-bold text-[#E2F33C]">{plan.currency} {plan.price}</div>
            <div className="mt-1 text-xs text-gray-400">{plan.durationMonths} month(s) · up to {plan.maxEmployees} employees</div>
            <button
              type="button"
              onClick={() => toggleActive(plan)}
              className={`mt-3 w-full rounded-full py-1.5 text-xs font-semibold ${plan.isActive ? "bg-green-500/20 text-green-300" : "bg-gray-500/20 text-gray-400"}`}
            >
              {plan.isActive ? "Active" : "Inactive"}
            </button>
          </div>
        ))}
        {!loading && plans.length === 0 ? <p className="col-span-full text-sm text-gray-500">No plans yet — create one below.</p> : null}
      </div>

      <div className="max-w-xl rounded-2xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-300"><Plus size={16} /> New Plan</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2" />
          <input placeholder="Price (PKR)" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} type="number" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2" />
          <input placeholder="Duration (months)" value={form.durationMonths} onChange={(e) => setForm({ ...form, durationMonths: e.target.value })} type="number" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2" />
          <input placeholder="Max employees" value={form.maxEmployees} onChange={(e) => setForm({ ...form, maxEmployees: e.target.value })} type="number" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2" />
        </div>
        {error ? <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">{error}</div> : null}
        <button
          type="button"
          disabled={submitting || !form.name}
          onClick={createPlan}
          className="mt-4 rounded-full bg-[#E2F33C] px-4 py-2 text-sm font-bold text-black disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create Plan"}
        </button>
      </div>
    </div>
  );
}
