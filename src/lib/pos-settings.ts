import { getIpcRenderer } from './electron-bridge';

export type StoreSettings = {
  storeName: string;
  businessEmail: string;
  storeAddress: string;
  currency: string;
  timezone: string;
  taxRate: number;
  dualScreenDisplay: boolean;
  autoPrintReceipts: boolean;
  kitchenPrinter?: string;
  counterPrinter?: string;
  businessStartTime: string;
  businessEndTime: string;
  receiptHeader?: string;
  receiptSubHeader?: string;
  receiptAddress?: string;
  receiptContact?: string;
  receiptPaymentInfo?: string;
  receiptFooterMessage?: string;
};

export const defaultSettings: StoreSettings = {
  storeName: "Vanguard Retail Center",
  businessEmail: "admin@vanguard.io",
  storeAddress: "782 Fintech Avenue, Silicon Valley, CA 94043",
  currency: "PKR (₨)",
  timezone: "Asia/Karachi",
  // No tax is added by default - the backend always computes tax as 0
  // unless a shop explicitly wants otherwise (see orderController.js's
  // recalculateTotals). This just keeps the POS cart's on-screen total in
  // sync with what actually gets charged.
  taxRate: 0,
  dualScreenDisplay: true,
  autoPrintReceipts: false,
  kitchenPrinter: "",
  counterPrinter: "",
  businessStartTime: "10:00",
  businessEndTime: "02:00",
  receiptHeader: "The Heaven Slice",
  receiptSubHeader: "Est. 2022",
  receiptAddress: "Gojra Road Near Ali Merriage Hall",
  receiptContact: "0300-0310275",
  receiptPaymentInfo: "0307 - 4798089 Jazzcash/EasyPaisa",
  receiptFooterMessage: "Thank You for your Order!",
};

// Chromium's localStorage for this app's packaged, file://-loaded
// production build was not reliably surviving an app restart - printer
// selections (kitchenPrinter/counterPrinter) and other settings would
// silently reset every time the app reopened. Settings are mirrored to a
// real file in Electron's userData directory (see main.js's
// save-app-settings / load-app-settings-sync handlers), which - unlike
// browser storage - always survives restarts. This hydration runs once, as
// soon as this module is first imported (very early, before any page calls
// getStoreSettings()), overwriting localStorage with whatever was last
// saved to disk so the two can never drift apart across a restart.
(function hydrateSettingsFromDisk() {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;
  try {
    const saved = ipcRenderer.sendSync('load-app-settings-sync');
    if (typeof saved === 'string' && saved) {
      localStorage.setItem('pos_store_settings', saved);
    }
  } catch (err) {
    console.error('Failed to hydrate settings from disk:', err);
  }
})();

export function getStoreSettings(): StoreSettings {
  if (typeof window === 'undefined') return defaultSettings;
  try {
    const saved = localStorage.getItem('pos_store_settings');
    if (saved) {
      return { ...defaultSettings, ...JSON.parse(saved) };
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
  return defaultSettings;
}

export function saveStoreSettings(settings: StoreSettings) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('pos_store_settings', JSON.stringify(settings));
    window.dispatchEvent(new Event('pos-settings-updated'));
  } catch (err) {
    console.error('Failed to save settings:', err);
  }

  const ipcRenderer = getIpcRenderer();
  if (ipcRenderer) {
    Promise.resolve(ipcRenderer.invoke('save-app-settings', settings)).catch((err: unknown) => {
      console.error('Failed to persist settings to disk:', err);
    });
  }
}

export const TIMEZONES = [
  "Pacific/Midway", "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Phoenix",
  "America/Denver", "America/Chicago", "America/New_York", "America/Halifax", "America/St_Johns",
  "America/Buenos_Aires", "America/Sao_Paulo", "Atlantic/South_Georgia", "Atlantic/Azores",
  "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin", "Europe/Rome",
  "Africa/Cairo", "Africa/Johannesburg", "Europe/Kyiv", "Europe/Moscow", "Europe/Istanbul",
  "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka", "Asia/Jakarta", "Asia/Bangkok",
  "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul", 
  "Australia/Perth", "Australia/Sydney", "Australia/Melbourne", "Pacific/Noumea", "Pacific/Auckland"
];

export const CURRENCIES = [
  "PKR (₨)", "USD ($)", "EUR (€)", "GBP (£)", "AUD (A$)", "CAD (C$)", 
  "AED (د.إ)", "SAR (﷼)", "INR (₹)", "BDT (৳)", "JPY (¥)", "CNY (¥)", "SGD (S$)"
];
