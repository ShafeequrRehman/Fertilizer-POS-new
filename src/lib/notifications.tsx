import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CheckCircle2, Clock, Save } from "lucide-react";
import { playToastSound } from "@/lib/audio-feedback";

// Real-time operational-event notification system - separate from the
// generic toast/popup/confirm system in lib/toast.tsx (that one stays for
// ad-hoc UI messages like validation errors). This one is for business
// events tracked with real history: an order being saved and an order
// being completed. Mounted once at the app root (see main.tsx) so it's
// live no matter which screen staff are on.
//
// No blocking pop-ups anywhere in this system by design - every one of
// these events surfaces ONLY as a stacked, auto-dismissing toast plus a
// bell-history entry.
//
// "table_timer_expired" is a retired notification kind (Dining Tables has
// been removed) - kept in the union/style maps below only so any
// still-referenced historical/leftover values don't break the TS build; it
// is never emitted anymore.
export type NotificationKind = "table_timer_expired" | "order_saved" | "order_completed" | "info";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  message: string;
  /** Date.now() at the moment this fired - drives both "2m ago" display and, for order_saved, the 10-minute edit window below. */
  createdAt: number;
  /** order_saved: the order to jump to Edit for, within EDITABLE_WINDOW_MS. Unused for every other kind. */
  orderId?: string;
}

// How long a saved order stays editable from the notification bell before
// it's considered "already gone to the kitchen" and locks.
export const EDITABLE_WINDOW_MS = 10 * 60 * 1000;

// How long a single toast stays on screen before auto-dismissing - the
// decreasing progress bar on each toast animates over exactly this long.
export const TOAST_DURATION_MS = 5000;

// How many past notifications the bell's history keeps - old enough
// entries just fall off the end rather than growing unbounded for a shop
// that's been open a long time. Session-only (React state), same as the
// existing toast system - not persisted across an app restart.
const HISTORY_LIMIT = 100;

interface NotifyMeta {
  orderId?: string;
  /**
   * If true, and staff aren't already on the POS screen, navigate there
   * right after this notification fires - the whole point of this system
   * being "take the next order immediately" (see POSPage.tsx's
   * handleSaveOrder and EditOrderPage.tsx's saveOrder, the only two
   * callers that set this).
   */
  navigateToPos?: boolean;
}

interface NotificationContextValue {
  /** Newest first. */
  notifications: AppNotification[];
  unreadCount: number;
  notify: (kind: NotificationKind, message: string, meta?: NotifyMeta) => void;
  /** Called when the bell dropdown opens - clears the red badge count. */
  markAllRead: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

let idCounter = 0;

// Shared per-kind icon + color so the toast stack and the bell history list
// never drift out of sync on what each kind looks like. Exported alongside
// the NotificationProvider component below (same trade-off toast.tsx's
// useToast() already makes) rather than split into a separate file purely
// to satisfy react-refresh - this module's Provider, hook, and small
// display helpers are meant to be read together.
// eslint-disable-next-line react-refresh/only-export-components
export const NOTIFICATION_ICON: Record<NotificationKind, ReactNode> = {
  table_timer_expired: <Clock size={16} />,
  order_saved: <Save size={16} />,
  order_completed: <CheckCircle2 size={16} />,
  info: <Clock size={16} />,
};

// eslint-disable-next-line react-refresh/only-export-components
export const NOTIFICATION_ICON_BG: Record<NotificationKind, string> = {
  table_timer_expired: "bg-gradient-to-br from-rose-400 to-rose-600",
  order_saved: "bg-gradient-to-br from-sky-400 to-sky-600",
  order_completed: "bg-gradient-to-br from-emerald-400 to-emerald-600",
  info: "bg-gradient-to-br from-slate-400 to-slate-600",
};

// "2m ago" / "1h 4m ago" - short, matches the same style used elsewhere in
// this app (SalesPage.tsx's age()) rather than a full timestamp, since the
// bell list is meant to be scanned quickly.
// eslint-disable-next-line react-refresh/only-export-components
export function formatNotificationAge(createdAt: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - createdAt) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const pathnameRef = useRef(location.pathname);
  useEffect(() => {
    pathnameRef.current = location.pathname;
  }, [location.pathname]);

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // Per-toast auto-dismiss timers, keyed by notification id - cleared
  // individually if a toast is dismissed early (X button) and all cleared
  // on unmount so none fire against an unmounted tree.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((previous) => previous.filter((item) => item.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const notify = useCallback((kind: NotificationKind, message: string, meta?: NotifyMeta) => {
    const item: AppNotification = {
      id: `notif-${Date.now()}-${++idCounter}`,
      kind,
      message,
      createdAt: Date.now(),
      orderId: meta?.orderId,
    };
    // History: newest first, capped.
    setNotifications((previous) => [item, ...previous].slice(0, HISTORY_LIMIT));
    setUnreadCount((previous) => previous + 1);
    // Toast stack: newest prepended too, so it renders on top of the
    // stack (newest-on-top, queue style).
    setToasts((previous) => [item, ...previous]);
    const timer = setTimeout(() => {
      setToasts((previous) => previous.filter((existing) => existing.id !== item.id));
      timersRef.current.delete(item.id);
    }, TOAST_DURATION_MS);
    timersRef.current.set(item.id, timer);
    // Global UI Audio Feedback System: every real-time notification (bell
    // history + its own toast stack, both set above) funnels through this
    // one notify() call, so this is the single place that needs to play
    // the Toast/Notification Sound for this system (separate from
    // toast.tsx's own push(), which covers its own toast/popup/confirm
    // system - the two are independent notification mechanisms in this
    // app, see this file's own header comment).
    playToastSound();

