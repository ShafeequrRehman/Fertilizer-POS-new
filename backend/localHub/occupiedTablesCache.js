const store = require("./jsonStore");

// A tiny, unbounded-by-date cache of which DineIn tables currently have a
// pending order - the occupied-tables counterpart to orderCache.js's much
// larger (14-day-bounded) order list snapshot. Kept as its own cache on
// purpose: orderCache.js's window exists to keep a shop's full order-list
// payload small, but that same window would wrongly let an old pending
// DineIn order (say, from last week, never completed/cancelled) look
// "free" again to a till that's currently offline - see
// orderController.js's getOccupiedDineInTables for why this is safe to
// leave unbounded (the result is capped by the shop's own physical table
// count, not by order history size).
//
// Pushed down (loopback only) by the till whenever it successfully loads
// this list from the cloud - see offline-sync.ts's pushCurrentOccupiedTables.
// Read (pairing-key gated) by POSPage.tsx itself when offline, merged with
// this till's own still-queued local orders (already unbounded - see
// localOrders.js).
const CACHE_KEY = "occupiedTablesCache";

function get() {
  return store.load(CACHE_KEY, { updatedAt: null, tables: [] });
}

function set(tables) {
  const snapshot = { updatedAt: new Date().toISOString(), tables: Array.isArray(tables) ? tables : [] };
  store.save(CACHE_KEY, snapshot);
  return snapshot;
}

module.exports = { get, set };
