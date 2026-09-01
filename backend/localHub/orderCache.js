const store = require("./jsonStore");

// A read-through cache of this shop's recent cloud orders - the
// order-list counterpart to referenceData.js's products/customers/staff
// snapshot. The whole point: Dashboard/Sales/Kitchen should never have to
// wait on a live cloud round trip just to show an order list (that's what
// was timing out even with a perfectly fine connection, once a shop had
// enough order history for the query to get slow - see orderController.js's
// getOrders `since` handling). Instead they always read this cache first
// (near-instant, local), and the till pushes a fresh snapshot down here
// whenever it successfully loads orders from the cloud - see
// pos-web/src/lib/offline-sync.ts's pushCurrentOrdersCache and
// SalesPage.tsx/DashboardPageClient.tsx/KitchenPage.tsx's cache-first load.

const CACHE_KEY = "orderCache";

function get() {
  return store.load(CACHE_KEY, { updatedAt: null, orders: [] });
}

function set(orders) {
  const snapshot = { updatedAt: new Date().toISOString(), orders: Array.isArray(orders) ? orders : [] };
  store.save(CACHE_KEY, snapshot);
  return snapshot;
}

module.exports = { get, set };
