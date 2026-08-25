// Minimal service worker whose only real job is to satisfy Chrome/Android's
// PWA install-eligibility checklist for CustomerOrderPage.tsx (a manifest
// alone isn't enough there - Chrome also requires a registered service
// worker with a fetch handler before it will ever fire
// `beforeinstallprompt`). Deliberately registered ONLY from
// CustomerOrderPage.tsx, not site-wide from main.tsx - the staff
// dashboard/Electron shell never touches this and its behavior is
// completely unchanged.
//
// Intentionally does NOT cache anything proactively (no install-time
// caches.open().addAll()) - this is not an offline-support layer, just the
// bare minimum to unlock installability, so there is no risk of a customer
// (or, if this somehow ever ran in the Electron shell, a staff member)
// seeing stale cached content. Every GET is tried on the network first;
// the cache fallback only matters once something has actually been cached,
// which nothing here does yet.
const CACHE_NAME = "pos-order-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return; // Never intercept POSTs (order creation, payment gateway redirects, etc).
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