    if (meta?.navigateToPos && pathnameRef.current !== "/dashboard/pos") {
      navigate("/dashboard/pos");
    }
  }, [navigate]);

  const markAllRead = useCallback(() => setUnreadCount(0), []);

  const value = useMemo<NotificationContextValue>(
    () => ({ notifications, unreadCount, notify, markAllRead }),
    [notifications, unreadCount, notify, markAllRead],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}

      {/* Stacked toast bar - sticky for its whole TOAST_DURATION_MS
          lifetime, newest card on top. Full-width-with-margins on phone
          widths so a long message never overflows the screen; anchored to
          the top-right with a capped width from tablet width (sm) up. */}
      <div className="pointer-events-none fixed inset-x-4 top-24 z-[350] flex flex-col gap-2.5 sm:inset-x-auto sm:right-4 sm:top-20 sm:w-full sm:max-w-sm">
        {toasts.map((item) => (
          <NotificationToastCard
            key={item.id}
            notification={item}
            onDismiss={() => dismissToast(item.id)}
          />
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

function NotificationToastCard({
  notification,
  onDismiss,
}: {
  notification: AppNotification;
  onDismiss: () => void;
}) {
  // Two-phase render trick (mount at 100% width, flip to 0% one frame
  // later) so the CSS width transition actually animates instead of
  // snapping straight to 0 - same reasoning any CSS-transition-driven
  // progress bar needs, since a transition never fires on a value's very
  // first paint.
  const [shrink, setShrink] = useState(false);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setEntered(true);
      setShrink(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`glass-strong pointer-events-auto relative overflow-hidden rounded-2xl p-3.5 shadow-lg transition-all duration-300 ${
        entered ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_2px_6px_rgba(0,0,0,0.25)] ${NOTIFICATION_ICON_BG[notification.kind]}`}>
          {NOTIFICATION_ICON[notification.kind]}
        </div>
        <p className="min-w-0 flex-1 pt-1 text-sm font-bold leading-snug text-gray-900">{notification.message}</p>
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onDismiss(); }}
          aria-label="Dismiss notification"
          className="shrink-0 rounded-full p-1 text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-700"
        >
          &times;
        </button>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1 bg-black/10">
        <div
          className="h-full bg-[#8FA6D6] transition-[width] ease-linear"
          style={{ width: shrink ? "0%" : "100%", transitionDuration: `${TOAST_DURATION_MS}ms` }}
        />
      </div>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) throw new Error("useNotifications must be used within a NotificationProvider");
  return context;
}
