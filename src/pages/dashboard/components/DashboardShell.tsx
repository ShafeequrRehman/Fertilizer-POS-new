import React, { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingCart, BarChart3, Calculator,
  Package, Users, DollarSign, FileText, Settings, HelpCircle,
  Search, Cloud, MessageCircle, Bell, LogOut, UserCog, BookText,
  Store, Lock, ClipboardList, Wifi, WifiOff
} from 'lucide-react';
import { clearAuthSession, getAuthRole, hasPermission } from '@/lib/auth';
import { logoutRequest } from '@/lib/api';
import { ApiError, claimKitchenPrint, claimReceiptPrint, closeShopSession, fetchUnprintedKitchenOrders, fetchUnprintedReceiptOrders, openShopSession } from '@/lib/pos-api';
import { useNetworkStatus } from '@/lib/network-status';
import { ShopSessionProvider, useShopSession } from '@/lib/shop-session';
import { useToast } from '@/lib/toast';
import { getStoreSettings } from '@/lib/pos-settings';
import { getIpcRenderer } from '@/lib/electron-bridge';

// Nav items carry an optional `permission` key - see lib/auth.ts
// hasPermission(), which mirrors backend/middleware/requirePermission.js.
// Shop Owners always see every item (hasPermission short-circuits true for
// role 'shopowner'); Employees only see items whose permission is part of
// the Role they were assigned. Items with no `permission` are always
// visible to any logged-in shop member (Dashboard home, Help).
export default function DashboardShell() {
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  const role = getAuthRole();

  const navItems = [
    { icon: <LayoutDashboard size={18} />, label: 'Dashboard', href: '/dashboard' },
    { icon: <ShoppingCart size={18} />, label: 'POS', href: '/dashboard/pos', permission: 'sales.create' },
    { icon: <BarChart3 size={18} />, label: 'Sales', href: '/dashboard/sales', permission: 'sales.create' },
    { icon: <Calculator size={18} />, label: 'Accounting', href: '/dashboard/accounting', permission: 'expenses.manage' },
    { icon: <Package size={18} />, label: 'Purchase', href: '/dashboard/purchase', permission: 'purchases.manage' },
    { icon: <Users size={18} />, label: 'Customers & HR', href: '/dashboard/management', permission: 'customers.manage' },
    { icon: <FileText size={18} />, label: 'Customer Dues', href: '/dashboard/dues', permission: 'dues.manage' },
    { icon: <BookText size={18} />, label: 'Ledger', href: '/dashboard/ledger', permission: 'dues.manage' },
    { icon: <ClipboardList size={18} />, label: 'Record', href: '/dashboard/record', permission: 'orders.record.view' },
    { icon: <Store size={18} />, label: 'Shifts', href: '/dashboard/shifts', permission: 'shop.session.manage' },
    { icon: <DollarSign size={18} />, label: 'Payroll', href: '/dashboard/payroll', permission: 'employees.manage' },
    { icon: <FileText size={18} />, label: 'Reports', href: '/dashboard/reports', permission: 'reports.view' },
    ...(role === 'shopowner' ? [{ icon: <UserCog size={18} />, label: 'Employees', href: '/dashboard/employees' }] : []),
    { icon: <Settings size={18} />, label: 'Settings', href: '/dashboard/settings', permission: 'settings.manage' },
    { icon: <MessageCircle size={18} />, label: 'WhatsApp', href: '/dashboard/whatsapp', permission: 'whatsapp.manage' },
    { icon: <HelpCircle size={18} />, label: 'Help', href: '/dashboard/help' },
  ].filter((item) => !item.permission || hasPermission(item.permission));

  return (
    <ShopSessionProvider>
      <KitchenPrintWatcher />
      <ReceiptPrintWatcher />
      <div className="flex min-h-screen bg-[#F2F4F7] font-sans text-[#2D2E2E] print:block print:min-h-0 print:bg-white">
        <aside className="print:hidden flex w-56 flex-col gap-6 p-4">
          <div className="flex items-center gap-2 px-2">
            <div className="rounded-lg bg-black p-1">
              <div className="text-[10px] text-white">*</div>
            </div>
            <span className="text-xl font-bold tracking-tight">Starline</span>
          </div>

          <nav className="flex flex-col gap-1">
            {navItems.map((item) => (
              <NavItem
                key={item.label}
                icon={item.icon}
                label={item.label}
                href={item.href}
                active={pathname === item.href}
              />
            ))}
          </nav>
        </aside>

        <main className="flex-1 overflow-auto p-8 print:overflow-visible print:p-0">
          <div className="print:hidden mb-6 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <ShopStatusControl />
              <NetworkStatusBadge />
            </div>
            <div className="flex items-center gap-3">
              <TopAction icon={<Search size={18} />} />
              <TopAction icon={<Cloud size={18} />} />
              <TopAction icon={<MessageCircle size={18} />} />
              <div className="relative">
                <TopAction icon={<Bell size={18} />} />
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">2</span>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await logoutRequest();
                  clearAuthSession();
                  navigate('/login', { replace: true });
                }}
                className="flex items-center gap-2 rounded-full border border-white bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
              >
                <LogOut size={16} />
                Logout
              </button>
            </div>
          </div>
          <Outlet />
        </main>
      </div>
    </ShopSessionProvider>
  );
}

