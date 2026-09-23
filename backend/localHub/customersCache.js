const store = require("./jsonStore");

// A read-through cache of this shop's Customer Dues ledger - the
// customers-list counterpart to orderCache.js (see that file's own
// comment for the full reasoning). Customer Dues (DuesPage.tsx) should
// never have to wait on a live cloud round trip just to show every
// customer's balance/history when the net is slow or down - it always
// reads this cache first (near-instant, local), and the till pushes a
// fresh snapshot down here whenever it successfully loads the ledger from
// the cloud - see pos-web/src/lib/offline-dues-helpers.ts's
// refreshCustomersCacheInBackground and DuesPage.tsx's cache-first load.

const CACHE_KEY = "customersCache";

function get() {
  return store.load(CACHE_KEY, { updatedAt: null, customers: [] });
}

function set(customers) {
  const snapshot = { updatedAt: new Date().toISOString(), customers: Array.isArray(customers) ? customers : [] };
  store.save(CACHE_KEY, snapshot);
  return snapshot;
}

module.exports = { get, set };
