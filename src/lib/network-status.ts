import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

// `navigator.onLine` alone only reflects whether the OS network adapter
// thinks it has a link - it does NOT mean the backend is actually
// reachable, and it was reporting "offline" for shops whose internet was
// genuinely working fine (e.g. a VPN/adapter Windows considers "limited").
// This hook instead reads the backend's `/api/health` route (see
// backend/index.js + backend/config/connectivityMonitor.js), which itself
// continuously pings MongoDB Atlas in the background every 5s - polling at
// the same 5s cadence here means the badge reflects a genuinely fresh
// result, not a stale cached one, and flips within a few seconds of the
// real connectivity state changing either way.
const PING_INTERVAL_MS = 5000;
const PING_TIMEOUT_MS = 4000;

// --- Manual "Offline Mode" override -------------------------------------
// Lets a shop owner deliberately put the till into offline mode (to test
// it, or to just run the whole shift offline on purpose) WITHOUT actually
// turning off WiFi. That distinction matters here specifically: the Local
// Hub (backend/localHub/) and phone pairing both run over this till's own
// LAN, completely independent of internet reachability - killing the WiFi
// adapter to simulate "offline" would ALSO cut off any paired phone,
// breaking the exact offline order-taking flow this app exists to support.
// This override only fakes the internet-reachability signal every page
// already reads via isOnline below; the network itself, and the Local Hub
// listening on it, are never touched.
const FORCE_OFFLINE_KEY = 'pos_force_offline_mode';
// Fired on every change (including from the same tab, where the browser's
// own native `storage` event never fires) so every other mounted
// useNetworkStatus() instance across the app - POSPage, SalesPage,
// RecordPage, the topbar badge, etc. - reflects a toggle flipped from any
// one of them, instantly, with no page reload needed.
const FORCE_OFFLINE_EVENT = 'pos-force-offline-changed';

export function isForcedOffline(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(FORCE_OFFLINE_KEY) === 'true';
}

export function setForcedOffline(value: boolean): void {
  if (typeof window === 'undefined') return;
  if (value) window.localStorage.setItem(FORCE_OFFLINE_KEY, 'true');
  else window.localStorage.removeItem(FORCE_OFFLINE_KEY);
  window.dispatchEvent(new Event(FORCE_OFFLINE_EVENT));
}

// --- Shared singleton ping loop -----------------------------------------
// Before this, every one of the ~13 call sites of useNetworkStatus() below
// (DashboardShell alone calls it 3 times, plus DashboardPageClient, plus
// whichever page is active - POSPage/SalesPage/RecordPage/etc. - plus
// offline-sync.ts's own internal use of it) ran its OWN independent 5s
// setInterval and its own /api/health request. On a single open POS
// screen that was 4-6 identical, simultaneous network round-trips every 5
// seconds for the exact same yes/no answer - pure redundant chatter, and
// 4-6x the re-renders whenever the result flipped. This module-level
// singleton runs exactly ONE ping loop no matter how many components call
// the hook at once; every hook instance just subscribes to its result.
// Reference-counted so the loop starts on first mount and stops the
// instant the last consumer unmounts, rather than running forever from
// module load (e.g. on the Login screen, before anything needs it).
type NetworkListener = (online: boolean, checking: boolean) => void;
const listeners = new Set<NetworkListener>();
let sharedRealOnline = true;
let sharedChecking = false;
let sharedIntervalId: number | null = null;
let sharedOnlineHandler: (() => void) | null = null;
let sharedOfflineHandler: (() => void) | null = null;

function notifyListeners() {
  listeners.forEach((listener) => listener(sharedRealOnline, sharedChecking));
}

async function sharedCheckNow(): Promise<void> {
  sharedChecking = true;
  notifyListeners();
  try {
    await api.get('/health', { timeout: PING_TIMEOUT_MS });
    sharedRealOnline = true;
  } catch {
    sharedRealOnline = false;
  } finally {
    sharedChecking = false;
    notifyListeners();
  }
}

function subscribeToNetworkStatus(listener: NetworkListener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void sharedCheckNow();
    sharedIntervalId = window.setInterval(() => void sharedCheckNow(), PING_INTERVAL_MS);
    // Same reasoning as before: the browser's "online"/"offline" events are
    // a useful trigger to re-check sooner than the next interval tick, but
    // never trusted on their own - sharedCheckNow() always does the real
    // backend round-trip before flipping the indicator.
    sharedOnlineHandler = () => void sharedCheckNow();
    sharedOfflineHandler = () => void sharedCheckNow();
    window.addEventListener('online', sharedOnlineHandler);
    window.addEventListener('offline', sharedOfflineHandler);
  } else {
    // A late subscriber (e.g. a modal mounted well after the app loaded)
    // gets the current known state immediately instead of defaulting to
    // `true` until the next shared tick happens to land.
    listener(sharedRealOnline, sharedChecking);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && sharedIntervalId !== null) {
      window.clearInterval(sharedIntervalId);
      sharedIntervalId = null;
      if (sharedOnlineHandler) window.removeEventListener('online', sharedOnlineHandler);
      if (sharedOfflineHandler) window.removeEventListener('offline', sharedOfflineHandler);
      sharedOnlineHandler = null;
      sharedOfflineHandler = null;
    }
  };
}

export function useNetworkStatus() {
  // The REAL, ping-based reachability - kept separate from the forced
  // override below so toggling "Offline Mode" off always correctly
  // reflects whatever the genuine connection state actually is again,
  // rather than getting stuck wherever it last was.
  const [realOnline, setRealOnline] = useState(sharedRealOnline);
  const [checking, setChecking] = useState(sharedChecking);
  const [forcedOffline, setForcedOfflineState] = useState(isForcedOffline);

  // Delegates to the single shared loop above instead of running its own -
  // this also means a manual retry from ANY one instance (e.g. a "Retry"
  // button in the topbar badge) now correctly updates every other mounted
  // instance too, not just the one that was clicked.
  const checkNow = useCallback(() => sharedCheckNow(), []);

  useEffect(() => {
    return subscribeToNetworkStatus((online, isChecking) => {
      setRealOnline(online);
      setChecking(isChecking);
    });
  }, []);

  useEffect(() => {
    const syncForcedOffline = () => setForcedOfflineState(isForcedOffline());
    window.addEventListener(FORCE_OFFLINE_EVENT, syncForcedOffline);
    // Still worth listening for the native event too - covers another
    // BROWSER TAB/WINDOW toggling it (native `storage` only ever fires
    // cross-tab anyway, never same-tab, which is exactly why
    // FORCE_OFFLINE_EVENT above exists for the same-tab case).
    window.addEventListener('storage', syncForcedOffline);
    return () => {
      window.removeEventListener(FORCE_OFFLINE_EVENT, syncForcedOffline);
      window.removeEventListener('storage', syncForcedOffline);
    };
  }, []);

  const toggleForcedOffline = useCallback(() => {
    setForcedOffline(!isForcedOffline());
  }, []);

  return {
    isOnline: realOnline && !forcedOffline,
    checking,
    checkNow,
    forcedOffline,
    toggleForcedOffline,
  };
}
