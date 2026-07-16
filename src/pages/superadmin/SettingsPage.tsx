import { useEffect, useState } from "react";
import { superAdminApi } from "@/lib/superadmin-api";

interface SettingsForm {
  supportEmail: string;
  supportPhone: string;
  defaultCurrency: string;
  defaultTrialDays: number;
  licenseExpiryWarningDays: number;
  maintenanceMode: boolean;
  announcement: string;
}

export default function SettingsPage() {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    superAdminApi.getSettings().then(setForm);
  }, []);

  const update = (key: keyof SettingsForm, value: string | number | boolean) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setSaved(false);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await superAdminApi.updateSettings(form);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  if (!form) return <div className="text-sm text-gray-500">Loading...</div>;

  return (
    <div className="max-w-xl">
      <h1 className="mb-1 text-2xl font-bold">Software Settings</h1>
      <p className="mb-6 text-sm text-gray-400">Product-wide defaults, not specific to any single shop.</p>

      <div className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-5 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <LabeledInput label="Support Email" value={form.supportEmail} onChange={(v) => update("supportEmail", v)} />
          <LabeledInput label="Support Phone" value={form.supportPhone} onChange={(v) => update("supportPhone", v)} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <LabeledInput label="Default Currency" value={form.defaultCurrency} onChange={(v) => update("defaultCurrency", v)} />
          <LabeledInput label="Default Trial Days" value={String(form.defaultTrialDays)} type="number" onChange={(v) => update("defaultTrialDays", Number(v))} />
          <LabeledInput label="Expiry Warning (days)" value={String(form.licenseExpiryWarningDays)} type="number" onChange={(v) => update("licenseExpiryWarningDays", Number(v))} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-400">Announcement (shown to all shops, optional)</label>
          <textarea
            value={form.announcement}
            onChange={(e) => update("announcement", e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={form.maintenanceMode} onChange={(e) => update("maintenanceMode", e.target.checked)} />
          Maintenance mode
        </label>

        {saved ? <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200">Saved.</div> : null}

        <button type="button" disabled={saving} onClick={save} className="rounded-full bg-[#E2F33C] px-4 py-2 text-sm font-bold text-black disabled:opacity-50">
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}

function LabeledInput({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-gray-400">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2" />
    </div>
  );
}
