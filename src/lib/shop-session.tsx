import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchShopSessionStatus } from "@/lib/pos-api";
import { ShopSession } from "@/lib/pos-types";

// Shared "is the shop open" state for everything under the shop dashboard -
// the Open/Close Shop button in DashboardShell's topbar and the POS screen
// (which refuses to start new orders while closed, mirroring the backend
// check in orderController.createOrder) both read from this one place so
// they can never disagree with each other.
interface ShopSessionContextValue {
  isOpen: boolean;
  session: ShopSession | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const ShopSessionContext = createContext<ShopSessionContextValue | null>(null);

export function ShopSessionProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [session, setSession] = useState<ShopSession | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchShopSessionStatus();
      if (result) {
        setIsOpen(result.isOpen);
        setSession(result.session);
      }
    } catch (error) {
      console.error("Failed to fetch shop session status", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ShopSessionContext.Provider value={{ isOpen, session, loading, refresh }}>
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
