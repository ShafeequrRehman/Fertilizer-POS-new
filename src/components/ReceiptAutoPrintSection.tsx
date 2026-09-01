import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { fetchShopProfile, updateShopProfile } from '@/lib/pos-api';

// Lets the Shop Owner decide whether the customer receipt should print
// automatically the instant an order is completed & settled (see
// SalesPage.tsx's completeOrder) - broken out per order type, since a shop
// may want this at the counter for Dine-In/Takeaway but not for Delivery
// (nobody to hand a paper receipt to until the rider shows up), or any
// other mix. Backed by the Shop model (models/Shop.js's receiptAutoPrint),
// not a per-device setting, so it applies the same way no matter which
// till/staff member completes the order. Printing itself always stays a
// manual, on-demand action too (the Print Receipt button never goes away)
// - this only controls whether it ALSO happens automatically.
export function ReceiptAutoPrintSection() {
  const [loading, setLoading] = useState(true);
  const [dineIn, setDineIn] = useState(false);
  const [takeAway, setTakeAway] = useState(false);
  const [delivery, setDelivery] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const profile = await fetchShopProfile();
      if (profile?.receiptAutoPrint) {
        setDineIn(Boolean(profile.receiptAutoPrint.dineIn));
        setTakeAway(Boolean(profile.receiptAutoPrint.takeAway));
        setDelivery(Boolean(profile.receiptAutoPrint.delivery));
      }
      setLoading(false);
    })();
  }, []);

  async function handleSave() {
    setSaving(true);
    setSavedMessage('');
    const result = await updateShopProfile({ receiptAutoPrint: { dineIn, takeAway, delivery } });
    setSaving(false);
    if (result) setSavedMessage('Saved.');
    window.setTimeout(() => setSavedMessage(''), 2500);
  }

  return (
    <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-6">
      <div className="mb-4 flex items-center gap-2">
        <Printer size={18} className="text-indigo-600" />
        <h3 className="text-sm font-black text-slate-900">Auto-Print Receipt on Order Completion</h3>
      </div>
      <p className="mb-4 text-xs font-bold text-slate-500">
        When ON for a type, the customer receipt prints automatically the moment that order is completed and settled - no
        need to press Print Receipt separately. Applies across every till, since this is saved to your shop, not one device.
      </p>

      <div className="space-y-3">
        <AutoPrintCheckbox label="Dine-In" checked={dineIn} onChange={setDineIn} disabled={loading} />
        <AutoPrintCheckbox label="Takeaway" checked={takeAway} onChange={setTakeAway} disabled={loading} />
        <AutoPrintCheckbox label="Delivery" checked={delivery} onChange={setDelivery} disabled={loading} />
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || loading}
          className="rounded-2xl bg-[#E2F33C] px-6 py-3 text-sm font-black text-black disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Print Settings'}
        </button>
        {savedMessage ? <span className="text-sm font-black text-emerald-600">{savedMessage}</span> : null}
      </div>
    </div>
  );
}

function AutoPrintCheckbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <span className="text-sm font-bold text-slate-700">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed"
      />
    </label>
  );
}
