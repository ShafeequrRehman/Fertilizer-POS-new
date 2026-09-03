import { useEffect, useState } from 'react';
import { Moon, XCircle, Printer, MessageCircle, Lock } from 'lucide-react';
import { fetchDayEndReport, fetchShopProfile, sendWhatsappDocument } from '@/lib/pos-api';
import type { DayEndReport, ShopSession } from '@/lib/pos-types';
import { useToast } from '@/lib/toast';
import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';
import { ReportPdfDocument, downloadPdfDocument, pdfDocumentToBase64, type PdfStat, type PdfTable } from '@/lib/pdf-export';

function formatMoney(amount: number) {
  return `Rs ${Math.round(amount).toLocaleString()}`;
}

// Day-End Shop Closing Summary Sheet - opened by ShopStatusControl's
// "Close Restaurant" button (DashboardShell.tsx) BEFORE the shop is
// actually closed, so whoever's closing out the shift can review the
// day's real numbers - Total Revenue, Expenses Breakdown split into
// Kitchen Stock vs Manual Operations, Net Profit, Total Orders (Dine-In/
// Takeaway/Delivery split), and Outstanding Dues - and optionally print or
// WhatsApp it, before confirming the close.
//
// Reuses reportController.getDayEndReport (the same endpoint the Reports
// page's Day-End Profit report already calls) rather than a bespoke
// endpoint - scoped to THIS session's own [openedAt, now) window instead
// of a picked date range, via full ISO timestamps (see reportController.
// resolveRange's own comment on why it now accepts those alongside its
// original plain YYYY-MM-DD shape).
export default function ShopClosingSummaryModal({
  session,
  onClose,
  onConfirmClose,
  closing,
}: {
  session: ShopSession | null;
  onClose: () => void;
  /** Runs the actual close-shop flow (ShopStatusControl's own handleClose) - this modal just triggers it and then gets out of the way. */
  onConfirmClose: () => Promise<void>;
  /** True while the parent's close-shop request is in flight - disables this modal's own confirm button so it can't be double-clicked. */
  closing: boolean;
}) {
  useBackspaceToClose(onClose);
  const { toast } = useToast();
  const [report, setReport] = useState<DayEndReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [sendingWhatsapp, setSendingWhatsapp] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const startIso = session?.openedAt || new Date().toISOString();
        const endIso = new Date().toISOString();
        const [reportData, profile] = await Promise.all([
          fetchDayEndReport(startIso, endIso),
          fetchShopProfile(),
        ]);
        if (cancelled) return;
        if (reportData) setReport(reportData);
        setPhone(profile?.phone || '');
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : "Couldn't load the closing summary.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildPdfStats(): PdfStat[] {
    if (!report) return [];
    return [
      { label: 'Total Revenue', value: formatMoney(report.revenue) },
      { label: 'Net Profit', value: formatMoney(report.netProfit) },
      { label: 'Total Orders', value: String(report.orderCount) },
      { label: 'Outstanding Due', value: formatMoney(report.totalDue) },
    ];
  }

  function buildExpenseTable(): PdfTable {
    const rows: Array<Array<string | number>> = [
      ['Kitchen Stock (ingredient purchases)', formatMoney(report?.kitchenStockPurchases || 0)],
      ['Manual Operations (other expenses)', formatMoney(report?.otherExpenses || 0)],
    ];
    return {
      title: 'Expenses Breakdown',
      columns: [{ label: 'Category', width: 2 }, { label: 'Amount', width: 1, align: 'right' }],
      rows,
      footer: ['Net Profit (Revenue - Kitchen Stock is excluded, already counted via COGS)', formatMoney(report?.netProfit || 0)],
    };
  }

  function buildOrderTypeTable(): PdfTable {
    const breakdown = report?.orderTypeBreakdown || { DineIn: 0, TakeAway: 0, Delivery: 0 };
    return {
      title: 'Orders by Type',
      columns: [{ label: 'Order Type', width: 2 }, { label: 'Count', width: 1, align: 'right' }],
      rows: [
        ['Dine-In', breakdown.DineIn],
        ['Takeaway', breakdown.TakeAway],
        ['Delivery', breakdown.Delivery],
      ],
      footer: ['Total Orders', report?.orderCount || 0],
    };
  }

  function buildClosingPdfDoc() {
    const openedLabel = session?.openedAt ? new Date(session.openedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '--';
    return (
      <ReportPdfDocument
        title="Day-End Shop Closing Summary (Z-Report)"
        subtitle={`Shift opened ${openedLabel}${session?.openedByName ? ` by ${session.openedByName}` : ''}`}
        stats={buildPdfStats()}
        tables={[buildExpenseTable(), buildOrderTypeTable()]}
      />
    );
  }

  function downloadClosingPdf() {
    void downloadPdfDocument(buildClosingPdfDoc(), 'day_end_shop_closing_summary.pdf');
  }

  async function sendClosingWhatsapp() {
    if (!phone.trim()) {
      toast.error('Enter the owner\'s WhatsApp number first.');
      return;
    }
    try {
      setSendingWhatsapp(true);
      const base64 = await pdfDocumentToBase64(buildClosingPdfDoc());
      await sendWhatsappDocument(phone, base64, 'day_end_shop_closing_summary.pdf');
      toast.success('Closing summary sent to owner on WhatsApp.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send WhatsApp message. Make sure WhatsApp is connected in Settings.");
    } finally {
      setSendingWhatsapp(false);
    }
  }

  async function handleConfirmClose() {
    setConfirming(true);
    try {
      await onConfirmClose();
    } finally {
      setConfirming(false);
      onClose();
    }
  }

  const breakdown = report?.orderTypeBreakdown || { DineIn: 0, TakeAway: 0, Delivery: 0 };

  return (
    <div className="glass-overlay fixed inset-0 z-[300] flex items-center justify-center p-4 sm:p-6">
      <div className="glass-strong flex w-full max-w-2xl max-h-[calc(100vh-2rem)] flex-col rounded-[32px] transition-all sm:max-h-[calc(100vh-4rem)]">
        <div className="flex shrink-0 items-center justify-between border-b border-white/40 p-6 sm:px-8 sm:py-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]">
              <Moon size={20} />
            </div>
            <div>
              <h2 className="text-xl font-black text-gray-900">Daily Day Closing &amp; Z-Report</h2>
              <p className="text-xs font-bold text-amber-600">End of Day Financial Reconciliation</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="glass-pill rounded-full p-3 text-gray-500 transition hover:bg-white/70">
            <XCircle size={18} />
          </button>
        </div>

        <div className="overflow-y-auto p-6 sm:p-8">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm font-bold text-gray-400">Loading today's numbers...</div>
          ) : !report ? (
            <div className="flex items-center justify-center py-16 text-sm font-bold text-rose-500">Couldn't load the closing summary.</div>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <SummaryStat label="Total Revenue" value={formatMoney(report.revenue)} accent="text-emerald-600" />
                <SummaryStat label="Net Profit" value={formatMoney(report.netProfit)} accent={report.netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'} />
                <SummaryStat label="Total Orders" value={String(report.orderCount)} accent="text-indigo-600" />
                <SummaryStat label="Outstanding Due" value={formatMoney(report.totalDue)} accent="text-amber-600" />
              </div>

              <div className="rounded-2xl bg-white/60 p-4">
                <h3 className="mb-3 text-xs font-black uppercase tracking-wide text-gray-500">Expenses Breakdown</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-gray-600">Kitchen Stock (ingredient purchases)</span>
                    <span className="font-black text-gray-900">{formatMoney(report.kitchenStockPurchases)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-gray-600">Manual Operations (other expenses)</span>
                    <span className="font-black text-gray-900">{formatMoney(report.otherExpenses)}</span>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl bg-white/60 p-4">
                <h3 className="mb-3 text-xs font-black uppercase tracking-wide text-gray-500">Orders by Type</h3>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <div className="text-lg font-black text-gray-900">{breakdown.DineIn}</div>
                    <div className="text-[11px] font-bold uppercase text-gray-400">Dine-In</div>
                  </div>
                  <div>
                    <div className="text-lg font-black text-gray-900">{breakdown.TakeAway}</div>
                    <div className="text-[11px] font-bold uppercase text-gray-400">Takeaway</div>
                  </div>
                  <div>
                    <div className="text-lg font-black text-gray-900">{breakdown.Delivery}</div>
                    <div className="text-[11px] font-bold uppercase text-gray-400">Delivery</div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl bg-white/60 p-4">
                <h3 className="mb-3 text-xs font-black uppercase tracking-wide text-gray-500">Send To Owner</h3>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Owner's WhatsApp number"
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-semibold text-gray-800 outline-none focus:border-indigo-400"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={downloadClosingPdf}
                  className="flex items-center justify-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-slate-700 to-slate-900 px-4 py-3 text-sm font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition hover:brightness-110"
                >
                  <Printer size={16} /> Print Receipt
                </button>
                <button
                  type="button"
                  onClick={() => void sendClosingWhatsapp()}
                  disabled={sendingWhatsapp}
                  className="flex items-center justify-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-emerald-500 to-emerald-700 px-4 py-3 text-sm font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <MessageCircle size={16} /> {sendingWhatsapp ? 'Sending...' : 'Send WhatsApp'}
                </button>
              </div>

              <button
                type="button"
                onClick={() => void handleConfirmClose()}
                disabled={confirming || closing}
                className="flex w-full items-center justify-center gap-2 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-rose-500 to-rose-700 px-4 py-3.5 text-sm font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-3px_8px_rgba(136,19,55,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Lock size={16} /> {confirming || closing ? 'Closing...' : 'Confirm & Close Restaurant'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-2xl bg-white/60 p-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`mt-1 text-base font-black ${accent}`}>{value}</div>
    </div>
  );
}
