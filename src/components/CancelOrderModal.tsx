import { useState } from 'react';
import { Lock, XCircle } from 'lucide-react';
import { cancelOrder } from '@/lib/pos-api';
import { SavedOrder } from '@/lib/pos-types';
import { getStoreSettings } from '@/lib/pos-settings';

type ElectronWindow = Window & typeof globalThis & {
  require?: (moduleName: 'electron') => {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  };
};

// Fires the "stop preparation" kitchen ticket the instant an order is
// cancelled, so the kitchen doesn't keep cooking items nobody's paying
// for anymore. Mirrors how POSPage.tsx prints the original kitchen
// ticket on order creation - same printer, same IPC pattern - just a
// different receipt type ("kitchen-cancel", see main.js) that prints
// "*** ORDER CANCELLED ***" plus the reason instead of prices.
function printKitchenCancelTicket(order: SavedOrder) {
  const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
  if (!isElectron) return;

  try {
    const electronRequire = (window as ElectronWindow).require;
    if (!electronRequire) return;
    const { ipcRenderer } = electronRequire('electron');
    const settings = getStoreSettings();
    const printLogo = localStorage.getItem('preferred-print-logo');

    if (settings.kitchenPrinter) {
      ipcRenderer.invoke('print-kitchen-cancel-receipt-data', order, settings.kitchenPrinter, printLogo, settings).catch(console.error);
    } else {
      console.warn('No kitchen printer configured in settings - cancel ticket not printed.');
    }
  } catch (err) {
    console.error('Electron print error (kitchen cancel ticket):', err);
  }
}

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
      if (updated) {
        printKitchenCancelTicket(updated);
        onCancelled(updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel order.');
    } finally {
      setSubmitting(false);
    }
  }

  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-[28px] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-gray-900">Cancel Order #{orderLabel}</h2>
            <p className="mt-1 text-xs font-bold text-gray-400">
              Ask the Shop Owner for the Cancel Order Key set up in the Super Admin panel.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
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
              className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none focus:border-black"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="min-h-24 w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none focus:border-black"
            />
          </div>
        </div>

        {error ? <p className="mt-3 text-sm font-bold text-rose-600">{error}</p> : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} className="rounded-2xl bg-gray-100 py-3 text-sm font-black text-gray-600 transition hover:bg-gray-200">
            Back
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="flex items-center justify-center gap-2 rounded-2xl bg-rose-600 py-3 text-sm font-black text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Lock size={14} />
            {submitting ? 'Cancelling...' : 'Confirm Cancellation'}
          </button>
        </div>
      </div>
    </div>
  );
}
