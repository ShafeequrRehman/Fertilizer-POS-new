import { useLanguage } from '@/i18n';
import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';
import { AlertCircle, CheckCircle2, Trash2, XCircle } from 'lucide-react';
import { SavedOrder } from '@/lib/pos-types';
import { resolveProductImage } from '@/lib/food-images';

// Shared "View Order" popup - originally lived only inside RecordPage.tsx,
// extracted here so any page (RecordPage's own Record list, DuesPage's
// per-customer History timeline, etc.) can show a customer's order in the
// exact same style rather than re-building a lookalike. The Complete/
// Cancel action row at the bottom is entirely optional (onCompleteRequested
// / onCancelRequested) - a caller that only wants a read-only "View" (e.g.
// DuesPage, which already has its own separate Delete button in the
// History row) simply omits both and the modal renders with no footer.
export function statusLabelKeyForOrder(status: SavedOrder['status']): string {
  return `record.statusTab.${status}`;
}

export function StatusBadge({ status }: { status: SavedOrder['status'] }) {
  const { t } = useLanguage();
  const styles: Record<string, string> = {
    pending: 'bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950',
    completed: 'bg-gradient-to-b from-emerald-400 to-emerald-600 text-white',
    paid: 'bg-gradient-to-b from-sky-400 to-sky-600 text-white',
    cancelled: 'bg-gradient-to-b from-rose-400 to-rose-600 text-white',
  };
  return <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-2px_5px_rgba(0,0,0,0.15)] ${styles[status] || 'bg-gray-100 text-gray-600'}`}>{t(statusLabelKeyForOrder(status))}</span>;
}

export function DetailBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] bg-white/50 px-4 py-3 shadow-inner">
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-bold text-gray-900">{value}</p>
    </div>
  );
}

export function DetailRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${strong ? 'text-base font-black text-gray-900' : 'text-sm text-gray-500'}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function OrderDetailModal({
  order,
  canCancel = false,
  deleting = false,
  onClose,
  onCancelRequested,
  onCompleteRequested,
}: {
  order: SavedOrder;
  canCancel?: boolean;
  deleting?: boolean;
  onClose: () => void;
  onCancelRequested?: () => void;
  onCompleteRequested?: () => void;
}) {
  const { t } = useLanguage();
  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);
  const customerName = order.orderType === 'DineIn' ? (order.table ? t('record.tableLabel', { table: order.table }) : t('record.dineInCustomer')) : order.customer?.name || t('record.walkInCustomer');
  const orderType = order.orderType === 'DineIn' ? t('record.orderType.dineIn') : order.orderType === 'TakeAway' ? t('record.orderType.takeAway') : t('record.orderType.delivery');
  const createdAt = new Date(order.createdAt).toLocaleString('en-PK', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);

  const showFooter = order.status === 'pending' && (onCompleteRequested || (canCancel && onCancelRequested));

  return (
    <div className="glass-overlay fixed inset-0 z-[130] flex items-center justify-center p-4">
      <div className="glass-strong flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col rounded-[32px]">
        <div className="flex shrink-0 items-start justify-between border-b border-white/40 p-6">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-gray-400">{t('record.orderDetail.kicker')}</p>
            <h2 className="mt-1 text-2xl font-black text-gray-900">{t('record.orderHeading', { label: orderLabel })}</h2>
            <p className="mt-1 text-sm text-gray-500">{createdAt}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={order.status} />
            <button type="button" onClick={onClose} className="glass-pill rounded-full p-2.5 text-gray-500 transition hover:bg-white/70 hover:text-gray-900">
              <XCircle size={18} />
            </button>
          </div>
        </div>

        <div className="space-y-5 overflow-y-auto p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <DetailBox label={t('record.tableHeaders.customer')} value={customerName} />
            <DetailBox label={order.orderType === 'DineIn' ? t('record.orderDetail.waiter') : t('common.phone')} value={order.orderType === 'DineIn' ? (order.waiter || t('record.orderType.dineIn')) : (order.customer?.phone || t('record.orderDetail.noPhone'))} />
            {order.orderType === 'DineIn' ? <DetailBox label={t('record.tableHeaders.table')} value={order.table || '—'} /> : null}
            <DetailBox label={t('record.orderDetail.orderTypeLabel')} value={orderType} />
            <DetailBox label={t('record.orderDetail.paymentMethod')} value={order.paymentMethod} />
            <DetailBox label={t('record.paid')} value={`Rs ${order.paidAmount ?? 0}`} />
            <DetailBox label={t('record.remaining')} value={`Rs ${order.remainingAmount ?? 0}`} />
          </div>

          {order.status === 'cancelled' ? (
            <div className="space-y-1.5 rounded-[20px] bg-rose-50/60 p-4 text-sm font-bold text-rose-700 shadow-inner">
              <div className="flex items-center gap-2">
                <AlertCircle size={16} />
                <span>{t('record.orderDetail.cancelledNotice')}</span>
              </div>
              {order.cancelledBy ? <p className="text-xs font-semibold text-rose-500">{t('record.orderDetail.cancelledByLabel', { name: order.cancelledBy })}{order.cancelledAt ? ` · ${new Date(order.cancelledAt).toLocaleString('en-PK', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}` : ''}</p> : null}
              {order.cancelReason ? <p className="text-xs font-semibold text-rose-500">{t('record.orderDetail.cancelReasonLabel', { reason: order.cancelReason })}</p> : null}
            </div>
          ) : null}

          <div>
            <h3 className="mb-3 text-sm font-black uppercase tracking-[0.18em] text-gray-400">{t('record.orderDetail.itemsHeading')}</h3>
            <div className="space-y-2">
              {order.items.map((item, index) => (
                <div key={`${item.name}-${index}`} className="flex items-center gap-3 rounded-[18px] bg-white/45 px-4 py-3 shadow-inner">
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded-[12px] bg-slate-100 shadow-inner">
                    <img src={resolveProductImage({ image: item.image, name: item.name })} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                  </div>
                  <div className="min-w-0 flex-1"><p className="truncate font-bold text-gray-900">{item.name}</p><p className="text-xs text-gray-400">{item.variation}</p></div>
                  <div className="shrink-0 text-right rtl:text-left">
                    <p className="text-sm font-black text-gray-900">Rs {item.price * item.quantity}</p>
                    <p className="text-xs text-gray-400">{t('record.orderDetail.qtyLabel', { qty: item.quantity })}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[20px] bg-white/50 p-4 text-sm shadow-inner">
            <DetailRow label={t('record.orderDetail.subtotal')} value={`Rs ${order.subtotal}`} />
            <DetailRow label={t('record.orderDetail.tax')} value={`Rs ${order.tax}`} />
            {order.discount && order.discount.amount > 0 ? (
              <DetailRow label={order.discount.type === 'percent' ? t('record.discount.percentLabel', { value: order.discount.value }) : t('record.discount.label')} value={`-Rs ${order.discount.amount}`} />
            ) : null}
            <DetailRow label={t('common.total')} value={`Rs ${order.total}`} strong />
          </div>

          {order.note ? <DetailBox label={t('record.orderDetail.note')} value={order.note} /> : null}
          {/* Electricity Bill / Cash special-product details - only ever
              set on an order whose cart had the matching special item in
              it (see POSPage.tsx's hasElectricityBillItem/hasCashItem). */}
          {order.billTid ? <DetailBox label={t('record.orderDetail.billTid')} value={order.billTid} /> : null}
          {order.billName ? <DetailBox label={t('record.orderDetail.billName')} value={order.billName} /> : null}
          {order.cashRecipientName ? <DetailBox label={t('record.orderDetail.cashRecipientName')} value={order.cashRecipientName} /> : null}
        </div>

        {showFooter ? (
          <div className="flex shrink-0 gap-2 border-t border-white/40 p-6">
            {onCompleteRequested ? (
              <button
                type="button"
                onClick={onCompleteRequested}
                className="flex flex-1 items-center justify-center gap-2 rounded-[20px] border-[0.5px] border-white/30 bg-gradient-to-b from-emerald-500 to-emerald-700 px-5 py-3.5 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-4px_10px_rgba(6,78,59,0.45)] transition hover:brightness-105"
              >
                <CheckCircle2 size={16} /> {t('record.actions.completeOrder')}
              </button>
            ) : null}
            {canCancel && onCancelRequested ? (
              <button
                type="button"
                onClick={onCancelRequested}
                disabled={deleting}
                className="flex flex-1 items-center justify-center gap-2 rounded-[20px] border-[0.5px] border-white/40 bg-gradient-to-b from-rose-500 to-rose-700 px-5 py-3.5 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-4px_10px_rgba(136,19,55,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={16} /> {t('record.actions.cancelOrder')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
