import { getIpcRenderer } from './electron-bridge';

export const PRINT_LOGO_STORAGE_KEY = 'preferred-print-logo';

// See pos-settings.ts's hydrateSettingsFromDisk for why this exists: the
// uploaded receipt logo is mirrored to a real file in Electron's userData
// directory (main.js's save-print-logo / load-print-logo-sync handlers)
// because localStorage alone was not reliably surviving an app restart in
// the packaged production build. Runs once, as soon as this module is
// first imported - before any page reads the logo out of localStorage.
(function hydratePrintLogoFromDisk() {
  if (typeof window === 'undefined') return;
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;
  try {
    const saved = ipcRenderer.sendSync('load-print-logo-sync');
    if (typeof saved === 'string') {
      if (saved) {
        window.localStorage.setItem(PRINT_LOGO_STORAGE_KEY, saved);
      } else {
        window.localStorage.removeItem(PRINT_LOGO_STORAGE_KEY);
      }
    }
    // saved === null means no disk record exists yet (fresh install) -
    // leave localStorage untouched in that case.
  } catch (err) {
    console.error('Failed to hydrate print logo from disk:', err);
  }
})();

export function persistPrintLogoToDisk(logo: string | null) {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;
  Promise.resolve(ipcRenderer.invoke('save-print-logo', logo ?? '')).catch((err: unknown) => {
    console.error('Failed to persist print logo to disk:', err);
  });
}
