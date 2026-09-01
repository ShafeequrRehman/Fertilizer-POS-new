import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import { fetchOrder, fetchCustomerOutstanding } from '@/lib/pos-api';
import { SavedOrder } from '@/lib/pos-types';
import ReceiptRenderer from '@/pages/dashboard/components/ReceiptRenderer';
import { PRINT_LOGO_STORAGE_KEY } from '@/lib/print-logo';
import { isDesktopApp } from '@/lib/api';
import { loadOrdersFromLocalHub } from '@/lib/offline-order-helpers';
import { notifyParentPrintSent } from '@/lib/print-notify';
import { useToast } from '@/lib/toast';
import { computeDiscountFromInputs, loadDiscountDraft } from '@/lib/discount-draft';

type ElectronWindow = Window & typeof globalThis & {
  require?: (moduleName: 'electron') => {
    ipcRenderer: {
      send: (channel: string, payload?: unknown) => void;
    };
  };
};

async function waitForReceiptLayout() {
  const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));

  // Not tied to any one template's specific wording (e.g. "DATE:"/"Items:")
  // any more - different shops can pick different receipt layouts (see
  // ReceiptRenderer.tsx), so this just waits for the print area to actually
  // have real content in it rather than checking for text that might not
  // exist in every template.
  const waitForElement = async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      const element = document.getElementById('receipt-print-area');
      const text = element?.textContent ?? '';
      if (element && text.trim().length > 20) return element;
      await wait(100);
    }
    return document.getElementById('receipt-print-area');
  };

  const receiptElement = await waitForElement();
  await document.fonts?.ready.catch(() => undefined);

  const images = Array.from(document.querySelectorAll('img'));
  await Promise.all(images.map((img) => {
    if (img.complete && img.naturalWidth !== 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
  }));

  await nextFrame();
  await nextFrame();
  await wait(250);

  const rect = receiptElement?.getBoundingClientRect();
  return {
    height: Math.ceil(receiptElement?.scrollHeight || rect?.height || document.body.scrollHeight || 0),
    width: Math.ceil(rect?.width || receiptElement?.scrollWidth || document.body.scrollWidth || 0),
  };
}

