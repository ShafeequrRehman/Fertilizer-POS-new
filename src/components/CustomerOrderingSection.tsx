import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Download, Copy, Check, QrCode as QrCodeIcon, AlertCircle, Plus, Trash2 } from 'lucide-react';
import { getAuthShop } from '@/lib/auth';
import { getShopOrderingUrl } from '@/lib/public-order-api';
import {
  fetchOrderingSettings,
  updateOrderingSettings,
  type JazzCashConfig,
  type EasyPaisaConfig,
} from '@/lib/pos-api';

// Lets the Shop Owner set up everything the QR customer-ordering feature
// needs: the QR code/link itself (see CustomerOrderPage.tsx), which
// WhatsApp number(s) get a Delivery order's details (see
// riderNotificationService.js), and their own JazzCash/EasyPaisa merchant
// credentials so online orders can auto-confirm on verified payment (see
// paymentGatewayService.js). The credentials are fetched/saved through a
// dedicated endpoint (see fetchOrderingSettings/updateOrderingSettings),
// never the general shop-profile call the rest of the dashboard uses, so
// they only ever travel to this one screen.
export function CustomerOrderingSection() {
  const shop = getAuthShop();
  const shopId = shop?.id || '';
  const orderingUrl = shopId ? getShopOrderingUrl(shopId) : '';

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [loading, setLoading] = useState(true);
  const [riderPhones, setRiderPhones] = useState<string[]>([]);
  const [newRiderPhone, setNewRiderPhone] = useState('');
  const [jazzCash, setJazzCash] = useState<Partial<JazzCashConfig>>({ environment: 'sandbox' });
  const [easyPaisa, setEasyPaisa] = useState<Partial<EasyPaisaConfig>>({ environment: 'sandbox' });
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');

  useEffect(() => {
    if (!orderingUrl) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(orderingUrl, { width: 320, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [orderingUrl]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const data = await fetchOrderingSettings();
      if (data) {
        setRiderPhones(data.riderPhones || []);
        setJazzCash({ environment: 'sandbox', ...data.paymentGateway?.jazzCash });
        setEasyPaisa({ environment: 'sandbox', ...data.paymentGateway?.easyPaisa });
      }
      setLoading(false);
    })();
  }, []);

  async function handleCopy() {
    if (!orderingUrl) return;
    try {
      await navigator.clipboard.writeText(orderingUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // The link is also shown as plain text below, selectable manually either way.
    }
  }

  function handleDownload() {
    if (!qrDataUrl) return;
    const link = document.createElement('a');
    link.href = qrDataUrl;
    link.download = `${(shop?.name || 'shop').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-order-qr.png`;
    link.click();
  }

  function addRiderPhone() {
    const trimmed = newRiderPhone.trim();
    if (!trimmed || riderPhones.includes(trimmed)) return;
    setRiderPhones((previous) => [...previous, trimmed]);
    setNewRiderPhone('');
  }

  function removeRiderPhone(phone: string) {
    setRiderPhones((previous) => previous.filter((p) => p !== phone));
  }

  async function handleSave() {
    setSaving(true);
    setSavedMessage('');
    const result = await updateOrderingSettings({ riderPhones, jazzCash, easyPaisa });
    setSaving(false);
    if (result) setSavedMessage('Saved.');
    window.setTimeout(() => setSavedMessage(''), 2500);
  }

  if (!shopId) {
    return (
      <div className="rounded-[28px] border border-slate-200 bg-white p-6">
        <p className="text-sm font-bold text-slate-500">Sign in again to load your shop details before generating a QR code.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[28px] border border-indigo-100 bg-indigo-50/70 p-6">
        <div className="flex items-center gap-2">
          <QrCodeIcon size={18} className="text-indigo-600" />
          <h3 className="text-lg font-black text-slate-900">Customer Self-Ordering QR Code</h3>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Print this and place it on tables or your counter. A customer scans it with their phone's camera - no app
          needed - to see your menu, pick Dine-In / Takeaway / Delivery, choose a free table for Dine-In, and place
          their order directly. It lands in your system exactly like a staff-placed order, and they can even add it
          to their home screen like a real app.
        </p>
      </div>

      <div className="rounded-[28px] border border-slate-200 bg-white p-6">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="flex h-64 w-64 shrink-0 items-center justify-center rounded-2xl bg-slate-50">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="Customer ordering QR code" className="h-56 w-56 rounded-xl bg-white p-2" />
            ) : (
              <span className="text-xs font-bold text-slate-400">Generating...</span>
            )}
          </div>

          <div className="flex-1 space-y-3">
            <div>
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest">Ordering Link</label>
              <div className="mt-1 break-all rounded-2xl bg-slate-50 p-3 text-xs font-bold text-slate-700">{orderingUrl}</div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700"
              >
                {copied ? <Check size={16} className="text-emerald-600" /> : <Copy size={16} />}
                {copied ? 'Copied' : 'Copy Link'}
              </button>
              <button
                type="button"
                onClick={handleDownload}
                disabled={!qrDataUrl}
                className="inline-flex items-center gap-2 rounded-2xl bg-black px-4 py-3 text-sm font-black text-white disabled:opacity-50"
              >
                <Download size={16} />
                Download QR
              </button>
            </div>

            <div className="flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-xs font-bold text-amber-800">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              This link only works once your built app (not just the backend) is deployed to your server - ask your
              provider to confirm if scanning it doesn't load a menu.
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-[28px] border border-slate-200 bg-white p-6">
        <h3 className="text-sm font-black text-slate-900">Delivery Rider WhatsApp Number(s)</h3>
        <p className="mt-1 max-w-2xl text-xs font-bold text-slate-500">
          The moment a Delivery order is confirmed, this number gets a WhatsApp message with the customer's name,
          phone, address, and a Google Maps link to their location - using your shop's own WhatsApp connection (see
          the WhatsApp page). Leave empty to skip rider notifications.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {riderPhones.map((phone) => (
            <span key={phone} className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-2 text-xs font-black text-slate-700">
              {phone}
              <button type="button" onClick={() => removeRiderPhone(phone)}><Trash2 size={12} className="text-rose-500" /></button>
            </span>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            value={newRiderPhone}
            onChange={(e) => setNewRiderPhone(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addRiderPhone()}
            placeholder="03xxxxxxxxx"
            className="flex-1 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-bold outline-none"
          />
          <button type="button" onClick={addRiderPhone} className="inline-flex items-center gap-1 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white">
            <Plus size={16} /> Add
          </button>
        </div>
      </div>

      <div className="rounded-[28px] border border-slate-200 bg-white p-6">
        <h3 className="text-sm font-black text-slate-900">JazzCash Merchant Account</h3>
        <p className="mt-1 text-xs font-bold text-slate-500">Leave blank to keep JazzCash hidden from customers - Cash stays available either way.</p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <LabeledInput label="Merchant ID" value={jazzCash.merchantId || ''} onChange={(v) => setJazzCash((p) => ({ ...p, merchantId: v }))} />
          <LabeledInput label="Password" type="password" value={jazzCash.password || ''} onChange={(v) => setJazzCash((p) => ({ ...p, password: v }))} />
          <LabeledInput label="Integrity Salt" type="password" value={jazzCash.integritySalt || ''} onChange={(v) => setJazzCash((p) => ({ ...p, integritySalt: v }))} />
          <EnvironmentToggle value={jazzCash.environment || 'sandbox'} onChange={(v) => setJazzCash((p) => ({ ...p, environment: v }))} />
        </div>
      </div>

      <div className="rounded-[28px] border border-slate-200 bg-white p-6">
        <h3 className="text-sm font-black text-slate-900">EasyPaisa Merchant Account</h3>
        <p className="mt-1 text-xs font-bold text-slate-500">Leave blank to keep EasyPaisa hidden from customers - Cash stays available either way.</p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <LabeledInput label="Store ID" value={easyPaisa.storeId || ''} onChange={(v) => setEasyPaisa((p) => ({ ...p, storeId: v }))} />
          <LabeledInput label="Hash Key" type="password" value={easyPaisa.hashKey || ''} onChange={(v) => setEasyPaisa((p) => ({ ...p, hashKey: v }))} />
          <EnvironmentToggle value={easyPaisa.environment || 'sandbox'} onChange={(v) => setEasyPaisa((p) => ({ ...p, environment: v }))} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || loading}
          className="rounded-2xl bg-[#E2F33C] px-6 py-3 text-sm font-black text-black disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Ordering Settings'}
        </button>
        {savedMessage ? <span className="text-sm font-black text-emerald-600">{savedMessage}</span> : null}
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-black text-slate-400 uppercase tracking-widest">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-bold outline-none"
      />
    </div>
  );
}

function EnvironmentToggle({ value, onChange }: { value: 'sandbox' | 'live'; onChange: (value: 'sandbox' | 'live') => void }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-black text-slate-400 uppercase tracking-widest">Environment</label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange('sandbox')}
          className={`flex-1 rounded-2xl py-3 text-xs font-black ${value === 'sandbox' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}
        >
          Sandbox
        </button>
        <button
          type="button"
          onClick={() => onChange('live')}
          className={`flex-1 rounded-2xl py-3 text-xs font-black ${value === 'live' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}
        >
          Live
        </button>
      </div>
    </div>
  );
}
