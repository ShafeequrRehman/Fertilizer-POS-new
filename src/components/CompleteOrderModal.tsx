// CompleteOrderModal.tsx - the shared "collect payment / mark an order
// completed" popup. Originally lived only inside RecordPage.tsx as a local
// function component; extracted here so POSPage.tsx can show the exact
// same popup immediately after Save, instead of the cashier only ever
// being able to reach it later from Record (or having to go through the
// separate Sales page) - see the user request this was built for.
//
// The whole point this action exists for: a pending order - however old,
// from whatever previous shift - is exactly what's keeping one of
// POSPage's DineIn tables marked occupied. Settling it here (mirroring
// SalesPage.tsx's own Complete Payment flow: same completeAndSettle
// action, same saveOrderEditOffline split offline) is what frees that
// table back up - and, used from POSPage right after Save, is what lets an
// order collect its payment immediately instead of sitting pending.
import { useEffect, useState } from 'react';
import { WifiOff, XCircle } from 'lucide-react';
import { useLanguage } from '@/i18n';
import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';
import { fetchCustomerOutstanding, updateOrder } from '@/lib/pos-api';
import { SavedOrder } from '@/lib/pos-types';
import { isDesktopApp } from '@/lib/api';
import { saveOrderEditOffline } from '@/lib/offline-order-helpers';
import { triggerBackgroundSync } from '@/lib/offline-sync';
import { ToastLike } from '@/lib/print-notify';

