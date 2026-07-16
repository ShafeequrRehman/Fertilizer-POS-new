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
