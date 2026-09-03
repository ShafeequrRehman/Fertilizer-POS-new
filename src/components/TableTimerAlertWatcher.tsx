// DEPRECATED - no longer mounted anywhere. All of this component's logic
// (polling for expired table timers, the notification-bar entry, and the
// Clear Table / Extend Timer actions) has been moved into
// src/lib/notifications.tsx's NotificationProvider, which owns it
// app-wide alongside the rest of the notification system. That version
// replaced this component's automatic BLOCKING popup with an on-demand
// panel (NotificationProvider's openTableAlert), per the requirement that
// no pop-up ever appears unprompted - every table-timer expiry now
// surfaces only as a stacked, auto-dismissing toast plus a bell-history
// entry, and staff tap it to bring up Clear/Extend.
//
// Kept as an inert stub (rather than deleted) since this file lives in a
// workspace folder that doesn't allow silent deletes. Safe to remove
// entirely whenever that's convenient.
export default function TableTimerAlertWatcher() {
  return null;
}