// Background "print any order nobody has printed a kitchen ticket for yet"
// loop - this is what makes an order placed on pos-mobile show up on this
// till's kitchen printer automatically, the same way a till-placed order
// already prints itself immediately (see POSPage.tsx). Renders nothing;
// it's mounted here (inside DashboardShell, which wraps every dashboard
// page) so it keeps running no matter which page the cashier is looking
// at, not just while POS or Kitchen happens to be open.
//
// Only ever does anything in Electron with a kitchen printer configured -
// a plain browser tab has no printer to send jobs to, and letting it poll
// anyway would mean it could claim orders (see claimKitchenPrint's atomic
// "only one caller ever wins" guarantee) and then just silently fail to
// print them, starving the real till of a ticket it should have gotten.
const KITCHEN_POLL_INTERVAL_MS = 7000;

function KitchenPrintWatcher() {
  const { toast } = useToast();
  const inFlightRef = useRef<Set<string>>(new Set());
  // ToastProvider rebuilds its `toast` object every render (it's a plain
  // object literal, not memoized), so depending on `toast` directly in the
  // effect below would tear down and restart this poll loop constantly -
  // any toast firing anywhere in the app would restart it. A ref sidesteps
  // that: the effect reads the LATEST toast fns without needing them in
  // its dependency array, so it mounts once and stays running.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer) return undefined; // not Electron - nothing to print with

    let cancelled = false;

    async function poll() {
      const settings = getStoreSettings();
      if (!settings.kitchenPrinter) return; // nothing configured to print to

      let orders;
      try {
        orders = await fetchUnprintedKitchenOrders();
      } catch {
        return; // network hiccup - next tick retries
      }
      if (!orders || cancelled) return;

      const printLogo = typeof window !== 'undefined' ? localStorage.getItem('preferred-print-logo') : null;

      for (const order of orders) {
        if (cancelled) break;
        if (inFlightRef.current.has(order.id)) continue; // already claiming/printing this one
        inFlightRef.current.add(order.id);

        claimKitchenPrint(order.id)
          .then(async (claimed) => {
            await ipcRenderer.invoke('print-kitchen-receipt-data', claimed, settings.kitchenPrinter, printLogo, settings);
            toastRef.current.info(`New order #${claimed.dailyOrderNumber ?? claimed.id.slice(-4)} - printed to kitchen.`);
          })
          .catch((err) => {
            // 409 = another till (or this same one, on a previous tick)
            // already claimed it - not an error, just not ours to print.
            if (!(err instanceof ApiError) || err.status !== 409) {
              console.error('Kitchen auto-print failed:', err);
            }
          })
          .finally(() => {
            inFlightRef.current.delete(order.id);
          });
      }
    }

    void poll();
    const intervalId = setInterval(() => void poll(), KITCHEN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  return null;
}

// Sibling to KitchenPrintWatcher above, for the customer-receipt side of
// TakeAway orders - catches TakeAway orders placed on a phone via
// pos-mobile (which has no printer of its own) and prints their receipt
// on this till's counter/customer printer immediately, the same way
// POSPage.tsx already does for TakeAway orders rung up on this till
// directly. DineIn/Delivery orders are never returned by
// fetchUnprintedReceiptOrders - they keep printing their receipt at
// Complete Payment on the Sales page, unchanged.
const RECEIPT_POLL_INTERVAL_MS = 7000;

function ReceiptPrintWatcher() {
  const { toast } = useToast();
  const inFlightRef = useRef<Set<string>>(new Set());
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer) return undefined;

    let cancelled = false;

    async function poll() {
      const settings = getStoreSettings();
      if (!settings.counterPrinter) return; // nothing configured to print to

      let orders;
      try {
        orders = await fetchUnprintedReceiptOrders();
      } catch {
        return; // network hiccup - next tick retries
      }
      if (!orders || cancelled) return;

      const printLogo = typeof window !== 'undefined' ? localStorage.getItem('preferred-print-logo') : null;

      for (const order of orders) {
        if (cancelled) break;
        if (inFlightRef.current.has(order.id)) continue;
        inFlightRef.current.add(order.id);

        claimReceiptPrint(order.id)
          .then(async (claimed) => {
            // Order-number token slip first, then the full customer
            // receipt - same order POSPage.tsx prints in for TakeAway
            // orders rung up directly on this till.
            try {
              await ipcRenderer.invoke('print-order-token-data', claimed, settings.counterPrinter, printLogo, settings);
            } catch (err) {
              console.error(err);
            }
            await ipcRenderer.invoke('print-cashier-receipt-data', claimed, settings.counterPrinter, printLogo, settings);
            toastRef.current.info(`Take Away order #${claimed.dailyOrderNumber ?? claimed.id.slice(-4)} - receipt printed.`);
          })
          .catch((err) => {
            if (!(err instanceof ApiError) || err.status !== 409) {
              console.error('Receipt auto-print failed:', err);
            }
          })
          .finally(() => {
            inFlightRef.current.delete(order.id);
          });
      }
    }

    void poll();
    const intervalId = setInterval(() => void poll(), RECEIPT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  return null;
}

// The Open/Close Shop control. Any shop member can see the current status
// (important context - the POS screen refuses new orders while closed, see
// POSPage), but only someone with the shop.session.manage permission
// (Shop Owner always, or an employee whose Role grants it - Manager by
// default) gets the actual buttons to toggle it.
function ShopStatusControl() {
  const { isOpen, session, loading, refresh } = useShopSession();
  const { toast, confirm } = useToast();
  const canManage = hasPermission('shop.session.manage');
  const [busy, setBusy] = useState(false);

  async function handleOpen() {
    setBusy(true);
    try {
      await openShopSession();
      await refresh();
      toast.success('Shop opened. Orders can now be taken.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open shop.');
    } finally {
      setBusy(false);
    }
  }

  async function handleClose(force = false) {
    setBusy(true);
    try {
      const result = await closeShopSession(force);
      if (!result) return;

      if (result.needsConfirmation) {
        const orders = result.unresolvedOrders || [];
        const preview = orders.slice(0, 8).map((o) => `#${o.dailyOrderNumber ?? o.id.slice(-4)} - ${o.status === 'pending' ? 'pending' : `PKR ${o.remainingAmount} due`}`).join('\n');
        const extra = orders.length > 8 ? `\n...and ${orders.length - 8} more` : '';
        setBusy(false);
        const confirmed = await confirm(
          `${orders.length} order${orders.length === 1 ? ' is' : 's are'} still pending or unpaid:\n\n${preview}${extra}\n\nClose the shop anyway? These orders stay in the system either way.`,
          { title: 'Unresolved orders', confirmText: 'Close Anyway', tone: 'danger' }
        );
        if (confirmed) {
          await handleClose(true);
        }
        return;
      }

      await refresh();
      if (result.session) {
        const s = result.session.summary;
        toast.success(`Shop closed. ${s.orderCount} order${s.orderCount === 1 ? '' : 's'}, PKR ${s.totalSales.toLocaleString()} total sales.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to close shop.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="h-10 w-36 animate-pulse rounded-full bg-white/60" />;
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        disabled={busy || !canManage}
        title={canManage ? 'Open the shop to start taking orders' : 'Only a Manager or Shop Owner can open the shop'}
        className="flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Store size={16} />
        {busy ? 'Opening...' : 'Open Shop'}
      </button>
    );
  }

  const openedTime = session?.openedAt ? new Date(session.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const liveCount = session?.liveSummary?.orderCount ?? 0;

  return (
    <div className="flex items-center gap-2">
      <div
        className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-700"
        title={`Opened at ${openedTime}${session?.openedByName ? ` by ${session.openedByName}` : ''}`}
      >
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        Open since {openedTime} · {liveCount} order{liveCount === 1 ? '' : 's'}
      </div>
      {canManage && (
        <button
          type="button"
          onClick={() => handleClose(false)}
          disabled={busy}
          className="flex items-center gap-2 rounded-full bg-rose-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Lock size={16} />
          {busy ? 'Closing...' : 'Close Shop'}
        </button>
      )}
    </div>
  );
}

// Shows real backend reachability (see src/lib/network-status.ts), not just
// the OS network-adapter flag - sits right next to the Open/Close Shop
// button since both answer "can this shop actually take/sync orders right
// now?".
function NetworkStatusBadge() {
  const { isOnline, checking, checkNow } = useNetworkStatus();

  return (
    <button
      type="button"
      onClick={() => void checkNow()}
      title={isOnline ? 'Connected to the server' : 'Cannot reach the server - check your internet connection'}
      className={`flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-bold transition-colors ${
        isOnline
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-rose-200 bg-rose-50 text-rose-700'
      }`}
    >
      {isOnline ? <Wifi size={16} /> : <WifiOff size={16} />}
      <span className={checking ? 'opacity-60' : ''}>{isOnline ? 'Online' : 'Offline'}</span>
    </button>
  );
}

function NavItem({
  icon,
  label,
  href,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  href?: string;
  active?: boolean;
}) {
  const className = `flex items-center gap-2.5 rounded-full px-3 py-2.5 transition-all ${
    active ? 'bg-[#E2F33C] font-bold text-black shadow-sm' : 'text-gray-500 hover:bg-gray-200'
  }`;

  if (!href) {
    return (
      <div className={`${className} cursor-default`}>
        {icon}
        <span className="text-sm">{label}</span>
      </div>
    );
  }

  return (
    <Link to={href} className={className}>
      {icon}
      <span className="text-sm">{label}</span>
    </Link>
  );
}

function TopAction({ icon }: { icon: React.ReactNode }) {
  return (
    <div className="cursor-pointer rounded-full border border-white bg-white/60 p-2.5 text-gray-500 shadow-sm transition-colors hover:bg-white">
      {icon}
    </div>
  );
}
