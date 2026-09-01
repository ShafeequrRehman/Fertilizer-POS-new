import { useState } from 'react';
import { Lock, XCircle } from 'lucide-react';
import { cancelOrder } from '@/lib/pos-api';
import { SavedOrder } from '@/lib/pos-types';

// Shared by SalesPage and RecordPage so both places cancel an order the
// same way: the shop's Cancel Order Key (set per-shop by the Super Admin -
// see backend/controllers/superAdminController.js exports.createShop /
// resetCancelOrderKey) is required, never a hardcoded PIN. The backend is
// the real gate (backend/controllers/orderController.js exports.cancelOrder)
// - this modal just collects the key and reason and surfaces any error the
// server sends back (wrong key, already cancelled, no key configured yet).
export default function CancelOrderModal({
  order,
  onClose,
  onCancelled,
}: {
  order: SavedOrder;
  onClose: () => void;
  onCancelled: (updated: SavedOrder) => void;
}) {
  const [key, setKey] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!key.trim()) {
      setError("Enter the shop's Cancel Order Key.");
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const updated = await cancelOrder(order.id, { key: key.trim(), reason: reason.trim() || undefined });
      if (updated) onCancelled(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel order.');
    } finally {
      setSubmitting(false);
    }
  }

  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);

  return (
    <div className="glass-overlay fixed inset-0 z-[150] flex items-center justify-center p-4">
      <div className="glass-strong w-full max-w-md rounded-[28px] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-gray-900">Cancel Order #{orderLabel}</h2>
            <p className="mt-1 text-xs font-bold text-gray-400">
              Ask the Shop Owner for the Cancel Order Key set up in the Super Admin panel.
            </p>
          </div>
          <button type="button" onClick={onClose} className="glass-pill rounded-full p-2.5 text-gray-500 transition hover:bg-white/70 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">Cancel Order Key</label>
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              className="w-full rounded-2xl border border-white/60 bg-white/50 px-4 py-3 shadow-inner outline-none focus:border-black/40"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="min-h-24 w-full rounded-2xl border border-white/60 bg-white/50 px-4 py-3 shadow-inner outline-none focus:border-black/40"
            />
          </div>
        </div>

        {error ? <p className="mt-3 text-sm font-bold text-rose-600">{error}</p> : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} className="glass-pill rounded-2xl py-3 text-sm font-black text-gray-600 transition hover:bg-white/70">
            Back
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="flex items-center justify-center gap-2 rounded-2xl border-[0.5px] border-white/40 bg-gradient-to-b from-rose-500 to-rose-700 py-3 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-4px_10px_rgba(136,19,55,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Lock size={14} />
            {submitting ? 'Cancelling...' : 'Confirm Cancellation'}
          </button>
        </div>
      </div>
    </div>
  );
}
