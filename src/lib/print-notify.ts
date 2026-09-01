// Shared "did this print actually go out?" reporter - every print call
// site in the app (POSPage, SalesPage, EditOrderPage, CancelOrderModal,
// DashboardShell's background watchers, PrintOrderPage, and the hidden
// iframe fallback in ReceiptPrintPage) routes its result through this one
// function instead of each rolling its own ad-hoc `.catch(console.error)`.
//
// main.js's print IPC handlers (print-kitchen-receipt-data,
// print-cashier-receipt-data, print-order-token-data,
// print-kitchen-cancel-receipt-data, print-kitchen-remove-receipt-data)
// never reject their promises - they always resolve `{success, error}` -
// so checking `outcome.success` here is what tells a genuine failure
// (wrong/offline printer, PDF render error, etc.) apart from a real
// success, instead of every print looking identical whether it worked or
// not.
//
// The popup itself is just the existing toast system (see toast.tsx) -
// toast.success already renders a green CheckCircle2 icon, toast.error a
// red XCircle - this function's only job is deciding which one to show and
// with what label.
export interface PrintOutcome {
  success?: boolean;
  error?: string;
}

export interface ToastLike {
  success: (message: string) => void;
  error: (message: string) => void;
}

export function reportPrintOutcome(promise: Promise<unknown>, label: string, toast: ToastLike): void {
  promise
    .then((result) => {
      const outcome = result as PrintOutcome | undefined;
      if (!outcome || outcome.success !== false) {
        toast.success(`${label} sent to printer.`);
      } else {
        console.error(`${label} print failed:`, outcome.error);
        toast.error(`${label} did not print: ${outcome.error || 'unknown error'}.`);
      }
    })
    .catch((err) => {
      console.error(`${label} print IPC call failed:`, err);
      toast.error(`${label} did not print - the print request itself failed.`);
    });
}

// --- Cross-frame case: PrintOrderPage.tsx (Manual Print Center) doubles as
// the fallback print path (see POSPage.tsx/SalesPage.tsx's `printReadyUrl`)
// - loaded inside a hidden `<iframe>` so it can call window.print()
// without ever being shown on screen. That iframe navigation boots a
// completely separate React tree (its own ToastProvider instance,
// rendered inside the hidden iframe's own DOM) - a toast shown from
// inside it would be real but invisible to the cashier. These two
// functions bridge that gap: the iframe side posts a message up to
// whichever page embedded it, and that page (already visible, with its
// own real toast context) is what actually shows the popup.
export const PRINT_SENT_MESSAGE_TYPE = 'pos-print-sent';

export function notifyParentPrintSent(label: string): void {
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      window.parent.postMessage({ type: PRINT_SENT_MESSAGE_TYPE, label }, '*');
    }
  } catch {
    // Cross-origin/parent-gone edge cases - not worth failing over, the
    // print itself (window.print()) already happened either way.
  }
}

// Call from a useEffect (returns the cleanup) in any page that renders a
// hidden auto-print iframe, e.g. `useEffect(() => listenForPrintSentMessages(toast), []);`
export function listenForPrintSentMessages(toast: ToastLike): () => void {
  function handleMessage(event: MessageEvent) {
    const data = event.data as { type?: string; label?: string } | undefined;
    if (data?.type === PRINT_SENT_MESSAGE_TYPE && data.label) {
      toast.success(`${data.label} sent to printer.`);
    }
  }
  window.addEventListener('message', handleMessage);
  return () => window.removeEventListener('message', handleMessage);
}
