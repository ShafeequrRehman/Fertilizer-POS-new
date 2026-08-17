import { useState } from 'react';
import { Lock, WifiOff, XCircle } from 'lucide-react';
import { cancelOrder, fetchProducts } from '@/lib/pos-api';
import { Product, SavedOrder } from '@/lib/pos-types';
import { getStoreSettings } from '@/lib/pos-settings';
import { reportPrintOutcome, type ToastLike } from '@/lib/print-notify';
import { buildCategoryLookup, dispatchKitchenPrints } from '@/lib/kitchen-print-routing';
import { useToast } from '@/lib/toast';
import { isDesktopApp } from '@/lib/api';
import { useNetworkStatus } from '@/lib/network-status';
import { getAuthUser } from '@/lib/auth';
import { getReferenceData } from '@/lib/local-hub-api';
import { saveOrderCancelOffline } from '@/lib/offline-order-helpers';
import { triggerBackgroundSync } from '@/lib/offline-sync';

// This modal has no product catalog of its own loaded (unlike POSPage/
// SalesPage/EditOrderPage, which already keep one in state for the item
// picker) - a cancel ticket is infrequent enough that fetching it fresh
// right here, only when actually needed, beats keeping a whole extra
// products subscription alive just for this. Falls back to an empty
// lookup (everything routes to the kitchen printer, same as before this
// split existed) if the fetch fails for any reason - never lets a catalog
// hiccup block the cancel ticket itself from printing.
async function getCancelCategoryLookup(useLocalCache: boolean): Promise<Map<string, string>> {
  try {
    if (useLocalCache) {
      const snapshot = await getReferenceData();
      return buildCategoryLookup((snapshot.products || []) as Product[]);
    }
    const result = await fetchProducts();
    return buildCategoryLookup(result.products || []);
  } catch {
    return new Map();
  }
}

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
function printKitchenCancelTicket(order: SavedOrder, toast: ToastLike, categoryLookup: Map<string, string>) {
  const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
  if (!isElectron) return;

  try {
    const electronRequire = (window as ElectronWindow).require;
    if (!electronRequire) return;
    const { ipcRenderer } = electronRequire('electron');
    const settings = getStoreSettings();
    const printLogo = localStorage.getItem('preferred-print-logo');

    if (settings.kitchenPrinter || settings.counterPrinter) {
      void dispatchKitchenPrints(
        order.items,
        categoryLookup,
        settings,
        (groupItems, printerName, label) =>
          reportPrintOutcome(
            ipcRenderer.invoke('print-kitchen-cancel-receipt-data', { ...order, items: groupItems }, printerName, printLogo, settings),
            `${label} cancellation`,
            toast,
          ),
      );
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
  const { toast } = useToast();
  const { isOnline } = useNetworkStatus();
  // Always local-first inside the desktop app, online or not - the key is
  // trusted immediately either way (it never reaches the till - see
  // localOrders.js's "Cancelling an ALREADY-SYNCED order while offline"
  // section) so the kitchen can stop cooking this right now instead of
  // waiting on a live cloud round trip. Replayed for real against the
  // actual gated endpoint moments later, once triggerBackgroundSync's
  // immediate sync attempt lands (typically a second or two if actually
  // online) or, if genuinely offline, once back online - a wrong key
  // surfaces there either way (see OfflineSyncPage.tsx), never here.
  const localFirst = isDesktopApp();
  const trulyOffline = isDesktopApp() && !isOnline;
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
      if (localFirst) {
        const actor = { name: getAuthUser()?.name || getAuthUser()?.username };
        const updated = await saveOrderCancelOffline(order, key.trim(), reason.trim() || undefined, actor);
        // Local Hub reference-data cache, not a live fetchProducts() call -
        // same "don't wait on the network for something this fast"
        // reasoning as everything else in this local-first branch.
        const categoryLookup = await getCancelCategoryLookup(true);
        printKitchenCancelTicket(updated, toast, categoryLookup);
        triggerBackgroundSync();
        toast.success(
          trulyOffline
            ? 'Order cancelled offline - the key will be verified once back online.'
            : 'Order cancelled - the key is being verified now.',
        );
        onCancelled(updated);
        return;
      }

      // Only ever reached from a plain browser tab now (no Local Hub to
      // queue into).
      const updated = await cancelOrder(order.id, { key: key.trim(), reason: reason.trim() || undefined });
      if (updated) {
        const categoryLookup = await getCancelCategoryLookup(false);
        printKitchenCancelTicket(updated, toast, categoryLookup);
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

        {localFirst ? (
          <div className="mt-3 flex items-center gap-2 rounded-[14px] bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
            <WifiOff size={14} className="shrink-0" />
            {trulyOffline
              ? 'Offline - the key will be verified once back online. If it turns out wrong, this will show up as a failed sync to review.'
              : "Cancels instantly - the key is verified moments later in the background. If it turns out wrong, this will show up as a failed sync to review."}
          </div>
        ) : null}

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
