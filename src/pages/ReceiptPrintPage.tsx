import { useParams, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { fetchOrder, fetchCustomerOutstanding } from '@/lib/pos-api';
import { SavedOrder } from '@/lib/pos-types';
import ReceiptRenderer from '@/pages/dashboard/components/ReceiptRenderer';
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

  const pinReceiptToTop = () => {
    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.documentElement.style.minHeight = '0';
    document.documentElement.style.width = '80mm';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.minHeight = '0';
    document.body.style.width = '80mm';
    document.body.style.display = 'block';
    document.body.style.position = 'static';

    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;

    const receipt = document.getElementById('receipt-print-area');
    if (receipt) {
      receipt.style.margin = '0';
      receipt.style.padding = '0';
      receipt.style.width = '80mm';
      receipt.style.position = 'static';
      receipt.style.top = '0';
      receipt.style.left = '0';
      receipt.style.transform = 'none';
    }

    const mainElement = document.querySelector('main');
    if (mainElement) {
      mainElement.style.margin = '0';
      mainElement.style.padding = '0';
      mainElement.style.width = '80mm';
      mainElement.style.position = 'static';
      mainElement.style.top = '0';
    }
  };

  // Not tied to any one template's specific wording any more - different
  // shops can pick different receipt layouts (see ReceiptRenderer.tsx), so
  // this just waits for the print area to actually have real content.
  const startedAt = Date.now();
  let receiptElement = document.getElementById('receipt-print-area');
  while ((!receiptElement || (receiptElement.textContent?.trim().length ?? 0) <= 20) && Date.now() - startedAt < 5000) {
    await wait(100);
    receiptElement = document.getElementById('receipt-print-area');
  }

  await document.fonts?.ready.catch(() => undefined);
  await Promise.all(Array.from(document.images).map((img) => {
    if (img.complete && img.naturalWidth !== 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
  }));

  await nextFrame();
  await nextFrame();
  await wait(250);
  pinReceiptToTop();
  await nextFrame();
  await wait(100);

  // Second pass to ensure alignment
  pinReceiptToTop();

  receiptElement = document.getElementById('receipt-print-area');
  const rect = receiptElement?.getBoundingClientRect();
  return {
    height: Math.ceil(Math.max(receiptElement?.scrollHeight || 0, rect?.height || 0, 200)),
    width: Math.ceil(Math.max(receiptElement?.scrollWidth || 0, rect?.width || 0, 302)),
  };
}

export default function StandaloneReceiptPrintPage() {
  const params = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const receiptType = searchParams.get('type') === 'cashier' ? 'cashier' : 'kitchen';
  const [order, setOrder] = useState<SavedOrder | null>(null);
  // Dues carried forward from the customer's OTHER unpaid orders - see
  // PrintOrderPage.tsx for the same pattern.
  const [previousDues, setPreviousDues] = useState(0);
  const [logoSrc] = useState<string | null>(() => typeof window === 'undefined' ? null : window.localStorage.getItem(PRINT_LOGO_STORAGE_KEY));
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    void fetchOrder(params.id).then(setOrder);
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

    const notifyReady = async () => {
      const measurement = await waitForReceiptLayout();
      setIsReady(true);

      if (typeof window === 'undefined' || !navigator.userAgent.includes('Electron')) {
        // Web browser fallback - print directly
        window.print();
        return;
      }

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
      } catch (error) {
        console.error('Failed to send receipt ready signal', error);
        window.print();
      }
    };

    void notifyReady();
  }, [order, receiptType]);

  if (!order) {
    return null;
  }

  return (
    <main style={{
      margin: 0,
      padding: 0,
      display: 'block',
      position: 'static',
      top: 0,
      left: 0,
      width: '80mm',
      backgroundColor: 'white'
    }}>
      <style dangerouslySetInnerHTML={{ __html: `
        @page {
          margin: 0 !important;
          padding: 0 !important;
          size: 80mm auto;
        }

        html, body {
          margin: 0 !important;
          padding: 0 !important;
          width: 80mm !important;
          min-height: 0 !important;
          height: auto !important;
          background: white !important;
          display: block !important;
          position: static !important;
          top: 0 !important;
          left: 0 !important;
          overflow: visible !important;
        }

        body {
          margin: 0 !important;
          padding: 0 !important;
        }

        /* Remove all margins from Next.js wrappers */
        body > div,
        div#__next,
        div[data-nextjs-scroll-focus-boundary],
        main {
          margin: 0 !important;
          padding: 0 !important;
          width: 80mm !important;
          min-height: 0 !important;
          height: auto !important;
          display: block !important;
          position: static !important;
          top: 0 !important;
        }

        #receipt-print-area {
          display: block !important;
          margin: 0 !important;
          padding: 0 !important;
          width: 80mm !important;
          position: static !important;
          top: 0 !important;
          left: 0 !important;
          transform: none !important;
          overflow: visible !important;
        }

        #receipt-print-area .thermal-receipt {
          width: 72mm !important;
          max-width: 72mm !important;
          margin: 0 auto !important;
        }

        #receipt-print-area > *:first-child {
          margin-top: 0 !important;
          padding-top: 0 !important;
        }

        /* Ensure no extra space at top of first element inside receipt */
        #receipt-print-area div:first-child,
        #receipt-print-area img:first-child {
          margin-top: 0 !important;
          padding-top: 0 !important;
        }

        @media print {
          body {
            margin: 0 !important;
            padding: 0 !important;
          }

          #receipt-print-area {
            position: static !important;
            top: 0 !important;
            transform: none !important;
          }
        }

        /* Hide any scrollbars */
        ::-webkit-scrollbar {
          display: none;
        }
      ` }} />
      <div id="receipt-print-area">
        <ReceiptRenderer order={order} type={receiptType} logoSrc={logoSrc} previousDues={previousDues} />
      </div>
      {isReady && (
        <div style={{ height: 0, overflow: 'hidden', visibility: 'hidden' }}>
          {/* This hidden div ensures layout is complete */}
        </div>
      )}
    </main>
  );
}
