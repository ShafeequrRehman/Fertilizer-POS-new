const store = require("./jsonStore");

// A read-only-to-phones snapshot of "enough data to take an order offline"
// - products, customers, and staff/waiters - pushed down by the desktop
// app (while it still has internet) via POST /reference-data, and read by
// paired phones (and the till's own offline POS view) via
// GET /reference-data. Just the last full snapshot is kept; there is no
// history/versioning here, this is a cache, not a database.
//
// `roles` (added alongside the offline Manage Staff feature - see
// localStaff.js) is the shop's list of Role documents ({_id, name,
// permissions}) - needed so the "New Staff Member"/"Edit Staff Member" form
// still has something to populate its Role dropdown from while offline.
// Everything here is read-only display data - actually creating/editing a
// Role still requires being online (see EmployeesPage.tsx), same as it
// always has.
const REFERENCE_KEY = "reference";

function get() {
  return store.load(REFERENCE_KEY, {
    updatedAt: null,
    shopName: "",
    products: [],
    customers: [],
    staff: [],
    roles: [],
    // This shop's custom DineIn table labels (Shop.tables - see
    // models/Shop.js) - empty means "no custom layout, use the default
    // numbered tables". Same omit-to-preserve convention as roles below.
    tables: [],
  });
}

// Fields the caller genuinely didn't send at all (as opposed to explicitly
// sending an empty array, which still means "yes, wipe it") fall back to
// whatever this snapshot already had - e.g. POSPage.tsx's own frequent
// products/waiters-only push omits `roles` entirely, so Manage Staff's
// offline role dropdown doesn't get blanked out between offline-sync.ts's
// less-frequent full pushes (the one place that actually refreshes roles).
function set(data) {
  const previous = get();
  const snapshot = {
    updatedAt: new Date().toISOString(),
    shopName: data.shopName || previous.shopName || "",
    products: Array.isArray(data.products) ? data.products : previous.products,
    customers: Array.isArray(data.customers) ? data.customers : previous.customers,
    staff: Array.isArray(data.staff) ? data.staff : previous.staff,
    roles: Array.isArray(data.roles) ? data.roles : previous.roles,
    tables: Array.isArray(data.tables) ? data.tables : previous.tables,
  };
  store.save(REFERENCE_KEY, snapshot);
  return snapshot;
}

module.exports = { get, set };
