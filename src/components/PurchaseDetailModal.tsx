import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';
import { XCircle, AlertCircle } from 'lucide-react';
import { LedgerPurchase } from '@/lib/pos-types';
import { DetailBox, DetailRow } from '@/components/OrderDetailModal';

// "View Purchase" popup - the purchase-side counterpart to
// OrderDetailModal, same glass-card look, shown from DuesPage.tsx's
// History timeline ("View" action on a linked-purchase row) since a
// Khata contact can be bought FROM as well as sold to. LedgerPurchase is
// already the lean summary shape the ledger returns (see pos-types.ts's
// own comment) - enough for a clear read-only detail view without a
// second network fetch.
function statusStyle(status?: LedgerPurchase['status']) {
  switch (status) {
    case 'received':
      return 'bg-gradient-to-b from-emerald-400 to-emerald-600 text-white';
    case 'cancelled':
      return 'bg-gradient-to-b from-rose-400 to-rose-600 text-white';
    default:
      return 'bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950';
  }
}

export default function PurchaseDetailModal({ purchase, onClose }: { purchase: LedgerPurchase; onClose: () => void }) {
  useBackspaceToClose(onClose);
  const purchaseDate = new Date(purchase.purchaseDate).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="glass-overlay fixed inset-0 z-[130] flex items-center justify-center p-4">
      <div className="glass-strong flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col rounded-[32px]">
        <div className="flex shrink-0 items-start justify-between border-b border-white/40 p-6">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-gray-400">Purchase Detail</p>
            <h2 className="mt-1 text-2xl font-black text-gray-900">{purchase.purchaseOrderNumber}</h2>
            <p className="mt-1 text-sm text-gray-500">{purchaseDate}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-2px_5px_rgba(0,0,0,0.15)] ${statusStyle(purchase.status)}`}>
              {purchase.status || 'received'}
            </span>
            <button type="button" onClick={onClose} className="glass-pill rounded-full p-2.5 text-gray-500 transition hover:bg-white/70 hover:text-gray-900">
              <XCircle size={18} />
            </button>
          </div>
        </div>

        <div className="space-y-5 overflow-y-auto p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <DetailBox label="Ingredient" value={purchase.ingredientName} />
            <DetailBox label="Quantity" value={`${purchase.quantity} ${purchase.unit}`} />
            <DetailBox label="Paid" value={`Rs ${purchase.paidAmount ?? 0}`} />
            <DetailBox label="Remaining" value={`Rs ${purchase.remainingAmount ?? 0}`} />
          </div>

          {purchase.status === 'cancelled' ? (
            <div className="space-y-1.5 rounded-[20px] bg-rose-50/60 p-4 text-sm font-bold text-rose-700 shadow-inner">
              <div className="flex items-center gap-2">
                <AlertCircle size={16} />
                <span>This purchase was cancelled.</span>
              </div>
              {purchase.cancelledBy ? <p className="text-xs font-semibold text-rose-500">Cancelled by {purchase.cancelledBy}</p> : null}
              {purchase.cancelReason ? <p className="text-xs font-semibold text-rose-500">Reason: {purchase.cancelReason}</p> : null}
            </div>
          ) : null}

          <div className="rounded-[20px] bg-white/50 p-4 text-sm shadow-inner">
            <DetailRow label="Total Amount" value={`Rs ${purchase.totalAmount}`} strong />
          </div>
        </div>
      </div>
    </div>
  );
}
