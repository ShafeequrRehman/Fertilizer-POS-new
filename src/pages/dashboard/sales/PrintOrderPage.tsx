import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import { fetchOrder, fetchCustomerOutstanding } from '@/lib/pos-api';
import { SavedOrder } from '@/lib/pos-types';
import ThermalReceipt from '@/pages/dashboard/components/ThermalReceipt';
import { PRINT_LOGO_STORAGE_KEY } from '@/lib/print-logo';

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

  const waitForElement = async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      const element = document.getElementById('receipt-print-area');
      const text = element?.textContent ?? '';
      if (element && text.includes('DATE:') && text.includes('Items:')) return element;
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
  const params = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const autoPrint = searchParams.get('auto') === 'true';
  const defaultType = searchParams.get('type') === 'kitchen' ? 'kitchen' : 'cashier';

  const [order, setOrder] = useState<SavedOrder | null>(null);
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

  useEffect(() => {
    void fetchOrder(params.id).then((fetchedOrder) => {
      setOrder(fetchedOrder);
    });
  }, [params.id]);

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

      if (autoPrint) window.print();
    };

    void handlePrintReady();
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

  if (isSilent) {
    return (
      <div className="bg-white m-0 p-0">
        <style dangerouslySetInnerHTML={{__html: `
          aside, .print\\:hidden { display: none !important; }
          .min-h-screen { display: block !important; background: white !important; min-height: 0 !important; }
          main { display: block !important; padding: 0 !important; margin: 0 !important; overflow: visible !important; }
          #silent-wrapper { display: block !important; background: white !important; margin: 0 !important; padding: 0 !important; width: 80mm !important; height: auto !important; overflow: visible !important; }
          #receipt-print-area { display: block !important; width: 80mm !important; max-width: 80mm !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; transform: translateY(0) !important; }
          #receipt-print-area .thermal-receipt { width: 72mm !important; max-width: 72mm !important; margin: 0 auto !important; }
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
          <div id="receipt-print-area" className="w-[72mm] m-0 p-0 overflow-visible">
            <ThermalReceipt order={order} type={receiptType} logoSrc={logoSrc} previousDues={previousDues} />
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
            width: 72mm !important;
            max-width: 72mm !important;
            margin: 0 auto !important;
          }
        }
      `}} />

      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div>
          <Link href="/dashboard/sales" className="text-sm font-bold text-gray-500">
            <ArrowLeft size={16} className="mr-2 inline" />
            Back to Sales
          </Link>
          <h1 className="mt-2 text-3xl font-black text-gray-900">Manual Print Center</h1>
        </div>
        <button type="button" onClick={() => window.print()} className="rounded-2xl bg-black px-4 py-3 text-sm font-black text-white">
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
             <ThermalReceipt order={order} type={receiptType} logoSrc={logoSrc} previousDues={previousDues} />
          </div>
        </section>
      </div>

      {/* This is the only thing visible during actual printing natively */}
      <div className="hidden print:block" id="receipt-print-area">
        <ThermalReceipt order={order} type={receiptType} logoSrc={logoSrc} previousDues={previousDues} />
      </div>

    </div>
  );
}
