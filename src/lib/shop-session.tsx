import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchShopSessionStatus } from "@/lib/pos-api";
import { ShopSession } from "@/lib/pos-types";
import { isDesktopApp } from "@/lib/api";
import { syncOrderCounter, resetLocalOrderCounter, syncLifetimeCounter } from "@/lib/local-hub-api";

// Shared "is the shop open" state for everything under the shop dashboard -
// the Open/Close Shop button in DashboardShell's topbar and the POS screen
// (which refuses to start new orders while closed, mirroring the backend
// check in orderController.createOrder) both read from this one place so
// they can never disagree with each other.
//
// This is also the piece that makes restarting the till while offline
// usable at all: fetchShopSessionStatus() is a cloud call, so with no
// internet it would otherwise fail and leave the till stuck showing
// "shop closed" with no way to open it (Open Shop is a cloud call too).
// CACHE_KEY below is a write-through cache of the last known status,
// consulted whenever the real fetch fails - and openLocally() lets Open
// Shop itself work offline, recording a locally-opened session that the
// sync engine (lib/offline-sync.ts) turns into a real cloud ShopSession
// the moment the till is back online.
const CACHE_KEY = "pos_shop_session_cache";
const PENDING_OPEN_KEY = "pos_shop_session_pending_open";

interface CachedStatus {
  isOpen: boolean;
  session: ShopSession | null;
}

function readCache(): CachedStatus | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedStatus) : null;
  } catch {
    return null;
  }
}

function writeCache(value: CachedStatus) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
}

// True once Open Shop has been tapped while offline and hasn't synced to
// the cloud yet - lib/offline-sync.ts checks this before importing any
// queued orders, since the cloud needs a real open ShopSession to assign
// them real dailyOrderNumbers.
export function hasPendingLocalShopOpen(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PENDING_OPEN_KEY) === "true";
}

export function clearPendingLocalShopOpen() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PENDING_OPEN_KEY);
}

interface ShopSessionContextValue {
  isOpen: boolean;
  session: ShopSession | null;
  loading: boolean;
  /** True when the shown status came from the local cache, not a fresh server response - only ever happens offline. */
  isCached: boolean;
  refresh: () => Promise<void>;
  /** Opens the shop locally when there's no internet to reach the real Open Shop endpoint - see hasPendingLocalShopOpen. */
  openLocally: () => void;
}

const ShopSessionContext = createContext<ShopSessionContextValue | null>(null);

