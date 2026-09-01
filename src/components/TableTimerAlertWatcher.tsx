import { useEffect, useMemo, useState } from "react";
import { AlarmClockOff, Clock3, X } from "lucide-react";
import { clearOrderTableTimer, extendOrderTableTimer, fetchOrders, fetchTableSettings } from "@/lib/pos-api";
import { SavedOrder } from "@/lib/pos-types";
import { isTableTimerExpired, tableTimerAlertKey } from "@/lib/table-timer";
import { hasPermission } from "@/lib/auth";
import { useToast } from "@/lib/toast";

// Real-time, Dashboard-wide table-timer alert. Mounted once in
// DashboardShell.tsx (so it's live no matter which dashboard page staff
// happen to be looking at), this polls every few seconds for still-pending
// Dine-In orders whose table turnover window has elapsed, and puts up a
// blocking popup the moment one crosses that line - staff then explicitly
// choose to "Clear Table" (frees it immediately, everywhere) or "Extend +10
// Minutes" (pushes the deadline back and keeps the table locked). This
// replaces the old silent "grace period" auto-unlock: an order that's
// genuinely still active should never have its table quietly reopened
// under it.
const POLL_MS = 6000;

function orderNumber(order: SavedOrder) {
  return String(order.dailyOrderNumber ?? order.id.slice(-4)).padStart(3, "0");
}

function elapsedLabel(createdAt: string) {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} hr ${mins % 60} min`;
}

export default function TableTimerAlertWatcher() {
  // Same gate as POS/Sales access - only staff who actually work orders and
  // tables need this popup interrupting their screen.
  const canWatch = hasPermission("sales.create");
  const { toast } = useToast();
  const [turnoverMinutes, setTurnoverMinutes] = useState(45);
  const [expiredOrders, setExpiredOrders] = useState<SavedOrder[]>([]);
  // Alert keys (order id + its current extension count - see
  // tableTimerAlertKey) the staff has already dismissed with the X, so a
  // dismissed alert doesn't immediately reopen on the very next poll. A
  // fresh expiry (a new extension that itself later runs out) gets a new
  // key and alerts again like normal.
  const [acknowledgedKeys, setAcknowledgedKeys] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<"clear" | "extend" | null>(null);

  useEffect(() => {
    if (!canWatch) return;
    let cancelled = false;

    async function poll() {
      try {
        const [orders, settings] = await Promise.all([
          fetchOrders({ status: "pending", orderType: "DineIn" }),
          fetchTableSettings(),
        ]);
        if (cancelled) return;
        const minutes = settings?.tableTurnoverMinutes || 45;
        setTurnoverMinutes(minutes);
        const expired = (orders ?? [])
          .filter((order) => order.table && !order.tableTimerCleared && isTableTimerExpired(order, minutes))
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        setExpiredOrders(expired);
      } catch (error) {
        // Non-blocking - the alert just skips this cycle; the next poll
        // (or a page it's mounted on remounting) retries. Table selection
        // itself is still separately protected server-side in
        // orderController.createOrder regardless of whether this alert
        // ever fires.
        console.error("Failed to poll table timers for the real-time alert:", error);
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [canWatch]);

  const activeAlert = useMemo(
    () => expiredOrders.find((order) => !acknowledgedKeys.has(tableTimerAlertKey(order))) ?? null,
    [expiredOrders, acknowledgedKeys]
  );

  const queueCount = useMemo(
    () => expiredOrders.filter((order) => !acknowledgedKeys.has(tableTimerAlertKey(order))).length,
    [expiredOrders, acknowledgedKeys]
  );

  if (!canWatch || !activeAlert) return null;

  function dismiss(order: SavedOrder) {
    setAcknowledgedKeys((previous) => {
      const next = new Set(previous);
      next.add(tableTimerAlertKey(order));
      return next;
    });
  }

  async function handleClear() {
    if (!activeAlert) return;
    setBusyAction("clear");
    try {
      await clearOrderTableTimer(activeAlert.id);
      toast.success(`Table ${activeAlert.table} cleared - it's available for a new order now.`);
      setExpiredOrders((previous) => previous.filter((order) => order.id !== activeAlert.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to clear the table.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleExtend() {
    if (!activeAlert) return;
    setBusyAction("extend");
    try {
      await extendOrderTableTimer(activeAlert.id);
      toast.success(`Table ${activeAlert.table}'s timer extended by 10 minutes.`);
      setExpiredOrders((previous) => previous.filter((order) => order.id !== activeAlert.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to extend the table timer.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="glass-overlay fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="glass-strong relative w-full max-w-sm rounded-[28px] p-6 text-center">
        <button
          type="button"
          onClick={() => dismiss(activeAlert)}
          aria-label="Dismiss for now"
          className="glass-pill absolute right-4 top-4 rounded-full p-2 text-gray-500 transition hover:bg-white/70"
        >
          <X size={16} />
        </button>

        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-rose-400 to-rose-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_8px_18px_-6px_rgba(0,0,0,0.35)]">
          <AlarmClockOff size={26} className="text-white" />
        </div>

        <h3 className="text-lg font-black text-slate-900">Table {activeAlert.table} Timer Expired</h3>
        <p className="mt-1 flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-400">
          <Clock3 size={13} /> Order #{orderNumber(activeAlert)} &middot; open {elapsedLabel(activeAlert.createdAt)}
        </p>
        <p className="mt-3 whitespace-pre-line text-sm font-bold leading-relaxed text-slate-600">
          This table's {turnoverMinutes}-minute limit has passed and the order is still active. Check the table, then clear it
          for a new order or give it 10 more minutes.
        </p>

        {queueCount > 1 ? (
          <p className="mt-2 text-[11px] font-bold uppercase tracking-wide text-amber-600">+{queueCount - 1} more table{queueCount - 1 === 1 ? "" : "s"} waiting</p>
        ) : null}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void handleExtend()}
            disabled={busyAction !== null}
            className="glass-dark rounded-2xl py-3.5 text-sm font-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === "extend" ? "Extending..." : "Extend +10 Min"}
          </button>
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={busyAction !== null}
            className="rounded-2xl border-[0.5px] border-white/40 bg-gradient-to-b from-emerald-400 to-emerald-600 py-3.5 text-sm font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-3px_8px_rgba(6,95,70,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === "clear" ? "Clearing..." : "Clear Table"}
          </button>
        </div>
      </div>
    </div>
  );
}
