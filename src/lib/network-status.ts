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

export function useNetworkStatus() {
  // The REAL, ping-based reachability - kept separate from the forced
  // override below so toggling "Offline Mode" off always correctly
  // reflects whatever the genuine connection state actually is again,
  // rather than getting stuck wherever it last was.
  const [realOnline, setRealOnline] = useState(true);
  const [checking, setChecking] = useState(false);
  const [forcedOffline, setForcedOfflineState] = useState(isForcedOffline);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      await api.get('/health', { timeout: PING_TIMEOUT_MS });
      setRealOnline(true);
    } catch {
      setRealOnline(false);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkNow();
    const intervalId = window.setInterval(() => void checkNow(), PING_INTERVAL_MS);

    // The browser's own "online"/"offline" events are a useful trigger to
    // re-check sooner than the next interval tick, but never trusted on
    // their own - checkNow() always does the real backend round-trip
    // before flipping the indicator.
    const handleOnline = () => void checkNow();
    const handleOffline = () => void checkNow();
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [checkNow]);

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
