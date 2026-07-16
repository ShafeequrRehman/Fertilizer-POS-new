type IpcRendererLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  sendSync: (channel: string, ...args: unknown[]) => unknown;
};

type ElectronRequire = (moduleName: 'electron') => { ipcRenderer: IpcRendererLike };

// Shared accessor for Electron's ipcRenderer from a renderer-process
// module. Works because main.js creates BrowserWindows with
// `nodeIntegration: true, contextIsolation: false` - `window.require` is
// directly available, the same pattern already used throughout this app
// (POSPage.tsx/SalesPage.tsx's print calls, SettingsPage.tsx's
// get-printers). Returns null in any non-Electron context (a plain browser
// tab via `npm run dev:web`, or anywhere `window` doesn't exist at all) so
// callers can silently no-op instead of crashing.
export function getIpcRenderer(): IpcRendererLike | null {
  if (typeof window === 'undefined') return null;
  if (!navigator.userAgent.includes('Electron')) return null;
  try {
    const electronRequire = (window as unknown as { require?: ElectronRequire }).require;
    return electronRequire ? electronRequire('electron').ipcRenderer : null;
  } catch (err) {
    console.error('Failed to access Electron ipcRenderer:', err);
    return null;
  }
}
