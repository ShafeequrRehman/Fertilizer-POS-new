import React, { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingCart, BarChart3, Calculator,
  Package, Users, DollarSign, FileText, Settings, HelpCircle,
  Search, Cloud, MessageCircle, Bell, LogOut, UserCog, BookText,
  Store, Lock, ClipboardList, Wifi, WifiOff, Download, RefreshCcw,
  Menu, X, Smartphone, Boxes, ChefHat, Table2
} from 'lucide-react';
import { clearAuthSession, getAuthRole, getAuthShop, hasPermission, hasAnyPermission, isPageEnabled, getIsDashboardHidden } from '@/lib/auth';
import { DASHBOARD_PAGES } from '@/lib/dashboard-pages';
import { useOfflineSync } from '@/lib/offline-sync';
import { isDesktopApp, logoutRequest } from '@/lib/api';
import { ApiError, claimKitchenPrint, claimKitchenUpdatePrint, closeShopSession, fetchProducts, fetchUnprintedKitchenOrders, fetchUnprintedKitchenUpdateOrders, openShopSession } from '@/lib/pos-api';
import { useNetworkStatus } from '@/lib/network-status';
import { ShopSessionProvider, useShopSession } from '@/lib/shop-session';
import { useToast } from '@/lib/toast';
import { useNotifications, formatNotificationAge, NOTIFICATION_ICON, NOTIFICATION_ICON_BG, EDITABLE_WINDOW_MS, type AppNotification } from '@/lib/notifications';
import { getStoreSettings } from '@/lib/pos-settings';
import { getIpcRenderer } from '@/lib/electron-bridge';
import { reportPrintOutcome } from '@/lib/print-notify';
import { buildCategoryLookup, dispatchKitchenPrints } from '@/lib/kitchen-print-routing';
import ShopClosingSummaryModal from '@/pages/dashboard/components/ShopClosingSummaryModal';

// Icons keyed by DASHBOARD_PAGES's `key` - kept separate from that shared
// list since it lives in lib/ and can't hold JSX.
const PAGE_ICONS: Record<string, React.ReactNode> = {
  dashboard: <LayoutDashboard size={18} />,
  pos: <ShoppingCart size={18} />,
  sales: <BarChart3 size={18} />,
  accounting: <Calculator size={18} />,
  purchase: <Package size={18} />,
  'ingredient-stock': <Boxes size={18} />,
  'recipe-management': <ChefHat size={18} />,
  'dining-tables': <Table2 size={18} />,
  management: <Users size={18} />,
  dues: <FileText size={18} />,
  ledger: <BookText size={18} />,
  record: <ClipboardList size={18} />,
  shifts: <Store size={18} />,
  offline: <Wifi size={18} />,
  payroll: <DollarSign size={18} />,
  reports: <FileText size={18} />,
  employees: <UserCog size={18} />,
  settings: <Settings size={18} />,
  whatsapp: <MessageCircle size={18} />,
  help: <HelpCircle size={18} />,
};

