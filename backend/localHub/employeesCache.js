const store = require("./jsonStore");

// A read-through cache of this shop's full Manage Staff employee list - the
// employees-page counterpart to orderCache.js's order-list cache.
// referenceData.js's own `staff` field is deliberately NOT reused for this:
// that one only ever carries the lightweight Waiter[] shape POSPage.tsx's
// waiter dropdown / SalesPage.tsx's filter pills need (id, name, isActive,
// designation), pulled from fetchWaiters(). EmployeesPage.tsx (Manage
// Staff) needs the FULL EmployeeSummary shape (username, phone, roleId,
// idCardNumber, address, reference, comment, monthlySalary, ...) - keeping
// them as two separate caches means neither has to carry fields the other
// doesn't need, and a change to one never risks quietly breaking the other.
//
// Pushed down (loopback only) by the till whenever it successfully loads
// the employee list from the cloud - see offline-sync.ts's
// pushCurrentEmployeesCache. Read (pairing-key gated) by EmployeesPage.tsx
// itself when offline, merged with whatever this till still has queued
// locally (see localStaff.js + offline-staff-helpers.ts's
// mergeEmployeesForDisplay), same "cache first, queue overlaid on top"
// pattern as orders.
const CACHE_KEY = "employeesCache";

function get() {
  return store.load(CACHE_KEY, { updatedAt: null, employees: [] });
}

function set(employees) {
  const snapshot = { updatedAt: new Date().toISOString(), employees: Array.isArray(employees) ? employees : [] };
  store.save(CACHE_KEY, snapshot);
  return snapshot;
}

module.exports = { get, set };
