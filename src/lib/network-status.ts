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

export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(true);
  const [checking, setChecking] = useState(false);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      await api.get('/health', { timeout: PING_TIMEOUT_MS });
      setIsOnline(true);
    } catch {
      setIsOnline(false);
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

  return { isOnline, checking, checkNow };
}
