const store = require("./jsonStore");

// A read-only offline snapshot of this shop's real Dining Table records
// (id/name/isFamily/isActive - see the Table model/tableController.js),
// pushed down by the till (while it still has internet) via
// POST /tables-cache, and read back by POSPage.tsx via GET /tables-cache
// the moment a live GET /tables call fails. Same "loopback pushes,
// pairing-key reads, last-snapshot-only" shape as
// referenceData.js/orderCache.js/occupiedTablesCache.js/ingredientsCache.js.
//
// Deliberately separate from referenceData.js's own `tables` field (a
// shop's plain custom table-name LABELS, Shop.tables - see
// table-options.ts) - this cache exists to keep the rich Dine-In table
// GRID (with per-table isFamily/isActive, occupancy locking, and the
// "no tables configured yet" empty state) fully working offline. Without
// this, an offline till fell back to loadProductsFromLocalHub's cache-only
// path, which never touched the real `tables` state at all, so a network
// outage made every Dine-In table vanish from the picker even though the
// shop had tables configured - see POSPage.tsx's loadProductsFromLocalHub/
// mergeLocalPendingIntoActiveTables for how this snapshot is consumed.
//
// Deliberately READ-ONLY offline: creating/renaming a table still requires
// being online (TableManagementSection.tsx), same as every other
// management-style action - this cache only ever feeds the Dine-In grid's
// table SELECTION, never table creation/editing.
const CACHE_KEY = "tablesCache";

function get() {
  return store.load(CACHE_KEY, { updatedAt: null, tables: [] });
}

function set(tables) {
  const snapshot = {
    updatedAt: new Date().toISOString(),
    tables: Array.isArray(tables) ? tables : [],
  };
  store.save(CACHE_KEY, snapshot);
  return snapshot;
}

module.exports = { get, set };