export default function PrintOrderPage() {
  const { toast } = useToast();
  const params = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const autoPrint = searchParams.get('auto') === 'true';
  const defaultType = searchParams.get('type') === 'kitchen' ? 'kitchen' : 'cashier';

  const [order, setOrder] = useState<SavedOrder | null>(null);
  // When SalesPage.tsx falls back to this manual-print page for a kitchen
  // ticket right after "Add Items" (no Electron/kitchen printer available),
  // it stashes ONLY the newly-added items here under this order's id so
  // this page doesn't reprint the whole merged order (which would send
  // already-cooking items back to the kitchen again). Consumed once below.
  const [kitchenOnlyItems, setKitchenOnlyItems] = useState<SavedOrder['items'] | null>(null);
  // Dues carried forward from the customer's OTHER unpaid orders - fetched
  // separately since it's not part of the order document itself, so a
  // manual/re-print here shows the same "Previous Dues" figure the cashier
  // saw when the bill was completed.
  const [previousDues, setPreviousDues] = useState(0);
  const [receiptType, setReceiptType] = useState<'kitchen' | 'cashier'>(defaultType);
  const [kitchenPrinter, setKitchenPrinter] = useState(() => typeof window === 'undefined' ? '' : (window.localStorage.getItem('preferred-kitchen-printer') ?? ''));
  const [cashierPrinter, setCashierPrinter] = useState(() => typeof window === 'undefined' ? '' : (window.localStorage.getItem('preferred-cashier-printer') ?? ''));
  const [logoSrc, setLogoSrc] = useState<string | null>(() => typeof window === 'undefined' ? null : window.localStorage.getItem(PRINT_LOGO_STORAGE_KEY));

  const isSilent = searchParams.get('silent') === 'true';

  // Previously this only ever did a live fetchOrder() call, with no
  // .catch() - offline (or with a plain network hiccup), that request just
  // hangs/rejects and `order` stays null forever, leaving this page stuck
  // on "Loading receipt..." indefinitely. It also could never have worked
  // for a still-unsynced offline order at all: an id like "local-<uuid>"
  // (see offline-order-helpers.ts's localOrderToSavedOrder) has no cloud
  // record for GET /orders/:id to find, online or off.
  //
  // Cache-first fixes both: the Local Hub's merged cache/pending-queue
  // (same source SalesPage.tsx itself reads from) resolves a "local-"
  // id correctly and works with zero connectivity, painting the receipt
  // immediately; the live fetch then still runs for a real cloud id (skipped
  // entirely for a "local-" one, since there's nothing there yet) to pick up
  // anything the cache might be missing, but never blocks the page if it
  // fails.
  useEffect(() => {
    if (!params.id) return undefined;
    let cancelled = false;

    async function load() {
      const id = params.id as string;

      if (isDesktopApp()) {
        try {
          const merged = await loadOrdersFromLocalHub();
          const localMatch = merged.find((candidate) => candidate.id === id);
          if (localMatch && !cancelled) setOrder(localMatch);
        } catch {
          // Local Hub unreachable - not fatal, the live fetch below still
          // has a chance (or, offline with no Local Hub either, there's
          // simply nothing to show, same as before this fix).
        }
      }

      if (id.startsWith('local-')) return; // no cloud record exists yet - the cache above is the only source.

      try {
        const fetched = await fetchOrder(id);
        if (fetched && !cancelled) setOrder(fetched);
      } catch {
        // Offline/unreachable - the cache-first paint above already has us
        // covered if it found a match; otherwise this page correctly has
        // nothing to show rather than hanging forever.
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  useEffect(() => {
    if (!order || defaultType !== 'kitchen') return;
    const key = `kitchen-add-items-${order.id}`;
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return;
    window.sessionStorage.removeItem(key);
    try {
      setKitchenOnlyItems(JSON.parse(raw));
    } catch {
      setKitchenOnlyItems(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, defaultType]);

  useEffect(() => {
    const phone = order?.customer.phone;
    if (!phone || phone === '03000000000') return setPreviousDues(0);
    void fetchCustomerOutstanding(phone, order?.id).then((result) => {
      setPreviousDues(Number(result?.outstanding ?? 0));
    }).catch(() => setPreviousDues(0));
  }, [order?.customer.phone, order?.id]);

  useEffect(() => {
    if (!order) return;

    const handlePrintReady = async () => {
      const measurement = await waitForReceiptLayout();
      if (isSilent && typeof window !== 'undefined' && navigator.userAgent.includes('Electron')) {
        try {
          const electronRequire = (window as ElectronWindow).require;
          const { ipcRenderer } = electronRequire ? electronRequire('electron') : { ipcRenderer: null };
          if (!ipcRenderer) throw new Error('Electron IPC is unavailable.');
          ipcRenderer.send('receipt-ready-to-print', {
            height: measurement.height,
            orderId: order.id,
            type: receiptType,
            url: window.location.href,
            width: measurement.width,
          });
          return;
        } catch (e) {
          console.error('Failed to send IPC ready signal', e);
        }
      }

      if (autoPrint) {
        window.print();
        // window.print() has no reliable "it actually went out" signal
        // (unlike the direct IPC print handlers - see print-notify.ts),
        // so this is optimistic: the OS print dialog/spooler was handed
        // the job, same "sent to printer" meaning used everywhere else.
        //
        // This page doubles as the hidden-iframe fallback target (see
        // POSPage.tsx/SalesPage.tsx's printReadyUrl) - in that case it's
        // rendered inside a completely separate, invisible React tree, so
        // a toast shown from here would never actually be seen. Post a
        // message up to whichever page embedded it instead; if this page
        // is genuinely being viewed on its own (not inside that iframe),
        // just show the toast directly.
        const label = receiptType === 'kitchen' ? 'Kitchen ticket' : 'Customer receipt';
        if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
          notifyParentPrintSent(label);
        } else {
          toast.success(`${label} sent to printer.`);
        }
      }
    };

    void handlePrintReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, autoPrint, isSilent, receiptType]);

  useEffect(() => {
    window.localStorage.setItem('preferred-kitchen-printer', kitchenPrinter);
  }, [kitchenPrinter]);

  useEffect(() => {
    window.localStorage.setItem('preferred-cashier-printer', cashierPrinter);
  }, [cashierPrinter]);

  useEffect(() => {
    const syncLogo = () => {
      setLogoSrc(window.localStorage.getItem(PRINT_LOGO_STORAGE_KEY));
    };

    window.addEventListener('storage', syncLogo);
    window.addEventListener('print-logo-updated', syncLogo as EventListener);

    return () => {
      window.removeEventListener('storage', syncLogo);
      window.removeEventListener('print-logo-updated', syncLogo as EventListener);
    };
  }, []);

  if (!order) {
    return <div className="rounded-[32px] bg-white p-8 text-sm text-gray-500 shadow-sm">Loading receipt...</div>;
  }

  const renderOrder = kitchenOnlyItems ? { ...order, items: kitchenOnlyItems } : order;

  // A discount typed into SalesPage.tsx's order-details card only gets
  // saved onto the real order document once Complete Order actually runs
  // (see orderController.js's completeAndSettle) - before that, it's just
  // a draft sitting in sessionStorage (see discount-draft.ts). A cashier
  // checking this pending order's receipt here, before ever completing it
  // (exactly what was reported: no printer connected right now, just
  // wanting to see the receipt would look like), would otherwise see no
  // discount at all - not because the receipt template is missing it, but
  // because the order itself genuinely doesn't have one yet. This overlays
  // that same draft on top, PREVIEW ONLY (never written back to the order
  // or the backend) - the instant the order is actually completed,
  // order.discount is real and this branch stops applying on its own
  // (status is no longer 'pending').
  const previewSubtotal = renderOrder.subtotal ?? renderOrder.total ?? 0;
  const previewDiscount = renderOrder.status === 'pending'
    ? (() => {
        const draft = loadDiscountDraft(renderOrder.id);
        return computeDiscountFromInputs(draft.amount, draft.percent, previewSubtotal);
      })()
    : null;
  const displayOrder = previewDiscount
    ? {
        ...renderOrder,
        discount: previewDiscount,
        total: Math.max(previewSubtotal + (renderOrder.tax ?? 0) - previewDiscount.amount, 0),
      }
    : renderOrder;

  if (isSilent) {
    return (
      <div className="bg-white m-0 p-0">
        <style dangerouslySetInnerHTML={{__html: `
          aside, .print\\:hidden { display: none !important; }
          .min-h-screen { display: block !important; background: white !important; min-height: 0 !important; }
          main { display: block !important; padding: 0 !important; margin: 0 !important; overflow: visible !important; }
          #silent-wrapper { display: block !important; background: white !important; margin: 0 !important; padding: 0 !important; width: 80mm !important; height: auto !important; overflow: visible !important; }
          #receipt-print-area { display: block !important; width: 80mm !important; max-width: 80mm !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; transform: translateY(0) !important; }
          #receipt-print-area .thermal-receipt { width: 70mm !important; max-width: 70mm !important; margin: 0 auto !important; }
          #receipt-print-area > div { padding-top: 0 !important; padding-bottom: 0 !important; }
          @page { margin: 0; }
          html, body, body > div {
            background-color: white !important;
            margin: 0 !important;
            padding: 0 !important;
            width: 80mm !important;
            height: auto !important;
            min-height: 0 !important;
            display: block !important;
            overflow: visible !important;
            align-items: flex-start !important;
            justify-content: flex-start !important;
          }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        `}} />
        <div id="silent-wrapper">
          <div id="receipt-print-area" className="w-[70mm] m-0 p-0 overflow-visible">
            <ReceiptRenderer order={displayOrder} type={receiptType} logoSrc={logoSrc} previousDues={previousDues} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 print:space-y-0 print:p-0 print:m-0">
      
      {/* Hide UI when printing visually */}
      <style dangerouslySetInnerHTML={{__html: `
        @page {
          margin: 0;
        }
        @media print {
          .no-print { display: none !important; }
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          html, body { 
            background-color: white !important; 
            margin: 0 !important; 
            padding: 0 !important; 
            height: auto !important;
            min-height: 0 !important;
            float: none !important;
          }
          #receipt-print-area { 
            margin: 0 auto; 
            padding: 0; 
            box-shadow: none; 
            width: 80mm;
            overflow: visible;
            display: block;
          }
          #receipt-print-area .thermal-receipt {
            width: 70mm !important;
            max-width: 70mm !important;
            margin: 0 auto !important;
          }
        }
      `}} />

      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div>
          <Link to="/dashboard/sales" className="text-sm font-bold text-gray-500">
            <ArrowLeft size={16} className="mr-2 inline" />
            Back to Sales
          </Link>
          <h1 className="mt-2 text-3xl font-black text-gray-900">Manual Print Center</h1>
        </div>
        <button
          type="button"
          onClick={() => {
            window.print();
            toast.success(`${receiptType === 'kitchen' ? 'Kitchen ticket' : 'Customer receipt'} sent to printer.`);
          }}
          className="rounded-2xl bg-black px-4 py-3 text-sm font-black text-white"
        >
          <Printer size={16} className="mr-2 inline" />
          Print Current Receipt
        </button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)] no-print">
        <aside className="rounded-[32px] bg-white p-6 shadow-sm">
          <div className="space-y-4">
            <div className="flex gap-2 rounded-full bg-[#F6F7FB] p-1.5">
              <button type="button" onClick={() => setReceiptType('cashier')} className={`rounded-full px-4 py-2 text-sm font-black ${receiptType === 'cashier' ? 'bg-black text-white' : 'text-gray-500'}`}>Cashier</button>
              <button type="button" onClick={() => setReceiptType('kitchen')} className={`rounded-full px-4 py-2 text-sm font-black ${receiptType === 'kitchen' ? 'bg-black text-white' : 'text-gray-500'}`}>Kitchen</button>
            </div>

            <div>
              <label className="mb-1 block text-sm font-semibold text-gray-700">Kitchen Printer Label</label>
              <input value={kitchenPrinter} onChange={(event) => setKitchenPrinter(event.target.value)} placeholder="Example: Kitchen Epson" className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
            </div>

            <div>
              <label className="mb-1 block text-sm font-semibold text-gray-700">Cashier Printer Label</label>
              <input value={cashierPrinter} onChange={(event) => setCashierPrinter(event.target.value)} placeholder="Example: Front Counter POS" className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none" />
            </div>

            <p className="rounded-[24px] bg-[#F8F9FB] p-4 text-sm text-gray-600">
              Browsers do not allow this app to auto-select a real printer device. These fields help staff remember which printer to choose in the print dialog.
            </p>
          </div>
        </aside>

        <section className="rounded-[32px] bg-white p-8 shadow-sm flex items-start justify-center">
          {/* Visible in UI */}
          <div className="border shadow-lg p-4">
             <ReceiptRenderer order={displayOrder} type={receiptType} logoSrc={logoSrc} previousDues={previousDues} />
          </div>
        </section>
      </div>

      {/* This is the only thing visible during actual printing natively */}
      <div className="hidden print:block" id="receipt-print-area">
        <ReceiptRenderer order={displayOrder} type={receiptType} logoSrc={logoSrc} previousDues={previousDues} />
      </div>

    </div>
  );
}
