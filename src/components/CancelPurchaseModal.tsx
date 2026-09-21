import { useState } from 'react';
import { Trash2, XCircle } from 'lucide-react';
import { cancelIngredientPurchase } from '@/lib/pos-api';
import { LedgerPurchase } from '@/lib/pos-types';
import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';

// The purchase-side sibling of CancelOrderModal.tsx - deliberately visually
// matching it so there's one consistent "cancel this" experience in the
// app. Previously also required the shop's Cancel Order Key (the same one
// shared with order cancellation); the shop owner asked to drop that step
// everywhere, so this is now a plain confirm-and-cancel action with just an
// optional reason - access control is the existing purchases.manage/
// stock.manage permission already required for every route on this
// controller (see backend/routes/ingredientPurchaseRoutes.js). Kept as its
// own component rather than generalizing CancelOrderModal itself: that
// modal is tightly wired to Order-specific concerns this purchase-side
// cancel has none of - the offline-first Local Hub queue path
// (saveOrderCancelOffline/triggerBackgroundSync, since ingredient-purchase
// requests are always online - see ingredientPurchaseController.
// createPurchase's own comment) and printing a "stop preparation" kitchen
// ticket (there's nothing being cooked for a purchase). Forcing those
// through a shared component would mean threading a pile of Order-only
// props into something that isn't cancelling an Order at all.
export default function CancelPurchaseModal({
  purchase,
  onClose,
  onCancelled,
}: {
  purchase: LedgerPurchase;
  onClose: () => void;
  onCancelled: (updated: LedgerPurchase) => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setSubmitting(true);
    setError('');
    try {
      const updated = await cancelIngredientPurchase(purchase.id, { reason: reason.trim() || undefined });
      if (updated) {
        onCancelled(updated as unknown as LedgerPurchase);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel purchase.');
    } finally {
      setSubmitting(false);
    }
  }

  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);

  return (
    <div className="glass-overlay fixed inset-0 z-[150] flex items-center justify-center p-4">
      <div className="glass-strong w-full max-w-md rounded-[28px] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-gray-900">Cancel Purchase {purchase.purchaseOrderNumber}</h2>
            <p className="mt-1 text-xs font-bold text-gray-400">
              This reverses the stock this purchase added ({purchase.quantity}{purchase.unit} {purchase.ingredientName}) and marks it Cancelled - it is never deleted.
            </p>
          </div>
          <button type="button" onClick={onClose} className="glass-pill rounded-full p-2.5 text-gray-500 transition hover:bg-white/70 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="min-h-24 w-full rounded-2xl border border-white/60 bg-white/50 px-4 py-3 shadow-inner outline-none focus:border-black/40"
              autoFocus
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
            <Trash2 size={14} />
            {submitting ? 'Cancelling...' : 'Confirm Cancellation'}
          </button>
        </div>
      </div>
    </div>
  );
}