export function ShopSessionProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [session, setSession] = useState<ShopSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [isCached, setIsCached] = useState(false);

  const refresh = useCallback(async () => {
    // Paint instantly from whatever this till last knew, before ever
    // waiting on the network - the live fetch below still runs and
    // corrects this a moment later, but nothing should ever sit on a
    // blank/loading screen for up to AXIOS_REQUEST_TIMEOUT_MS (8s) just to
    // show what it already knew. Only meaningful inside the desktop app -
    // see the catch branch below for why a plain browser tab doesn't get
    // this treatment.
    if (isDesktopApp()) {
      const cached = readCache();
      if (cached) {
        setIsOpen(cached.isOpen || hasPendingLocalShopOpen());
        setSession(cached.session);
        setIsCached(true);
        setLoading(false);
      }
    }

    try {
      const result = await fetchShopSessionStatus();
      if (result) {
        // Tr# / shopSequenceNumber's counter - unlike orderCounter below,
        // this is present in the response regardless of isOpen (it lives on
        // the Shop document, not the session), and never resets, so it's
        // reconciled here unconditionally rather than only in the isOpen
        // branch. See local-hub-api.ts's syncLifetimeCounter.
        if (isDesktopApp()) {
          void syncLifetimeCounter(result.shopSequenceCounter ?? 0);
        }
        if (result.isOpen) {
          // Cloud confirms open - whether from a normal online Open Shop
          // or because offline-sync.ts already reconciled a pending local
          // open, this is now the authoritative state.
          setIsOpen(true);
          setSession(result.session);
          setIsCached(false);
          clearPendingLocalShopOpen();
          writeCache({ isOpen: true, session: result.session });
          // Every time this till genuinely confirms the cloud's current
          // session + counter, hand it to the Local Hub so its own offline
          // counter stays one seamless sequence with the cloud's - see
          // local-hub-api.ts's syncOrderCounter. Best-effort/fire-and-forget:
          // this is a background reconciliation, never something a cashier
          // waits on.
          if (isDesktopApp() && result.session) {
            void syncOrderCounter(result.session.id, result.session.orderCounter ?? 0);
          }
        } else if (hasPendingLocalShopOpen()) {
          // Connectivity is back but the sync engine hasn't reconciled the
          // locally-opened shop with the cloud yet (it ticks every 5
          // minutes - see offline-sync.ts). Keep showing the local
          // pending-open state instead of flipping back to "closed" out
          // from under whoever's using the till right now.
        } else {
          setIsOpen(false);
          setSession(result.session);
          setIsCached(false);
          writeCache({ isOpen: false, session: result.session });
        }
      }
    } catch (error) {
      console.error("Failed to fetch shop session status", error);
      // Only meaningful inside the desktop app - a plain browser tab has
      // no offline order-taking path anyway, so falling back to a stale
      // cache there would just be confusing rather than useful.
      if (isDesktopApp()) {
        const cached = readCache();
        if (cached) {
          setIsOpen(cached.isOpen);
          setSession(cached.session);
          setIsCached(true);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const openLocally = useCallback(() => {
    const localSession: ShopSession = {
      id: "local-pending",
      status: "open",
      openedAt: new Date().toISOString(),
      openedByName: "",
      closedAt: null,
      closedByName: "",
      closedWithUnpaidOrders: false,
      summary: { orderCount: 0, cancelledCount: 0, totalSales: 0, totalPaid: 0, totalDue: 0, paymentBreakdown: { Cash: 0, Card: 0, "E-Wallet": 0 } },
    };
    setIsOpen(true);
    setSession(localSession);
    setIsCached(true);
    if (typeof window !== "undefined") window.localStorage.setItem(PENDING_OPEN_KEY, "true");
    writeCache({ isOpen: true, session: localSession });
    // This IS a new shift starting, right now, even though it's offline -
    // reset the Local Hub's own order counter immediately so the very
    // first offline order of this new shift gets #1, instead of wrongly
    // continuing whatever number the previous (now-closed) shift left off
    // at. See local-hub-api.ts's resetLocalOrderCounter for why this can't
    // just wait for the next time this till talks to the cloud.
    void resetLocalOrderCounter();
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ShopSessionContext.Provider value={{ isOpen, session, loading, isCached, refresh, openLocally }}>
      {children}
    </ShopSessionContext.Provider>
  );
}

export function useShopSession() {
  const ctx = useContext(ShopSessionContext);
  if (!ctx) {
    throw new Error("useShopSession must be used within a ShopSessionProvider");
  }
  return ctx;
}

// --- Business-day window (single source of truth) --------------------
//
// A "day" throughout this app is exactly one shop shift (Open Shop ->
// Close Shop), never a fixed calendar/clock window - a shift that runs
// past midnight must keep counting as the SAME day instead of getting
// split into two, so two shifts' orders never wrongly get merged and one
// shift's orders never wrongly get split apart. Dashboard, Record, and
// Sales all need this exact same "which orders count as today's" answer,
// and previously each page reimplemented the window math and the order
// filter separately (with a subtle drift between them - one page used an
// exclusive end comparison, the others inclusive) - a real source of the
// "orders don't merge the same way everywhere" symptom, on top of the
// (separately fixed) duplicate-open-session bug that could make different
// pages disagree about which session is even "current" in the first
// place. Centralizing both here means every page is now guaranteed to
// agree, always.
//
// The end boundary is inclusive ([openedAt, now-or-closedAt], using <=)
// specifically to match how the backend computes a session's own summary
// at close time (see backend/controllers/shopSessionController.js -
// buildUnresolvedQuery/closeSession both use $gte openedAt / $lte
// closedAt) - so the numbers shown here never quietly disagree with what
// the shop actually got charged/paid for that shift.
export interface BusinessWindow {
  start: Date;
  end: Date;
  /** True while the shift backing this window is still open (numbers update live). */
  isOpen: boolean;
  /** False when the shop has never been opened at all - nothing to count yet. */
  hasSession: boolean;
}

export function getBusinessWindow(session: ShopSession | null, now: Date): BusinessWindow {
  if (!session) {
    return { start: now, end: now, isOpen: false, hasSession: false };
  }

  const start = new Date(session.openedAt);
  const isOpen = session.status === "open";
  const end = isOpen ? now : new Date(session.closedAt as string);

  return { start, end, isOpen, hasSession: true };
}

// The ONE place "is this order part of today's business window" is
// decided - every page that needs "today's orders" should filter through
// this instead of writing its own comparison.
export function filterOrdersInBusinessWindow<T extends { createdAt: string }>(
  orders: T[],
  window: BusinessWindow,
): T[] {
  if (!window.hasSession) return [];
  return orders.filter((order) => {
    const createdAt = new Date(order.createdAt);
    return createdAt >= window.start && createdAt <= window.end;
  });
}

// --- Picking a PAST business day by calendar date ---------------------
//
// Record's date-range picker lets someone browse history by calendar date
// ("show me the 19th"), but a shift's own orders can legitimately carry
// createdAt timestamps on the NEXT calendar date (an 11pm-to-3am shift).
// A naive midnight-to-midnight window for the picked date would therefore
// miss part of - or wrongly split - that shift's orders, exactly the bug
// this whole file exists to prevent for "today". The fix: a shift belongs
// to whichever calendar date it OPENED on, full stop - so picking a date
// means "find every shift that opened on this date and show its complete
// window (open -> close), not "find every order stamped with this date".
export function getSessionDateKey(session: ShopSession): string {
  const opened = new Date(session.openedAt);
  const year = opened.getFullYear();
  const month = String(opened.getMonth() + 1).padStart(2, "0");
  const day = String(opened.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Picking a date (or range) can match more than one shift - e.g. two
// separate shifts that both opened on the same day, or several days'
// worth of shifts for a multi-day range - so this unions every matching
// shift's own window instead of collapsing them into one span (which
// would wrongly scoop up the gap between shifts too).
export function filterOrdersInBusinessWindows<T extends { createdAt: string }>(
  orders: T[],
  windows: BusinessWindow[],
): T[] {
  const active = windows.filter((window) => window.hasSession);
  if (active.length === 0) return [];
  return orders.filter((order) => {
    const createdAt = new Date(order.createdAt);
    return active.some((window) => createdAt >= window.start && createdAt <= window.end);
  });
}
