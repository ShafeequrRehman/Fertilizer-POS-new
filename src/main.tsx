import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/lib/toast';
import { NotificationProvider } from '@/lib/notifications';
import { LanguageProvider } from '@/i18n';
import { installGlobalClickSound } from '@/lib/audio-feedback';
import './index.css';

// NOTE: './App' is deliberately NOT statically imported up here anymore.
// It used to be (`import App from './App'`), alongside the SAME module
// also being dynamically import()'d below - which meant the dynamic
// import existed in name only: a static import evaluates (and can throw)
// as soon as THIS file's own module graph loads, before any of the code
// below ever runs, so the whole "catch a crash while loading App" premise
// of the dynamic import was silently defeated. Only the dynamic import
// below should ever pull in './App' now.
console.log('main.tsx loaded');

declare global {
  interface Window {
    __hideBootOverlay?: () => void;
  }
}

// Last-resort safety net: if something throws OUTSIDE React's render cycle
// (e.g. a module-level crash while `@/store` or `@/App` is being imported,
// before ReactDOM.createRoot even runs), <ErrorBoundary> below never gets
// a chance to catch it - there's no React tree yet for it to wrap. These
// global listeners catch that case and paint a visible error directly into
// #root, instead of leaving the near-black dark-mode body background (see
// src/index.css) as the only thing on screen.
function renderFatalError(message: string, stack?: string) {
  // The boot-loading overlay (index.html) sits ON TOP of #root by design
  // (see its z-index) so the app never shows a blank frame while it's
  // mounting - but that means it also has to be explicitly dismissed here,
  // or a fatal error written into #root would render invisibly behind it.
  window.__hideBootOverlay?.();
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `
    <div style="min-height:100vh;background:#fff5f5;color:#7f1d1d;font-family:monospace;padding:24px;overflow:auto;">
      <h1 style="font-size:20px;font-weight:700;margin-bottom:12px;">The app failed to start</h1>
      <p style="margin-bottom:8px;"><strong>Message:</strong> ${message}</p>
      <pre style="white-space:pre-wrap;font-size:12px;">${stack || ''}</pre>
      <button onclick="location.reload()" style="margin-top:16px;padding:8px 16px;border-radius:8px;border:1px solid #7f1d1d;background:#fff;color:#7f1d1d;font-family:sans-serif;font-weight:700;cursor:pointer;">Reload</button>
    </div>`;
}

window.addEventListener('error', (event) => {
  console.error('[main.tsx] Uncaught error before/during mount:', event.error || event.message);
  if (!document.getElementById('root')?.hasChildNodes()) {
    renderFatalError(event.message, event.error?.stack);
  }
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[main.tsx] Unhandled promise rejection:', event.reason);
});

// Dynamic import of the store + App so a throw during either module's
// top-level evaluation is caught here and rendered visibly, rather than
// aborting script execution silently.
Promise.all([import('@/store'), import('./App')])
  .then(([{ store }, { default: App }]) => {
    console.log('main.tsx: store + App modules loaded successfully, mounting...');

    // HashRouter (not BrowserRouter) is required here: the production
    // build is loaded by Electron from a `file://` URL with no server
    // able to rewrite deep-link paths on refresh, so routes live after
    // the `#` where the OS/Electron never sees them as a file path.
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ErrorBoundary>
          <Provider store={store}>
            <LanguageProvider>
              <HashRouter>
                <ToastProvider>
                  <NotificationProvider>
                    <App />
                  </NotificationProvider>
                </ToastProvider>
              </HashRouter>
            </LanguageProvider>
          </Provider>
        </ErrorBoundary>
      </React.StrictMode>,
    );

    // Global UI Audio Feedback System: one document-level click listener,
    // installed once here rather than per-page - see audio-feedback.ts's
    // own comment on why this needs zero changes to individual
    // button/card components anywhere else in the app.
    installGlobalClickSound();

    // React 18's createRoot().render() performs its initial commit
    // synchronously for the very first render, so by this point the app
    // has actually painted something real - safe to remove the boot
    // overlay now instead of leaving it up (or, worse, having removed it
    // earlier and shown a blank frame if mounting itself then failed).
    window.__hideBootOverlay?.();

    // Registers the same minimal, network-first service worker
    // CustomerOrderPage.tsx already uses (see public/sw.js) - site-wide
    // this time, not just for the customer ordering page, so the STAFF
    // dashboard itself becomes installable on a phone (Chrome/Android
    // requires a registered service worker with a fetch handler before it
    // will ever offer "Add to Home Screen" / fire beforeinstallprompt - see
    // DashboardShell.tsx's InstallAppButton, the thing that actually
    // prompts for this). Skipped entirely inside the Electron desktop
    // shell: service workers don't run under a file:// origin anyway, and
    // Electron has its own auto-updater (see UpdateStatusBadge) - there is
    // nothing for this to do there.
    const isElectronShell = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');
    if (!isElectronShell && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {
        // Non-fatal - the app still works fully as a plain web page, it
        // just won't offer the install prompt.
      });
    }
  })
  .catch((error) => {
    console.error('[main.tsx] Failed to load store/App:', error);
    renderFatalError(error?.message || String(error), error?.stack);
  });
