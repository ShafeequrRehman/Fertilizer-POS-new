// Shared table-timer math, used by both POSPage.tsx (table grid lock +
// countdown display) and TableTimerAlertWatcher.tsx (the real-time
// Dashboard-wide expiry popup), so the two never drift out of sync on what
// "expired" means for a given order.
//
// A table's timer is no longer a silent auto-unlock: once a Dine-In order's
// turnover window elapses, the table stays locked (occupied) until staff
// explicitly act on the real-time alert - either "Clear Table" (frees it
// immediately) or "Extend +10 Minutes" (pushes the deadline back and lets
// the countdown keep running). See backend/controllers/orderController.js
// createOrder's occupancy check, which enforces the same "still pending and
// not tableTimerCleared = still occupied" rule server-side.

import type { SavedOrder } from './pos-types';

export interface TableTimerOrder {
  createdAt: string;
  timerExtendedMinutes?: number;
  tableTimerCleared?: boolean;
}

// The effective countdown length for this specific order: the shop-wide
// turnover setting plus whatever 10-minute extensions staff have granted.
export function getEffectiveTurnoverMinutes(shopTurnoverMinutes: number, order: TableTimerOrder): number {
  return shopTurnoverMinutes + Number(order.timerExtendedMinutes || 0);
}

// Milliseconds left before this order's table timer expires. Negative once
// expired (still meaningful - callers use the sign, not just null/non-null,
// to tell "counting down" apart from "past due, awaiting a staff decision").
// Returns null only when the table has already been explicitly cleared.
export function getTableTimerRemainingMs(order: TableTimerOrder, shopTurnoverMinutes: number, now: number = Date.now()): number | null {
  if (order.tableTimerCleared) return null;
  const effectiveMinutes = getEffectiveTurnoverMinutes(shopTurnoverMinutes, order);
  return effectiveMinutes * 60 * 1000 - (now - new Date(order.createdAt).getTime());
}

// True the instant a table's window has elapsed and nobody has cleared or
// extended it since - this is exactly the moment the real-time alert
// (TableTimerAlertWatcher.tsx) should fire.
export function isTableTimerExpired(order: TableTimerOrder, shopTurnoverMinutes: number, now: number = Date.now()): boolean {
  const remaining = getTableTimerRemainingMs(order, shopTurnoverMinutes, now);
  return remaining !== null && remaining <= 0;
}

// A stable key that changes every time the order's extension count changes
// - used to let an alert be dismissed once per expiry, but re-fire if the
// same table expires again after being extended.
export function tableTimerAlertKey(order: Pick<SavedOrder, 'id'> & TableTimerOrder): string {
  return `${order.id}:${Number(order.timerExtendedMinutes || 0)}`;
}
