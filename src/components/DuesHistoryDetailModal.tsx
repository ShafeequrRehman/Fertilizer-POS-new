import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';
import { XCircle } from 'lucide-react';
import { DuesHistoryEntry } from '@/lib/pos-types';
import { DetailBox, DetailRow } from '@/components/OrderDetailModal';

// "View" popup for one manual "+ Add Dues"/"- Pay Dues" row from
// DuesPage.tsx's History timeline - the one entry type that isn't an
// Order or a Purchase, just a note the cashier typed. Same glass-card
// look as OrderDetailModal/PurchaseDetailModal for a consistent "view
// this history entry" experience across every row type.
export default function DuesHistoryDetailModal({
  customerName,
  entry,
  onClose,
}: {
  customerName: string;
  entry: DuesHistoryEntry;
  onClose: () => void;
}) {
  useBackspaceToClose(onClose);
  const date = new Date(entry.createdAt).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="glass-overlay fixed inset-0 z-[130] flex items-center justify-center p-4">
      <div className="glass-strong flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col rounded-[32px]">
        <div className="flex shrink-0 items-start justify-between border-b border-white/40 p-6">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-gray-400">Dues Entry</p>
            <h2 className="mt-1 text-2xl font-black text-gray-900">{customerName}</h2>
            <p className="mt-1 text-sm text-gray-500">{date}</p>
          </div>
          <button type="button" onClick={onClose} className="glass-pill rounded-full p-2.5 text-gray-500 transition hover:bg-white/70 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>

        <div className="space-y-5 p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <DetailBox label="Type" value={entry.type === 'add' ? 'Dues Added' : 'Dues Paid'} />
            <DetailBox label="Amount" value={`Rs ${entry.amount}`} />
            <DetailBox label="Balance After" value={`Rs ${entry.balanceAfter}`} />
            <DetailBox label="By" value={entry.createdBy || '—'} />
          </div>
          <div className="rounded-[20px] bg-white/50 p-4 text-sm shadow-inner">
            <DetailRow label="Note" value={entry.note || 'No note'} />
          </div>
        </div>
      </div>
    </div>
  );
}
