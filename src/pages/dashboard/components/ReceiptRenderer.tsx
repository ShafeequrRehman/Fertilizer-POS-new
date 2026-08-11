import { useEffect, useState } from 'react';
import { SavedOrder } from '@/lib/pos-types';
import { getStoreSettings, defaultSettings, StoreSettings } from '@/lib/pos-settings';
import ThermalReceipt from './ThermalReceipt';
import ItemizedBillReceipt from './ItemizedBillReceipt';
import KitchenKotReceipt from './KitchenKotReceipt';

// Picks which printed layout to render for this order, based on whatever
// the shop has chosen in Settings > Manage Receipt (see
// ReceiptManagementSection.tsx / pos-settings.ts's cashierReceiptTemplate
// and kitchenReceiptTemplate). Every print call site (PrintOrderPage.tsx,
// ReceiptPrintPage.tsx) renders through this one component instead of
// ThermalReceipt directly, so a template only ever needs to be wired up
// here once.
export default function ReceiptRenderer({
  order,
  type,
  logoSrc,
  previousDues = 0,
}: {
  order: SavedOrder;
  type: 'kitchen' | 'cashier';
  logoSrc?: string | null;
  previousDues?: number;
}) {
  const [settings, setSettings] = useState<StoreSettings>(defaultSettings);

  useEffect(() => {
    const sync = () => setSettings(getStoreSettings());
    sync();
    window.addEventListener('pos-settings-updated', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('pos-settings-updated', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  if (type === 'cashier' && settings.cashierReceiptTemplate === 'itemizedBill') {
    return <ItemizedBillReceipt order={order} logoSrc={logoSrc} previousDues={previousDues} />;
  }

  if (type === 'kitchen' && settings.kitchenReceiptTemplate === 'kot') {
    return <KitchenKotReceipt order={order} />;
  }

  return <ThermalReceipt order={order} type={type} logoSrc={logoSrc} previousDues={previousDues} />;
}
