import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/lib/toast';
import App from './App';
import './index.css';

console.log('main.tsx loaded');

// Last-resort safety net: if something throws OUTSIDE React's render cycle
// (e.g. a module-level crash while `@/store` or `@/App` is being imported,
// before ReactDOM.createRoot even runs), <ErrorBoundary> below never gets
// a chance to catch it - there's no React tree yet for it to wrap. These
// global listeners catch that case and paint a visible error directly into
// #root, instead of leaving the near-black dark-mode body background (see
// src/index.css) as the only thing on screen.
function renderFatalError(message: string, stack?: string) {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `
    <div style="min-height:100vh;background:#fff5f5;color:#7f1d1d;font-family:monospace;padding:24px;overflow:auto;">
      <h1 style="font-size:20px;font-weight:700;margin-bottom:12px;">The app failed to start</h1>
      <p style="margin-bottom:8px;"><strong>Message:</strong> ${message}</p>
      <pre style="white-space:pre-wrap;font-size:12px;">${stack || ''}</pre>
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
            <HashRouter>
              <ToastProvider>
                <App />
              </ToastProvider>
            </HashRouter>
          </Provider>
        </ErrorBoundary>
      </React.StrictMode>,
    );
  })
  .catch((error) => {
    console.error('[main.tsx] Failed to load store/App:', error);
    renderFatalError(error?.message || String(error), error?.stack);
  });
