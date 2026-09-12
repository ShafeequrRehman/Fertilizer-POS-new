// Minimal service worker whose only real job is to satisfy Chrome/Android's
// PWA install-eligibility checklist (a manifest alone isn't enough - Chrome
// also requires a registered service worker with a fetch handler before it
// will ever fire `beforeinstallprompt`). Registered from BOTH
// CustomerOrderPage.tsx AND site-wide from main.tsx (for the staff
// dashboard's own InstallAppButton, in the plain-browser-tab case -
// main.tsx explicitly skips this inside the Electron shell) - the comment
// that used to be here claiming this was customer-page-only was stale and
// wrong; every GET request on every page in a browser tab (dashboard
// included) now genuinely passes through this handler.
//
// Bug fix: this never caches anything proactively (no install-time
// caches.open().addAll(), and the old fetch handler below never called
// cache.put() either) - so `caches.match()` on a failed fetch always
// resolved to `undefined`, and `event.respondWith(undefined)` throws
// ("The FetchEvent for ... resulted in a network error response: the
// promise was resolved with an undefined value"), which turns an ordinary
// network hiccup on ANY request into a hard failure for whatever page made
// it - including the dashboard's own API calls, now that this runs
// site-wide. Simplified to a pure network passthrough: still satisfies
// Chrome's "a fetch handler exists" installability check, with no dead
// cache-fallback path left that can only ever crash and never actually
// help (nothing here has ever cached a response to fall back to).
const CACHE_NAME = "pos-order-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return; // Never intercept POSTs (order creation, payment gateway redirects, etc).
  event.respondWith(fetch(event.request));
});