export default function CompleteOrderModal({
  order,
  isOnline,
  toast,
  onClose,
  onCompleted,
  setPrintReadyUrl,
}: {
  order: SavedOrder;
  isOnline: boolean;
  toast: ToastLike;
  onClose: () => void;
  onCompleted: (updated: SavedOrder) => void;
  setPrintReadyUrl: (url: string | null) => void;
}) {
  const { t } = useLanguage();
  // Single field, doubling as the change calculator - the cashier types the
  // REAL cash the customer handed over here (can be more than Payable Now).
  // Nothing is clamped as they type any more, so this can genuinely hold
  // "5000" against a 4600 bill. What actually gets recorded as paid is
  // capped at Payable Now down in settle() below - this field itself never
  // gets rewritten, so the cashier's own typed number stays on screen.
  const [paymentAmount, setPaymentAmount] = useState('');
  const [customerDue, setCustomerDue] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Same reasoning as SalesPage.tsx's Complete Payment panel - required
  // before "Confirm Payment" is allowed through with nothing typed, so an
  // accidental click can't silently leave the whole order unpaid.
  const [confirmPending, setConfirmPending] = useState(false);

  // trulyOffline only gates the live "what else does this customer owe"
  // lookup below (a cloud-only read, and only ever useful when it can be
  // trusted right now) - completing the order itself is always local-first
  // (see localFirst / settle() below), independent of actual connectivity.
  const trulyOffline = isDesktopApp() && !isOnline;
  const localFirst = isDesktopApp();

  useEffect(() => {
    async function loadDue() {
      // Same "true outstanding balance" reasoning as SalesPage's own
      // Complete Payment panel - a customer can have more than one order
      // open at once, so this rolls every OTHER unpaid order of theirs in
      // too, not just this one. Cloud-only lookup, so skipped while
      // offline - completing this order still works fine without it, it
      // just won't also collect other unrelated dues in the same payment.
      if (trulyOffline || !order.customer?.phone || order.customer.phone === '03000000000') {
        setCustomerDue(0);
        return;
      }
      try {
        const result = await fetchCustomerOutstanding(order.customer.phone, order.id);
        setCustomerDue(Number(result?.outstanding ?? 0));
      } catch {
        setCustomerDue(0);
      }
    }
    void loadDue();
  }, [order, trulyOffline]);

  const owed = Number(order.remainingAmount ?? order.total ?? 0);
  const payable = owed + customerDue;
  // How much change to hand back - shown live under the input, from the raw
  // typed amount (not the capped one below).
  const changeDue = paymentAmount && Number(paymentAmount) > payable ? Number(paymentAmount) - payable : 0;

  async function settle(full: boolean) {
    // Cap at Payable Now - the cashier may have typed the full cash-in-hand
    // amount (e.g. 5000 against a 4600 bill) to see the change due, but the
    // amount actually recorded against the order/account is never more
    // than what was really owed.
    const paid = full ? payable : Math.min(Number(paymentAmount || 0), payable);
    if (!full && paid < 0) {
      setError(t('record.errors.invalidAmount'));
      return;
    }
    // Same reasoning as SalesPage.tsx's completeOrder - nothing typed in
    // Amount Paid is only allowed through with "Put in Pending" explicitly
    // ticked, so a stray Confirm Payment click can't silently complete the
    // order with paid=0. Typing any real amount never needs the tick.
    if (!full && paid === 0 && !confirmPending) {
      setError(t('record.errors.noAmountNoPending'));
      return;
    }
    // Same reasoning as SalesPage.tsx's completeOrder - a due left on the
    // walk-in placeholder phone (03000000000) can never be found again by
    // Customer Dues/Ledger (both look orders up by customer.phone and
    // explicitly skip that placeholder), so it's a permanently untrackable
    // debt the moment this modal closes. Require a real name + phone
    // before allowing anything less than full payment; a full payment
    // never leaves a due, so that's still unrestricted.
    if (paid < payable && (!order.customer?.phone || order.customer.phone === '03000000000' || !order.customer?.name?.trim())) {
      setError(t('record.errors.needCustomerInfo'));
      return;
    }
    setSaving(true);
    setError('');

    const payload: Parameters<typeof updateOrder>[1] = { status: 'completed', action: 'completeAndSettle', paidAmount: paid };

    try {
      if (localFirst) {
        // Always local-first, online or not - queues to the Local Hub and
        // returns instantly instead of waiting on a live cloud round trip
        // (see SalesPage.tsx's saveUpdate for the same pattern). `false` as
        // receiptPrinted below keeps customerReceiptPrintedAt unset so the
        // printer icon still works as an on-demand reprint even after the
        // auto-print just below.
        const updated = await saveOrderEditOffline(order, payload, false, false);
        triggerBackgroundSync();
        // No auto-print here any more, for any order type - see
        // SalesPage.tsx's completeOrder for the full reasoning. Printing a
        // customer receipt is now always a deliberate, on-demand action via
        // the printer icon/button.
        toast.success(trulyOffline ? t('record.toast.orderCompletedOffline') : t('record.toast.orderCompletedSyncing'));
        onCompleted(updated);
        return;
      }

      // Only ever reached from a plain browser tab now (no Local Hub to
      // queue into).
      const updated = await updateOrder(order.id, payload);
      toast.success(t('record.toast.orderCompleted'));
      onCompleted(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('record.errors.completeFailed'));
    } finally {
      setSaving(false);
    }
  }

  const orderLabel = order.dailyOrderNumber ?? order.id.slice(-4);
  const heading = order.orderType === 'DineIn' && order.table ? t('record.tableLabel', { table: order.table }) : t('record.orderHeading', { label: orderLabel });

  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-[32px] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-gray-400">{t('record.actions.completeOrder')}</p>
            <h2 className="mt-1 text-xl font-black text-gray-900">{heading}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>

        {trulyOffline ? (
          <div className="mt-3 flex items-center gap-2 rounded-[14px] bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
            <WifiOff size={14} className="shrink-0" /> {t('record.completeOrder.offlineNotice')}
          </div>
        ) : null}

        <div className="mt-4 rounded-[20px] bg-[#F8F9FB] p-4 text-sm">
          <DetailRow label={t('record.completeOrder.orderTotal')} value={`Rs ${order.total}`} />
          <DetailRow label={t('record.completeOrder.alreadyPaid')} value={`Rs ${order.paidAmount ?? 0}`} />
          {customerDue > 0 ? <DetailRow label={t('record.completeOrder.otherOutstandingDues')} value={`Rs ${customerDue}`} /> : null}
          <DetailRow label={t('record.completeOrder.payableNow')} value={`Rs ${payable}`} strong />
        </div>

        {/* One field: the cashier types the actual cash handed over (can be
            more than Payable Now - e.g. 5000 against a 4600 bill). The
            Return line below shows the change to hand back, but only
            Payable Now ever gets recorded as paid (capped in settle()
            above) - the account never records more than what was owed. */}
        <div className="mt-4">
          <label className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">{t('record.completeOrder.partialPaymentAmount')}</label>
          <input
            value={paymentAmount}
            onChange={(event) => {
              if (!/^\d*$/.test(event.target.value)) return;
              setPaymentAmount(event.target.value);
              if (event.target.value) setConfirmPending(false);
            }}
            placeholder={t('record.completeOrder.upToAmount', { amount: payable })}
            className="mt-1 w-full rounded-[16px] border border-gray-200 px-4 py-3 text-sm font-bold outline-none focus:border-gray-400"
          />
          {changeDue > 0 ? (
            <p className="mt-2 rounded-[14px] bg-emerald-50 px-4 py-2 text-sm font-black text-emerald-700">
              {t('record.completeOrder.returnAmount', { amount: changeDue })}
            </p>
          ) : null}
        </div>

        {!paymentAmount ? (
          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-[16px] bg-amber-50 px-4 py-3 text-xs font-bold text-amber-800">
            <input
              type="checkbox"
              checked={confirmPending}
              onChange={(event) => setConfirmPending(event.target.checked)}
              className="mt-0.5"
            />
            {t('record.completeOrder.putInPending', { amount: payable })}
          </label>
        ) : null}

        {error ? <p className="mt-2 text-xs font-bold text-rose-600">{error}</p> : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => void settle(false)}
            className="rounded-[20px] bg-black px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('record.actions.confirmPayment')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void settle(true)}
            className="rounded-[20px] bg-[#E2F33C] px-4 py-3 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('record.actions.payFull')}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${strong ? 'text-base font-black text-gray-900' : 'text-sm text-gray-500'}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
