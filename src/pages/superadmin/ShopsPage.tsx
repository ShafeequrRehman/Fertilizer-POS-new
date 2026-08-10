import { useEffect, useState, type ReactNode } from "react";
import { Plus, Ban, CheckCircle2, KeyRound, CalendarPlus, Pencil, X, ShieldAlert, Eye } from "lucide-react";
import { superAdminApi, type ShopSummary, type PlanSummary } from "@/lib/superadmin-api";
import { useToast } from "@/lib/toast";

export default function ShopsPage() {
  const { toast, confirm } = useToast();
  const [shops, setShops] = useState<ShopSummary[]>([]);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<ShopSummary | null>(null);
  const [extendTarget, setExtendTarget] = useState<ShopSummary | null>(null);
  const [resetTarget, setResetTarget] = useState<ShopSummary | null>(null);
  const [resetKeyTarget, setResetKeyTarget] = useState<ShopSummary | null>(null);
  const [resetPageKeyTarget, setResetPageKeyTarget] = useState<ShopSummary | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([superAdminApi.listShops(), superAdminApi.listPlans()])
      .then(([shopList, planList]) => {
        setShops(shopList);
        setPlans(planList);
      })
      .catch((err) => setError(err?.response?.data?.message || "Failed to load shops"))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const toggleStatus = async (shop: ShopSummary) => {
    const next = shop.status === "active" ? "suspended" : "active";
    const confirmed = await confirm(`${next === "suspended" ? "Suspend" : "Activate"} "${shop.name}"?`, {
      title: next === "suspended" ? "Suspend shop" : "Activate shop",
      confirmText: next === "suspended" ? "Suspend" : "Activate",
      tone: next === "suspended" ? "danger" : "default",
    });
    if (!confirmed) return;
    await superAdminApi.setShopStatus(shop._id, next);
    load();
    toast.success(`"${shop.name}" ${next === "suspended" ? "suspended" : "activated"}.`);
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Shops</h1>
          <p className="text-sm text-gray-400">Every customer running this software, and their license status.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-full bg-[#E2F33C] px-4 py-2.5 text-sm font-bold text-black transition hover:brightness-95"
        >
          <Plus size={16} /> New Shop
        </button>
      </div>

      {error ? <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div> : null}

      <div className="overflow-hidden rounded-2xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase text-gray-400">
            <tr>
              <th className="px-4 py-3">Shop</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">License</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading...</td></tr>
            ) : shops.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No shops yet.</td></tr>
            ) : (
              shops.map((shop) => (
                <tr key={shop._id} className="hover:bg-white/5">
                  <td className="px-4 py-3">
                    <div className="font-semibold">{shop.name}</div>
                    <div className="text-xs text-gray-500">{shop.phone || shop.email || "—"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{shop.owner?.name || "—"}</div>
                    <div className="text-xs text-gray-500">@{shop.owner?.username}</div>
                  </td>
                  <td className="px-4 py-3">{shop.planId?.name || "—"}</td>
                  <td className="px-4 py-3">
                    {shop.license ? (
                      <div>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${licenseBadgeClass(shop.license.isExpired ? "expired" : shop.license.status)}`}>
                          {shop.license.isExpired ? "expired" : shop.license.status}
                        </span>
                        <div className="mt-1 text-xs text-gray-500">
                          until {new Date(shop.license.expiryDate).toLocaleDateString()}
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-500">No license</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${shop.status === "active" ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}`}>
                      {shop.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        title={shop.hasCancelOrderKey ? "Change this shop's Cancel Order Key" : "This shop has no Cancel Order Key yet - set one so staff can cancel orders in the POS"}
                        onClick={() => setResetKeyTarget(shop)}
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold transition ${
                          shop.hasCancelOrderKey
                            ? "border-white/10 text-gray-300 hover:bg-white/10"
                            : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                        }`}
                      >
                        <ShieldAlert size={14} />
                        {shop.hasCancelOrderKey ? "Cancel Key" : "Set Cancel Key"}
                      </button>
                      <button
                        type="button"
                        title={shop.hasPageVisibilityKey ? "Change this shop's Page Visibility Key" : "This shop has no Page Visibility Key yet - set one so the Shop Owner can control their own sidebar pages"}
                        onClick={() => setResetPageKeyTarget(shop)}
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold transition ${
                          shop.hasPageVisibilityKey
                            ? "border-white/10 text-gray-300 hover:bg-white/10"
                            : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                        }`}
                      >
                        <Eye size={14} />
                        {shop.hasPageVisibilityKey ? "Page Key" : "Set Page Key"}
                      </button>
                      <IconButton title="Edit shop" onClick={() => setEditTarget(shop)}><Pencil size={15} /></IconButton>
                      <IconButton title="Extend license" onClick={() => setExtendTarget(shop)}><CalendarPlus size={15} /></IconButton>
                      <IconButton title="Reset owner password" onClick={() => setResetTarget(shop)}><KeyRound size={15} /></IconButton>
                      <IconButton
                        title={shop.status === "active" ? "Suspend shop" : "Activate shop"}
                        onClick={() => toggleStatus(shop)}
                        danger={shop.status === "active"}
                      >
                        {shop.status === "active" ? <Ban size={15} /> : <CheckCircle2 size={15} />}
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showCreate ? <CreateShopModal plans={plans} onClose={() => setShowCreate(false)} onCreated={load} /> : null}
      {editTarget ? <EditShopModal shop={editTarget} plans={plans} onClose={() => setEditTarget(null)} onSaved={load} /> : null}
      {extendTarget ? <ExtendLicenseModal shop={extendTarget} onClose={() => setExtendTarget(null)} onDone={load} /> : null}
      {resetTarget ? <ResetPasswordModal shop={resetTarget} onClose={() => setResetTarget(null)} /> : null}
      {resetKeyTarget ? <ResetCancelKeyModal shop={resetKeyTarget} onClose={() => setResetKeyTarget(null)} /> : null}
      {resetPageKeyTarget ? <ResetPageVisibilityKeyModal shop={resetPageKeyTarget} onClose={() => setResetPageKeyTarget(null)} /> : null}
    </div>
  );
}

function licenseBadgeClass(status: string) {
  switch (status) {
    case "active": return "bg-green-500/20 text-green-300";
    case "trial": return "bg-blue-500/20 text-blue-300";
    case "expired": return "bg-red-500/20 text-red-300";
    case "suspended": return "bg-red-500/20 text-red-300";
    default: return "bg-gray-500/20 text-gray-300";
  }
}

function IconButton({ children, onClick, title, danger }: { children: ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-full border border-white/10 p-2 transition hover:bg-white/10 ${danger ? "text-red-300" : "text-gray-300"}`}
    >
      {children}
    </button>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#15171C] p-6 text-white shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-gray-400 hover:bg-white/10"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CreateShopModal({ plans, onClose, onCreated }: { plans: PlanSummary[]; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    shopName: "", phone: "", email: "", address: "",
    ownerUsername: "", ownerPassword: "", ownerName: "", ownerEmail: "", ownerPhone: "",
    cancelOrderKey: "",
    planId: "", licenseMonths: "12",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [credentials, setCredentials] = useState<{ username: string; password: string; cancelOrderKey: string } | null>(null);

  const update = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    setError("");
    setSubmitting(true);
    try {
      const result = await superAdminApi.createShop({
        ...form,
        licenseMonths: Number(form.licenseMonths) || 1,
        planId: form.planId || undefined,
      });
      setCredentials({ ...result.credentials, cancelOrderKey: result.cancelOrderKey });
      onCreated();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to create shop");
    } finally {
      setSubmitting(false);
    }
  };

  if (credentials) {
    return (
      <ModalShell title="Shop Created" onClose={onClose}>
        <p className="mb-4 text-sm text-gray-300">Save these now - none of them are shown again. Give the Cancel Order Key to the Shop Owner separately from the login credentials; it's what lets them cancel an order in the POS.</p>
        <div className="mb-4 space-y-2 rounded-lg border border-white/10 bg-black/30 p-3 text-sm">
          <div><span className="text-gray-500">Username: </span><span className="font-mono">{credentials.username}</span></div>
          <div><span className="text-gray-500">Password: </span><span className="font-mono">{credentials.password}</span></div>
          <div><span className="text-gray-500">Cancel Order Key: </span><span className="font-mono">{credentials.cancelOrderKey}</span></div>
        </div>
        <button type="button" onClick={onClose} className="w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black">Done</button>
      </ModalShell>
    );
  }

  return (
    <ModalShell title="New Shop" onClose={onClose}>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1 text-sm">
        <Field label="Shop Name" value={form.shopName} onChange={(v) => update("shopName", v)} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone" value={form.phone} onChange={(v) => update("phone", v)} />
          <Field label="Email" value={form.email} onChange={(v) => update("email", v)} />
        </div>
        <Field label="Address" value={form.address} onChange={(v) => update("address", v)} />

        <div className="pt-2 text-xs font-semibold uppercase text-gray-500">Shop Owner Account</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Owner Username" value={form.ownerUsername} onChange={(v) => update("ownerUsername", v)} />
          <Field label="Owner Password" value={form.ownerPassword} onChange={(v) => update("ownerPassword", v)} type="password" />
        </div>
        <Field label="Owner Name" value={form.ownerName} onChange={(v) => update("ownerName", v)} />

        <div className="pt-2 text-xs font-semibold uppercase text-gray-500">Order Cancellation</div>
        <Field label="Cancel Order Key" value={form.cancelOrderKey} onChange={(v) => update("cancelOrderKey", v)} type="password" />
        <p className="-mt-2 text-xs text-gray-500">Required to cancel an order in this shop's POS. Give it to the Shop Owner separately from their login - never shown again after this screen.</p>

        <div className="pt-2 text-xs font-semibold uppercase text-gray-500">Plan &amp; License</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-gray-400">Plan</label>
            <select
              value={form.planId}
              onChange={(e) => update("planId", e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2"
            >
              <option value="">No plan</option>
              {plans.map((plan) => (
                <option key={plan._id} value={plan._id}>{plan.name}</option>
              ))}
            </select>
          </div>
          <Field label="License Months" value={form.licenseMonths} onChange={(v) => update("licenseMonths", v)} type="number" />
        </div>
      </div>

      {error ? <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">{error}</div> : null}

      <button
        type="button"
        disabled={submitting || !form.shopName || !form.ownerUsername || !form.ownerPassword || form.cancelOrderKey.length < 4}
        onClick={submit}
        className="mt-4 w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black disabled:opacity-50"
      >
        {submitting ? "Creating..." : "Create Shop"}
      </button>
    </ModalShell>
  );
}

function EditShopModal({ shop, plans, onClose, onSaved }: { shop: ShopSummary; plans: PlanSummary[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: shop.name || "",
    phone: shop.phone || "",
    email: shop.email || "",
    address: shop.address || "",
    notes: shop.notes || "",
    planId: shop.planId?._id || "",
    ownerName: shop.owner?.name || "",
    ownerUsername: shop.owner?.username || "",
    ownerEmail: shop.owner?.email || "",
    ownerPhone: shop.owner?.phone || "",
    licenseStatus: shop.license?.status || "",
    licenseExpiry: shop.license ? new Date(shop.license.expiryDate).toISOString().slice(0, 10) : "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const update = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    setError("");
    setSubmitting(true);
    try {
      // Three independent resources (shop profile, owner account, license
      // status) behind three routes on the backend - fire them together
      // rather than forcing a save-per-tab UI. Owner update is skipped
      // if there's no owner account yet (shouldn't normally happen, but
      // defensive since createShop and this schema allow it in theory).
      await Promise.all([
        superAdminApi.updateShop(shop._id, {
          name: form.name,
          phone: form.phone,
          email: form.email,
          address: form.address,
          notes: form.notes,
          planId: form.planId || null,
        }),
        shop.owner
          ? superAdminApi.updateOwner(shop._id, {
              name: form.ownerName,
              username: form.ownerUsername,
              email: form.ownerEmail,
              phone: form.ownerPhone,
            })
          : Promise.resolve(),
        shop.license && form.licenseStatus && form.licenseStatus !== shop.license.status
          ? superAdminApi.setLicenseStatus(shop._id, form.licenseStatus)
          : Promise.resolve(),
        shop.license && form.licenseExpiry && form.licenseExpiry !== new Date(shop.license.expiryDate).toISOString().slice(0, 10)
          ? superAdminApi.setLicenseExpiry(shop._id, form.licenseExpiry)
          : Promise.resolve(),
      ]);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to save changes");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Edit Shop — ${shop.name}`} onClose={onClose}>
      <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1 text-sm">
        <Field label="Shop Name" value={form.name} onChange={(v) => update("name", v)} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone" value={form.phone} onChange={(v) => update("phone", v)} />
          <Field label="Email" value={form.email} onChange={(v) => update("email", v)} />
        </div>
        <Field label="Address" value={form.address} onChange={(v) => update("address", v)} />
        <Field label="Notes" value={form.notes} onChange={(v) => update("notes", v)} />

        <div className="pt-2 text-xs font-semibold uppercase text-gray-500">Plan &amp; License</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-gray-400">Plan</label>
            <select
              value={form.planId}
              onChange={(e) => update("planId", e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2"
            >
              <option value="">No plan</option>
              {plans.map((plan) => (
                <option key={plan._id} value={plan._id}>{plan.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-400">License Status</label>
            <select
              value={form.licenseStatus}
              onChange={(e) => update("licenseStatus", e.target.value)}
              disabled={!shop.license}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 disabled:opacity-50"
            >
              {!shop.license ? <option value="">No license</option> : null}
              <option value="trial">trial</option>
              <option value="active">active</option>
              <option value="expired">expired</option>
              <option value="suspended">suspended</option>
            </select>
          </div>
        </div>
        {shop.license ? (
          <div>
            <label className="mb-1 block text-xs text-gray-400">License Expiry Date</label>
            <input
              type="date"
              value={form.licenseExpiry}
              onChange={(e) => update("licenseExpiry", e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-[#E2F33C]"
            />
            <p className="mt-1 text-xs text-gray-500">
              Sets the exact date (can move it earlier or later). To just add renewal months on top of the current date instead, use "Extend license" from the table.
            </p>
          </div>
        ) : null}

        {shop.owner ? (
          <>
            <div className="pt-2 text-xs font-semibold uppercase text-gray-500">Shop Owner Account</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Owner Username" value={form.ownerUsername} onChange={(v) => update("ownerUsername", v)} />
              <Field label="Owner Name" value={form.ownerName} onChange={(v) => update("ownerName", v)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Owner Email" value={form.ownerEmail} onChange={(v) => update("ownerEmail", v)} />
              <Field label="Owner Phone" value={form.ownerPhone} onChange={(v) => update("ownerPhone", v)} />
            </div>
            <p className="text-xs text-gray-500">To change the owner's password, use "Reset owner password" from the table instead.</p>
          </>
        ) : (
          <p className="text-xs text-gray-500">No Shop Owner account found for this shop.</p>
        )}
      </div>

      {error ? <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">{error}</div> : null}

      <button
        type="button"
        disabled={submitting || !form.name}
        onClick={submit}
        className="mt-4 w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black disabled:opacity-50"
      >
        {submitting ? "Saving..." : "Save Changes"}
      </button>
    </ModalShell>
  );
}

function ExtendLicenseModal({ shop, onClose, onDone }: { shop: ShopSummary; onClose: () => void; onDone: () => void }) {
  const [months, setMonths] = useState("1");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await superAdminApi.extendLicense(shop._id, Number(months), note);
      onDone();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to extend license");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Extend License — ${shop.name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <Field label="Months to add" value={months} onChange={setMonths} type="number" />
        <Field label="Note (optional)" value={note} onChange={setNote} />
      </div>
      {error ? <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">{error}</div> : null}
      <button type="button" disabled={submitting} onClick={submit} className="mt-4 w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black disabled:opacity-50">
        {submitting ? "Extending..." : "Extend License"}
      </button>
    </ModalShell>
  );
}

function ResetPasswordModal({ shop, onClose }: { shop: ShopSummary; onClose: () => void }) {
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await superAdminApi.resetOwnerPassword(shop._id, newPassword);
      setDone(true);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to reset password");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <ModalShell title="Password Reset" onClose={onClose}>
        <p className="text-sm text-gray-300">The Shop Owner's password has been updated. Share it with them securely.</p>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black">Done</button>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`Reset Password — ${shop.owner?.username || shop.name}`} onClose={onClose}>
      <Field label="New Password" value={newPassword} onChange={setNewPassword} type="password" />
      {error ? <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">{error}</div> : null}
      <button type="button" disabled={submitting || newPassword.length < 6} onClick={submit} className="mt-4 w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black disabled:opacity-50">
        {submitting ? "Saving..." : "Reset Password"}
      </button>
    </ModalShell>
  );
}

function ResetCancelKeyModal({ shop, onClose }: { shop: ShopSummary; onClose: () => void }) {
  const [newKey, setNewKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await superAdminApi.resetCancelOrderKey(shop._id, newKey);
      setDone(true);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to set Cancel Order Key");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <ModalShell title="Cancel Order Key Set" onClose={onClose}>
        <p className="text-sm text-gray-300">
          The Cancel Order Key for "{shop.name}" is now: <span className="font-mono text-white">{newKey}</span>
        </p>
        <p className="mt-2 text-xs text-gray-500">Share it with the Shop Owner securely. It won't be shown again after this screen.</p>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black">Done</button>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`Set Cancel Order Key — ${shop.name}`} onClose={onClose}>
      <p className="mb-3 text-xs text-gray-500">This is the secret the Shop Owner (or an employee with cancel permission) must enter in the POS to cancel an order. Not their login password.</p>
      <Field label="New Cancel Order Key" value={newKey} onChange={setNewKey} type="password" />
      {error ? <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">{error}</div> : null}
      <button type="button" disabled={submitting || newKey.length < 4} onClick={submit} className="mt-4 w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black disabled:opacity-50">
        {submitting ? "Saving..." : "Set Cancel Order Key"}
      </button>
    </ModalShell>
  );
}

// Same pattern as ResetCancelKeyModal above - a Super Admin never picks
// which pages a shop's sidebar shows directly; they only issue this key,
// and the Shop Owner decides the actual selection themselves from their
// own Settings page (gated by this key - see shopOwnerController.exports.
// updateEnabledPages).
function ResetPageVisibilityKeyModal({ shop, onClose }: { shop: ShopSummary; onClose: () => void }) {
  const [newKey, setNewKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await superAdminApi.resetPageVisibilityKey(shop._id, newKey);
      setDone(true);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to set Page Visibility Key");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <ModalShell title="Page Visibility Key Set" onClose={onClose}>
        <p className="text-sm text-gray-300">
          The Page Visibility Key for "{shop.name}" is now: <span className="font-mono text-white">{newKey}</span>
        </p>
        <p className="mt-2 text-xs text-gray-500">Share it with the Shop Owner securely. It won't be shown again after this screen.</p>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black">Done</button>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`Set Page Visibility Key — ${shop.name}`} onClose={onClose}>
      <p className="mb-3 text-xs text-gray-500">
        This is the secret the Shop Owner must enter, from their own Settings page, to check or uncheck which
        sidebar pages their dashboard shows. Not their login password.
      </p>
      <Field label="New Page Visibility Key" value={newKey} onChange={setNewKey} type="password" />
      {error ? <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">{error}</div> : null}
      <button type="button" disabled={submitting || newKey.length < 4} onClick={submit} className="mt-4 w-full rounded-lg bg-[#E2F33C] py-2 font-bold text-black disabled:opacity-50">
        {submitting ? "Saving..." : "Set Page Visibility Key"}
      </button>
    </ModalShell>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-gray-400">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-[#E2F33C]"
      />
    </div>
  );
}
