const store = require("./jsonStore");

// A read-only-to-phones snapshot of "enough data to take an order offline"
// - products, customers, and staff/waiters - pushed down by the desktop
// app (while it still has internet) via POST /reference-data, and read by
// paired phones (and the till's own offline POS view) via
// GET /reference-data. Just the last full snapshot is kept; there is no
// history/versioning here, this is a cache, not a database.
const REFERENCE_KEY = "reference";

function get() {
  return store.load(REFERENCE_KEY, {
    updatedAt: null,
    shopName: "",
    products: [],
    customers: [],
    staff: [],
  });
}

function set(data) {
  const snapshot = {
    updatedAt: new Date().toISOString(),
    shopName: data.shopName || "",
    products: Array.isArray(data.products) ? data.products : [],
    customers: Array.isArray(data.customers) ? data.customers : [],
    staff: Array.isArray(data.staff) ? data.staff : [],
  };
  store.save(REFERENCE_KEY, snapshot);
  return snapshot;
}

module.exports = { get, set };