// Nav items carry an optional `permission` key - see lib/auth.ts
// hasPermission(), which mirrors backend/middleware/requirePermission.js.
// Shop Owners always see every item (hasPermission short-circuits true for
// role 'shopowner'); Employees only see items whose permission is part of
// the Role they were assigned. Items with no `permission` are always
// visible to any logged-in shop member (Dashboard home, Help).
//
// On top of that, isPageEnabled() filters against this shop's
// Super-Admin-controlled enabledPages (see lib/dashboard-pages.ts) - this
// applies to EVERYONE at the shop, including the owner, since it's a
// platform-level toggle rather than a within-shop role/permission rule.
export default function DashboardShell() {
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  const role = getAuthRole();
  // Off-canvas sidebar on phone/tablet widths (<lg) - the sidebar used to
  // be a fixed, always-visible 224px column with zero responsive
  // breakpoints, which left literally no room for page content on a phone
  // screen. At lg and up this renders exactly as it always did (a static
  // column); below that it's a slide-in drawer toggled by the hamburger
  // button in the header, closed by default, and auto-closes on
  // navigation/backdrop tap.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navItems = DASHBOARD_PAGES
    // Payroll and Manage Staff both hit Shop Owner-only backend routes
    // (requireShopOwner) - hide them from employees entirely rather than
    // showing a link that always 403s.
    .filter((item) => (item.key !== 'employees' && item.key !== 'payroll') || role === 'shopowner')
    // Dashboard Permission Gate: hides the Dashboard home link itself when
    // this employee's assigned Role has "Hide Dashboard" checked - see
    // getIsDashboardHidden's own comment (never true for a Shop Owner).
    .filter((item) => item.key !== 'dashboard' || !getIsDashboardHidden())
    .filter((item) => !item.permission || (Array.isArray(item.permission) ? hasAnyPermission(item.permission) : hasPermission(item.permission)))
    .filter((item) => isPageEnabled(item.key))
    .map((item) => ({ ...item, icon: PAGE_ICONS[item.key] }));

  // Keyboard Shortcuts - Core Navigation: every DASHBOARD_PAGES entry that
  // carries a `hotkey` (F1-F10 - see that file's own comment on why it
  // stops there) works from anywhere in the dashboard, not just while that
  // page itself is focused - wired up once here rather than duplicated on
  // every page. F-keys never type a character into a field, so unlike the
  // Ctrl+S/Enter/Arrow/+- shortcuts each page wires up locally (see
  // POSPage.tsx), these don't need an isTypingTarget guard. Driven
  // straight off navItems (this employee's own permission/enabledPages-
  // filtered nav, not the raw DASHBOARD_PAGES list) so a hotkey can never
  // navigate somewhere their sidebar wouldn't also let them click - a
  // hotkey shouldn't be a backdoor around the permission system. F3 used
  // to be a POS-internal "focus product search" shortcut instead of a page
  // link; that behavior was removed so F3 could take its place in this
  // same sequential mapping like every other hotkeyed page.
  useEffect(() => {
    function handleGlobalShortcut(event: KeyboardEvent) {
      const match = navItems.find((item) => item.hotkey === event.key);
      if (!match) return;
      event.preventDefault();
      navigate(match.href);
    }
    window.addEventListener('keydown', handleGlobalShortcut);
    return () => window.removeEventListener('keydown', handleGlobalShortcut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Runs the 5-minute offline sync timer (see lib/offline-sync.ts) for the
  // lifetime of the dashboard session - a no-op outside the Electron app,
  // and harmless to mount even for shops that never use offline mode.
  const { lastResult } = useOfflineSync();
  const { toast: syncToast } = useToast();
  // Shared by both kitchen watchers below (see their own comments) instead
  // of each running its own independent copy of this poll.
  const categoryLookupRef = useCategoryLookupRef();

  // A Cancel Order made offline is trusted immediately (see
  // CancelOrderModal.tsx) and only actually verified against the real
  // Cancel Order Key once this sync tick replays it - if the key turns out
  // wrong, the order is still showing "cancelled" on whatever screen
  // showed it (until that page's next cache refresh corrects it), so this
  // is the one place that actively flags it instead of leaving it to be
  // silently discovered later on the Offline Sync page.
  useEffect(() => {
    if (lastResult?.wrongKeyOrderIds && lastResult.wrongKeyOrderIds.length > 0) {
      syncToast.error(
        lastResult.wrongKeyOrderIds.length === 1
          ? `An offline cancellation used the wrong Cancel Order Key - order ${lastResult.wrongKeyOrderIds[0]} was NOT cancelled. Redo it with the correct key.`
          : `${lastResult.wrongKeyOrderIds.length} offline cancellations used the wrong Cancel Order Key and were NOT applied. Redo them with the correct key.`,
      );
    }
    // Conflict resolution: two devices both placed a Dine-In order for the
    // same table while offline, unaware of each other (see
    // orderController.js's importOfflineOrders). The loser stays queued
    // (still a local-<uuid> order) - staff just need to pick a different
    // table for it via the normal Change Table action, and it'll sync on
    // the next tick.
    if (lastResult?.tableConflictOrderIds && lastResult.tableConflictOrderIds.length > 0) {
      syncToast.error(
        lastResult.tableConflictOrderIds.length === 1
          ? `An offline order's table was also taken by another device. Change its table to sync it.`
          : `${lastResult.tableConflictOrderIds.length} offline orders' tables were also taken by another device. Change their tables to sync them.`,
      );
    }
    // Conflict resolution: an offline edit was built against an order
    // version another till has since changed (see importOfflineOrderUpdates).
    // Rejected rather than silently overwritten - staff need to refresh
    // that order and redo the edit against its real current state.
    if (lastResult?.versionConflictOrderIds && lastResult.versionConflictOrderIds.length > 0) {
      syncToast.error(
        lastResult.versionConflictOrderIds.length === 1
          ? `An offline edit conflicted with a change from another device on order ${lastResult.versionConflictOrderIds[0]}. Refresh and redo that edit.`
          : `${lastResult.versionConflictOrderIds.length} offline edits conflicted with changes from another device. Refresh and redo those edits.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastResult]);

  // Close the drawer automatically whenever the route changes (tapping a
  // nav link already closes it explicitly - see NavItem's onClick below -
  // but this also covers back/forward navigation and any other route
  // change that doesn't go through a nav link click).
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  return (
    <ShopSessionProvider>
      {/* Floating frosted sidebar (macOS Finder / Sonoma-style) - detached
          from the edge with its own rounded glass panel on desktop, sliding
          in as a full-height glass panel on mobile (see sidebarOpen below). */}
      <KitchenPrintWatcher categoryLookupRef={categoryLookupRef} />
      <KitchenUpdateWatcher categoryLookupRef={categoryLookupRef} />
      {/* h-screen + overflow-hidden (was min-h-screen, no overflow control)
          - min-h-screen only sets a FLOOR, so once the page's content grew
          taller than the viewport the whole document scrolled as one unit,
          sidebar included, instead of just the <main> content underneath
          it - the sidebar wasn't actually "sticky", it just happened to
          start near the top and then scroll away with everything else.
          Capping this wrapper to exactly the viewport height forces all
          scrolling to happen inside <main>'s own overflow-auto below,
          leaving the sidebar genuinely fixed on screen regardless of how
          long the page content gets. print: overrides keep printing
          (which needs its natural full-content height, not a clipped one)
          working exactly as before. */}
      <div className="glass-app-bg flex h-screen overflow-hidden font-sans text-[#2D2E2E] print:block print:h-auto print:overflow-visible print:bg-white">
        {sidebarOpen ? (
          <div
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        ) : null}

        <aside
          className={`glass dashboard-sidebar print:hidden fixed inset-y-0 left-0 z-50 flex w-64 flex-col gap-6 overflow-y-auto p-4 transition-transform duration-200 ease-out lg:static lg:z-auto lg:top-4 lg:m-4 lg:h-[calc(100vh-2rem)] lg:w-56 lg:translate-x-0 lg:rounded-[28px] ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between gap-2 px-2">
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-black p-1">
                <div className="text-[10px] text-white">*</div>
              </div>
              {/* Whatever name the Super Admin gave this shop at creation
                  (Shop.name, cached at login - see auth.ts's SessionShop)
                  - "Starline" is only the fallback for the rare case that
                  cache is somehow missing. The Shop Owner can override it
                  from Settings > Restaurant Profile (Restaurant Name),
                  which patches this same cached value via
                  updateCachedShopName so it shows up here immediately, no
                  re-login needed. */}
              <span className="text-xl font-bold tracking-tight">{getAuthShop()?.name || 'Starline'}</span>
            </div>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded-full p-1.5 text-gray-400 hover:bg-gray-200 lg:hidden"
            >
              <X size={18} />
            </button>
          </div>

          <nav className="flex flex-col gap-1">
            {navItems.map((item) => (
              <NavItem
                key={item.label}
                icon={item.icon}
                label={item.label}
                href={item.href}
                hotkey={item.hotkey}
                active={pathname === item.href}
                onNavigate={() => setSidebarOpen(false)}
              />
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 overflow-auto p-4 sm:p-6 lg:p-8 print:overflow-visible print:p-0">
          {/* Below sm (a real phone), this used to be one flat flex-wrap
              list - the hamburger, the shop-status pill+button, and every
              connectivity badge all competing for the same wrapping rows in
              whatever order they happened to overflow, which is what
              produced the messy/random-looking stack (icon-action group
              landing on its own oddly-spaced line with a big gap above it).
              Restructured into two deliberate blocks on mobile instead: the
              hamburger + status/connectivity pills (each its own tidy row,
              via flex-col on the inner group), then the icon-action group
              as a clean row of its own underneath, right-aligned within
              itself. `items-start` stops each pill/badge button from
              stretching into an ugly full-width bar (flex-col's default).
              Every component here is still mounted exactly once - only the
              CSS layout differs by breakpoint - so this adds no extra
              polling/state. From sm up this collapses back to the exact
              single flex-wrap row it always was - nothing changes on
              tablet/desktop. */}
          <div className="print:hidden mb-3 flex flex-col items-start gap-1.5 sm:mb-6 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
            <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="flex items-center justify-center rounded-full border border-white bg-white p-2.5 text-gray-600 shadow-sm hover:bg-gray-50 lg:hidden"
                aria-label="Open menu"
              >
                <Menu size={18} />
              </button>
              <ShopStatusControl />
              <NetworkStatusBadge />
              <OfflineModeToggle />
              <UpdateStatusBadge />
            </div>
            {/* ml-auto keeps this group hugging the right edge from sm up,
                even when it wraps onto its own row below the left group -
                plain `justify-between` on the parent has no effect on a
                line that only contains one flex item, which is what let
                this whole group (and the bell button inside it) drift
                toward the left on a narrower window instead of staying at
                the right. `justify-end` does the same job on mobile, where
                the outer container is flex-col (so this block is already
                its own full-width row - it just needs its own contents
                pushed to that row's right edge). */}
            <div className="flex w-full flex-wrap items-center justify-end gap-1.5 sm:ml-auto sm:w-auto sm:gap-2">
              <InstallAppButton />
              <TopAction icon={<Search size={15} />} className="hidden sm:flex" />
              <TopAction icon={<Cloud size={15} />} className="hidden sm:flex" />
              <TopAction icon={<MessageCircle size={15} />} />
              <NotificationBellButton />
              <button
                type="button"
                onClick={async () => {
                  await logoutRequest();
                  clearAuthSession();
                  navigate('/login', { replace: true });
                }}
                className="glass-pill flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-white/70 sm:px-3"
              >
                <LogOut size={13} />
                <span className="hidden sm:inline">Logout</span>
              </button>
            </div>
          </div>
          <Outlet />
        </main>
      </div>
    </ShopSessionProvider>
  );
}

// The Android/Chrome "install this as an app" trigger for the STAFF
// dashboard itself - separate from CustomerOrderPage.tsx's own Install
// button, which only ever appears on the customer-facing ordering page.
// Needs main.tsx's site-wide sw.js registration (see the comment there) to
// ever fire at all - Chrome won't offer beforeinstallprompt without a
// registered service worker + this manifest (public/manifest.json).
// Renders nothing inside Electron (already a real installed app, nothing
// to prompt) or once the prompt has been used/dismissed for this session.
function InstallAppButton() {
  const [installEvent, setInstallEvent] = useState<any>(null);
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    if (isDesktopApp()) return undefined;
    function handler(event: Event) {
      event.preventDefault();
      setInstallEvent(event);
    }
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // iOS Safari never fires beforeinstallprompt (an Apple platform
  // restriction) - shows a one-tap dismissible hint with the manual Share ->
  // Add to Home Screen steps instead, same pattern as CustomerOrderPage.tsx.
  useEffect(() => {
    if (isDesktopApp()) return;
    const ua = window.navigator.userAgent;
    const isIos = /iphone|ipad|ipod/i.test(ua) && !(window as any).MSStream;
    const isStandalone = (window.navigator as any).standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    setShowIosHint(isIos && !isStandalone);
  }, []);

  if (installEvent) {
    return (
      <button
        type="button"
        onClick={async () => {
          installEvent.prompt();
          await installEvent.userChoice;
          setInstallEvent(null);
        }}
        title="Install this dashboard as an app on this phone/computer"
        className="flex items-center gap-2 rounded-full bg-black px-3 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-gray-800 sm:px-4"
      >
        <Smartphone size={16} />
        <span className="hidden sm:inline">Install App</span>
      </button>
    );
  }

  if (showIosHint) {
    return (
      <div
        title="On iPhone/iPad: tap Share, then Add to Home Screen"
        className="flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-xs font-bold text-indigo-700"
      >
        <Smartphone size={14} />
        <span className="hidden sm:inline">Share → Add to Home Screen</span>
      </div>
    );
  }

  return null;
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
// Was 7000ms - a mobile-placed/edited order has NO printer of its own, so
// this poll interval is the entire "how long until the kitchen finds out"
// delay for anything that came from a phone (the desktop's own orders print
// immediately, bypassing this poll entirely - see POSPage.tsx). 1500ms
// keeps that worst-case wait under 2s instead of up to 7s, at the cost of a
// slightly chattier poll - negligible for a single-shop backend.
const KITCHEN_POLL_INTERVAL_MS = 1500;

// Both kitchen watchers below need a name->category lookup to route Ice
// Cream/Drinks/Shwarma items to the counter printer instead of the
// kitchen printer (see kitchen-print-routing.ts) - refreshed on its own
// slower interval rather than on every 1.5s poll tick, since the product
// catalog changes far less often than orders come in. Falls back to
// whatever was last fetched (or an empty lookup, before the first fetch
// resolves - everything routes to the kitchen printer either way, the
// same behavior as before this split existed) if a refresh ever fails.
//
// Called ONCE here in DashboardShell and passed down as a prop to both
// watchers below, rather than each watcher calling this hook itself - they
// used to each run their own independent copy of this poll, meaning two
// separate fetchProducts() calls (plus two Map rebuilds) every single
// minute for the exact same data, for the entire time any dashboard page
// is open. One shared instance halves that redundant background network
// and CPU work.
const CATEGORY_LOOKUP_REFRESH_MS = 60000;

function useCategoryLookupRef() {
  const lookupRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const result = await fetchProducts();
        if (!cancelled) lookupRef.current = buildCategoryLookup(result.products || []);
      } catch {
        // Network hiccup - keep using the last-known lookup, next tick retries.
      }
    }
    void refresh();
    const intervalId = setInterval(() => void refresh(), CATEGORY_LOOKUP_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);
  return lookupRef;
}

function KitchenPrintWatcher({ categoryLookupRef }: { categoryLookupRef: React.MutableRefObject<Map<string, string>> }) {
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
    // TypeScript's null-narrowing above doesn't survive into the .then()
    // closures further down (they're not guaranteed to run within the same
    // synchronous control-flow tsc is analyzing) - rebinding to a new const
    // here keeps it non-nullable everywhere it's actually used below.
    const ipc = ipcRenderer;

    let cancelled = false;

    async function poll() {
      const settings = getStoreSettings();
      if (!settings.kitchenPrinter && !settings.counterPrinter) return; // nothing configured to print to

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
            const label = `New order #${claimed.dailyOrderNumber ?? claimed.id.slice(-4)}`;
            await dispatchKitchenPrints(
              claimed.items,
              categoryLookupRef.current,
              settings,
              async (groupItems, printerName, groupLabel) => {
                const printPromise = ipc.invoke('print-kitchen-receipt-data', { ...claimed, items: groupItems }, printerName, printLogo, settings);
                reportPrintOutcome(printPromise, `${label} ${groupLabel.toLowerCase()}`, toastRef.current);
                await printPromise.catch(() => {});
              },
            );
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

// A customer receipt (DineIn, TakeAway, or Delivery - no exceptions) is
// never auto-printed anywhere in this app, including for an order
// completed from a phone (which has no printer of its own) - it's always
// a deliberate, on-demand action via the printer icon / Print Receipt
// button on the order detail card (see SalesPage.tsx/RecordPage.tsx).
// There used to be a ReceiptPrintWatcher here, sibling to
// KitchenPrintWatcher above, that polled orderController.js's
// getUnprintedReceiptOrders and auto-printed - removed entirely, not just
// disabled, since leaving it running with nothing left to legitimately
// auto-print would be dead weight (and a latent footgun if that backend
// route's filters ever changed again).

// Sibling to KitchenPrintWatcher above, for edits made
// to an order AFTER its original kitchen ticket already printed -
// kitchenPrintedAt only ever fires once per order, so an item added or a
// quantity bumped up later (via EditOrderPage.tsx's stepper/Quick Add, or
// pos-mobile's Order Detail screen, which has no printer of its own) needs
// its own notification. Backend queues just the increased quantity/new
// items in pendingKitchenUpdate (see getUnprintedKitchenUpdateOrders) -
// this prints exactly that delta, not the whole order, so the kitchen
// isn't told to re-make things they already started. SalesPage.tsx and
// EditOrderPage.tsx both claim+print this themselves the instant they make
// the edit on this till, so this watcher is really only needed for edits
// that came from a phone.
const KITCHEN_UPDATE_POLL_INTERVAL_MS = 1500; // see KITCHEN_POLL_INTERVAL_MS above

function KitchenUpdateWatcher({ categoryLookupRef }: { categoryLookupRef: React.MutableRefObject<Map<string, string>> }) {
  const { toast } = useToast();
  const inFlightRef = useRef<Set<string>>(new Set());
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer) return undefined;
    // Same reasoning as KitchenPrintWatcher above.
    const ipc = ipcRenderer;

    let cancelled = false;

    async function poll() {
      const settings = getStoreSettings();
      if (!settings.kitchenPrinter && !settings.counterPrinter) return; // nothing configured to print to

      let orders;
      try {
        orders = await fetchUnprintedKitchenUpdateOrders();
      } catch {
        return; // network hiccup - next tick retries
      }
      if (!orders || cancelled) return;

      const printLogo = typeof window !== 'undefined' ? localStorage.getItem('preferred-print-logo') : null;

      for (const order of orders) {
        if (cancelled) break;
        if (inFlightRef.current.has(order.id)) continue;
        inFlightRef.current.add(order.id);

        claimKitchenUpdatePrint(order.id)
          .then(async (claimed) => {
            if (!claimed || claimed.items.length === 0) return;
            const label = `Order #${claimed.order.dailyOrderNumber ?? claimed.order.id.slice(-4)}`;
            await dispatchKitchenPrints(
              claimed.items,
              categoryLookupRef.current,
              settings,
              async (groupItems, printerName, groupLabel) => {
                const printPromise = ipc.invoke('print-kitchen-receipt-data', { ...claimed.order, items: groupItems }, printerName, printLogo, settings);
                reportPrintOutcome(printPromise, `${label} ${groupLabel.toLowerCase()} update`, toastRef.current);
                await printPromise.catch(() => {});
              },
            );
          })
          .catch((err) => {
            if (!(err instanceof ApiError) || err.status !== 409) {
              console.error('Kitchen update auto-print failed:', err);
            }
          })
          .finally(() => {
            inFlightRef.current.delete(order.id);
          });
      }
    }

    void poll();
    const intervalId = setInterval(() => void poll(), KITCHEN_UPDATE_POLL_INTERVAL_MS);
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
  const { isOpen, session, loading, refresh, openLocally } = useShopSession();
  const { toast, confirm } = useToast();
  const canManage = hasPermission('shop.session.manage');
  const [busy, setBusy] = useState(false);
  const { isOnline } = useNetworkStatus();
  // Day-End Shop Closing Summary Sheet: "Close Restaurant" now opens this
  // review screen first instead of closing immediately - handleClose
  // itself (unresolved-orders confirmation, the actual close call, the
  // success toast) is unchanged and untouched, just triggered from the
  // modal's own confirm button now (see onConfirmClose below) instead of
  // straight off this button's onClick.
  const [showClosingSummary, setShowClosingSummary] = useState(false);

  async function handleOpen() {
    setBusy(true);
    try {
      if (isDesktopApp() && !isOnline) {
        // Same offline path as POSPage's "Open Restaurant" button - see
        // shop-session.tsx's openLocally() and offline-sync.ts's
        // reconciliation step for how this becomes a real ShopSession.
        openLocally();
        toast.success('Restaurant opened offline. Will sync once back online.');
        return;
      }
      await openShopSession();
      await refresh();
      toast.success('Restaurant opened. Orders can now be taken.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open restaurant.');
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
        // Sequence bug fix: this used to `await confirm(...)` right here,
        // which meant handleClose's own promise didn't resolve until the
        // cashier answered the Unresolved Orders dialog. That's harmless
        // when this button called handleClose directly, but the Day-End
        // Closing Summary sheet's own Confirm button (ShopClosingSummaryModal)
        // awaits this same handleClose (via onConfirmClose) and only
        // dismisses itself once that promise resolves - so that modal sat
        // frozen on "Closing..." for as long as the confirm dialog stayed
        // unanswered, and the confirm dialog itself was rendering underneath
        // that still-open modal the whole time (see toast.tsx's z-index
        // bump for the other half of that). Firing this off instead of
        // awaiting it lets handleClose (and therefore the summary modal)
        // return/dismiss the instant the pending-order check comes back,
        // while the Unresolved Orders dialog still opens and drives its own
        // "Close Anyway" -> handleClose(true) recursion independently.
        void confirm(
          `${orders.length} order${orders.length === 1 ? ' is' : 's are'} still pending or unpaid:\n\n${preview}${extra}\n\nClose the restaurant anyway? These orders stay in the system either way.`,
          { title: 'Unresolved orders', confirmText: 'Close Anyway', tone: 'danger' }
        ).then((confirmed) => {
          if (confirmed) void handleClose(true);
        });
        return;
      }

      await refresh();
      if (result.session) {
        const s = result.session.summary;
        toast.success(`Restaurant closed. ${s.orderCount} order${s.orderCount === 1 ? '' : 's'}, PKR ${s.totalSales.toLocaleString()} total sales.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to close restaurant.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="glass-pill h-7 w-28 animate-pulse rounded-full" />;
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        disabled={busy || !canManage}
        title={canManage ? 'Open the restaurant to start taking orders' : 'Only a Manager or Restaurant Owner can open the restaurant'}
        className="flex items-center gap-1.5 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-emerald-400 to-emerald-600 px-2.5 py-1.5 text-xs font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_8px_rgba(6,95,70,0.45)] transition-colors hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Store size={13} />
        {busy ? 'Opening...' : 'Open Restaurant'}
      </button>
    );
  }

  const openedTime = session?.openedAt ? new Date(session.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const liveCount = session?.liveSummary?.orderCount ?? 0;

  return (
    <div className="flex items-center gap-1.5">
      <div
        className="glass-pill flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-bold text-emerald-700"
        title={`Opened at ${openedTime}${session?.openedByName ? ` by ${session.openedByName}` : ''}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Open since {openedTime} · {liveCount} order{liveCount === 1 ? '' : 's'}
      </div>
      {canManage && (
        <button
          type="button"
          onClick={() => setShowClosingSummary(true)}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full border-[0.5px] border-white/40 bg-gradient-to-b from-rose-500 to-rose-700 px-2.5 py-1.5 text-xs font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-3px_8px_rgba(136,19,55,0.45)] transition-colors hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Lock size={13} />
          {busy ? 'Closing...' : 'Close Restaurant'}
        </button>
      )}
      {showClosingSummary && (
        <ShopClosingSummaryModal
          session={session}
          closing={busy}
          onClose={() => setShowClosingSummary(false)}
          onConfirmClose={() => handleClose(false)}
        />
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
      className={`glass-pill flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-bold transition-colors ${
        isOnline ? 'text-emerald-700' : 'text-rose-700'
      }`}
    >
      {isOnline ? <Wifi size={13} /> : <WifiOff size={13} />}
      <span className={checking ? 'opacity-60' : ''}>{isOnline ? 'Online' : 'Offline'}</span>
    </button>
  );
}

// A manual "run this till offline on purpose" switch - deliberately
// separate from NetworkStatusBadge above, which only ever reports the REAL
// connection state. Turning WiFi off entirely would be the obvious way to
// test/force offline mode, but it also kills this till's own LAN, which is
// exactly what a paired phone needs to reach the Local Hub for offline
// order-taking/pairing (see backend/localHub/) - so that "fix" breaks the
// very feature it's meant to test. This toggle fakes just the isOnline
// signal every page already reads (see network-status.ts's forcedOffline),
// leaving WiFi, the LAN, and the Local Hub completely untouched - a paired
// phone keeps working exactly as it would on a genuinely offline till.
//
// Desktop-app only: a plain browser tab has no Local Hub to fall back to
// at all, so forcing it "offline" would just break every page with
// nothing to show for it.
function OfflineModeToggle() {
  const { forcedOffline, toggleForcedOffline } = useNetworkStatus();
  if (!isDesktopApp()) return null;

  return (
    <button
      type="button"
      onClick={toggleForcedOffline}
      title={
        forcedOffline
          ? 'Offline Mode is ON - this till is treating itself as offline on purpose, even though WiFi/internet may still be connected. Click to go back online.'
          : "Manually put this till into offline mode without turning off WiFi - keeps phone pairing/the Local Hub working over your LAN while every page behaves as if there's no internet."
      }
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-bold transition-colors ${
        forcedOffline
          ? 'border-amber-300 bg-amber-100 text-amber-800'
          : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
      }`}
    >
      <WifiOff size={13} />
      {forcedOffline ? 'Offline Mode: ON' : 'Offline Mode'}
    </button>
  );
}

// Listens for main.js's electron-updater events (see setupAutoUpdater there)
// and surfaces them here - a quiet "Update Downloading..." pill while a new
// version is fetched in the background, then a "Restart to Update" button
// once it's ready to install. Renders nothing in a plain browser tab or
// while no update has been found, so it never clutters the normal topbar.
function UpdateStatusBadge() {
  const [status, setStatus] = useState<'idle' | 'downloading' | 'ready'>('idle');
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer) return undefined;

    const onAvailable = (_event: unknown, ...args: unknown[]) => {
      const info = args[0] as { version?: string } | undefined;
      setStatus('downloading');
      setVersion(info?.version ?? null);
    };
    const onDownloaded = (_event: unknown, ...args: unknown[]) => {
      const info = args[0] as { version?: string } | undefined;
      setStatus('ready');
      setVersion(info?.version ?? null);
    };

    ipcRenderer.on('app-update-available', onAvailable);
    ipcRenderer.on('app-update-downloaded', onDownloaded);

    return () => {
      ipcRenderer.removeListener('app-update-available', onAvailable);
      ipcRenderer.removeListener('app-update-downloaded', onDownloaded);
    };
  }, []);

  if (status === 'idle') return null;

  if (status === 'ready') {
    return (
      <button
        type="button"
        onClick={() => getIpcRenderer()?.send('install-app-update-now')}
        title={version ? `Version ${version} is downloaded - click to restart and install.` : 'Update downloaded - click to restart and install.'}
        className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-700 transition-colors hover:bg-emerald-100"
      >
        <RefreshCcw size={16} />
        Restart to Update
      </button>
    );
  }

  return (
    <div
      title={version ? `Downloading update ${version}...` : 'Downloading update...'}
      className="flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm font-bold text-sky-700"
    >
      <Download size={16} />
      Update Downloading...
    </div>
  );
}

function NavItem({
  icon,
  label,
  href,
  hotkey,
  active,
  onNavigate,
}: {
  icon: React.ReactNode;
  label: string;
  href?: string;
  hotkey?: string;
  active?: boolean;
  onNavigate?: () => void;
}) {
  const className = `flex items-center gap-2.5 rounded-full px-3 py-2.5 transition-all ${
    active
      ? 'border-[0.5px] border-white/50 bg-gradient-to-b from-[#eef7a0] to-[#d8e94a] font-bold text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-2px_6px_rgba(132,144,10,0.4)]'
      : 'text-gray-500 hover:bg-white/50'
  }`;

  // Visual Hotkey Badge Tag: a small bracketed [F1]-style chip pinned to
  // the right edge of the row (ml-auto on the label wrapper below pushes
  // it there regardless of label length) - subtle enough not to compete
  // with the label/icon, but always legible against either nav-item state
  // (the active item's own yellow-green gradient background needs a
  // darker/more opaque chip than the plain-text inactive rows do, or it'd
  // wash out).
  const badge = hotkey ? (
    <span
      className={`ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
        active ? 'bg-black/15 text-black/70' : 'bg-black/5 text-gray-400'
      }`}
    >
      {hotkey}
    </span>
  ) : null;

  if (!href) {
    return (
      <div className={`${className} cursor-default`}>
        {icon}
        <span className="flex min-w-0 flex-1 items-center text-sm">{label}</span>
        {badge}
      </div>
    );
  }

  return (
    <Link to={href} className={className} onClick={onNavigate}>
      {icon}
      <span className="flex min-w-0 flex-1 items-center text-sm">{label}</span>
      {badge}
    </Link>
  );
}

function TopAction({ icon, className = '' }: { icon: React.ReactNode; className?: string }) {
  return (
    <div className={`clickable glass-pill rounded-full p-1.5 text-gray-500 transition-colors hover:bg-white/70 ${className}`}>
      {icon}
    </div>
  );
}

// Real notification bell - replaces the old hardcoded "Bell icon + red 2
// badge" placeholder. Shows the live unread count, and a dropdown of every
// notification fired this session (table timer expiries, order saves,
// order completions - see lib/notifications.tsx). Only an order_saved row
// is clickable: within EDITABLE_WINDOW_MS of being saved it jumps straight
// to that order's Edit screen (Technical Requirement #3 - "before it
// cooks"), past that window it instead fires a "Time Over" notification
// and does NOT navigate, since the kitchen slip has already gone out.
// Every other kind (table_timer_expired, order_completed) is view-only in
// this history, per that same requirement.
function NotificationBellButton() {
  const navigate = useNavigate();
  const { notifications, unreadCount, markAllRead, notify } = useNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function toggleOpen() {
    setOpen((previous) => {
      const next = !previous;
      if (next) markAllRead();
      return next;
    });
  }

  // Only order_saved rows are clickable, jumping to Edit within the
  // 10-minute window (or firing "Time Over" past it). Table timers no
  // longer need a staff decision at all - an expiry auto-clears the table
  // by itself (see lib/notifications.tsx's poll), so table_timer_expired
  // rows, like order_completed/info, are purely informational history.
  function handleRowClick(notification: AppNotification) {
    if (notification.kind !== 'order_saved' || !notification.orderId) return;
    const withinWindow = Date.now() - notification.createdAt <= EDITABLE_WINDOW_MS;
    if (withinWindow) {
      setOpen(false);
      navigate(`/dashboard/sales/${notification.orderId}/edit`);
    } else {
      notify('info', "Time Over - this order already went to the kitchen and can no longer be edited from here.");
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-label="Notifications"
        className="clickable glass-pill rounded-full p-1.5 text-gray-500 transition-colors hover:bg-white/70"
      >
        <Bell size={15} />
      </button>
      {unreadCount > 0 ? (
        <span className="pointer-events-none absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white shadow-sm">
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      ) : null}
      {/* Always viewport-fixed (never `absolute` off the bell button itself)
          and anchored to the window's own top-right corner, not to
          wherever this button happens to land. The header's right-hand
          icon group (`flex flex-wrap`) can wrap onto its own line on a
          narrower window, and that wrapped line isn't right-aligned - so
          the bell button itself can end up sitting well left-of-center
          (see screenshot bug report). An `absolute right-0` panel anchored
          to that button would then extend left underneath the fixed,
          opaque sidebar, and because this panel is glass/backdrop-blur,
          the sidebar's own colors bled through visually looking like
          truncated/unreadable text on its left edge - not an actual clip,
          but just as unreadable. Anchoring to the viewport instead makes
          this panel's position completely independent of the trigger's
          layout position, so it can never overlap the sidebar at any
          window size. z-[400] clears both the sidebar (z-50) and the
          toast stack (z-[350]) with real margin. */}
      {open ? (
        <div className="glass-strong fixed inset-x-4 top-24 z-[400] max-h-[70vh] overflow-y-auto rounded-2xl p-2 sm:inset-x-auto sm:left-auto sm:right-4 sm:top-20 sm:w-80">
          <p className="px-3 py-2 text-xs font-black uppercase tracking-wide text-gray-500">Notifications</p>
          {notifications.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm font-bold text-gray-400">No notifications yet.</p>
          ) : (
            <div className="space-y-1">
              {notifications.map((notification) => {
                const isOrderSaved = notification.kind === 'order_saved';
                const isEditable = isOrderSaved && Date.now() - notification.createdAt <= EDITABLE_WINDOW_MS;
                return (
                  <button
                    key={notification.id}
                    type="button"
                    disabled={!isOrderSaved}
                    onClick={() => handleRowClick(notification)}
                    className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                      isOrderSaved ? 'cursor-pointer hover:bg-white/70' : 'cursor-default'
                    }`}
                  >
                    <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white shadow-inner ${NOTIFICATION_ICON_BG[notification.kind]}`}>
                      {NOTIFICATION_ICON[notification.kind]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold leading-snug text-gray-900">{notification.message}</p>
                      <p className="mt-0.5 text-[11px] font-bold text-gray-400">
                        {formatNotificationAge(notification.createdAt)}
                        {isOrderSaved ? (isEditable ? ' · Tap to edit' : ' · Edit window closed') : ''}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
