const crypto = require("crypto");
const store = require("./jsonStore");

// Offline "Manage Staff" queue - the staff-CRUD counterpart to
// localOrders.js's order queue. Lets EmployeesPage.tsx create, edit, and
// remove staff members while the till can't reach the cloud, exactly the
// same "queue it locally, replay it for real once back online" shape
// orders already use:
//
//   - A brand-new staff member created offline has no real cloud _id yet -
//     it sits in the CREATES queue below (queueEmployeeCreate) until the
//     sync engine (offline-sync.ts) POSTs it to /shop/employees for real.
//     Editing or removing that SAME still-queued record (before it's ever
//     synced) just mutates/deletes the queued entry directly
//     (updateQueuedEmployee / deleteQueuedEmployee) - there's nothing on
//     the cloud yet to reconcile against.
//
//   - Editing or removing a staff member that already has a real cloud _id
//     (existed before this offline stretch, or was created in an earlier,
//     already-synced session) queues the change in the EDITS/DELETES
//     queues below, to be replayed against the real User document via
//     shopApi.updateEmployee/deleteEmployee once synced.
//
// Unlike orders, there's no totals/items recalculation needed here - a
// staff record's fields are applied as a plain shallow merge.

const CREATES_KEY = "employeeCreates";
const EDITS_KEY = "employeeEdits";
const DELETES_KEY = "employeeDeletes";

function readCreates() {
  return store.load(CREATES_KEY, []);
}
function writeCreates(records) {
  store.save(CREATES_KEY, records);
}

function readEdits() {
  return store.load(EDITS_KEY, []);
}
function writeEdits(records) {
  store.save(EDITS_KEY, records);
}

function readDeletes() {
  return store.load(DELETES_KEY, []);
}
function writeDeletes(records) {
  store.save(DELETES_KEY, records);
}

// --- Creating a new staff member offline --------------------------------

function queueEmployeeCreate(payload) {
  const records = readCreates();
  const record = {
    id: crypto.randomUUID(),
    payload,
    status: "pending", // pending | synced | failed
    queuedAt: new Date().toISOString(),
    syncedAt: null,
    lastError: null,
  };
  records.push(record);
  writeCreates(records);
  return record;
}

function listPendingCreates() {
  return readCreates().filter((record) => record.status !== "synced");
}

function listAllCreates() {
  return readCreates();
}

function markCreatesSynced(ids) {
  const idSet = new Set(ids);
  const records = readCreates();
  let changed = false;
  for (const record of records) {
    if (idSet.has(record.id) && record.status !== "synced") {
      record.status = "synced";
      record.syncedAt = new Date().toISOString();
      record.lastError = null;
      changed = true;
    }
  }
  if (changed) writeCreates(records);
  return changed;
}

function markCreateFailed(id, errorMessage) {
  const records = readCreates();
  const record = records.find((entry) => entry.id === id);
  if (!record) return false;
  record.status = "failed";
  record.lastError = errorMessage || "Unknown error";
  writeCreates(records);
  return true;
}

// Mutates a still-unsynced queued create's own payload directly - localId
// is the record's own `id` (see EmployeesPage.tsx's local-<uuid> ids,
// mirroring SavedOrder's own "local-" prefix convention for orders).
function updateQueuedEmployee(localId, patch) {
  const records = readCreates();
  const index = records.findIndex((entry) => entry.id === localId);
  if (index === -1) return null;
  const record = records[index];
  if (record.status === "synced") return null;
  record.payload = { ...record.payload, ...patch };
  records[index] = record;
  writeCreates(records);
  return record;
}

// Removes a still-unsynced queued create entirely - nothing was ever
// created on the cloud for it, so there's nothing to reconcile, unlike
// queueEmployeeDelete below (for a staff member that already has a real
// cloud _id).
function deleteQueuedEmployee(localId) {
  const records = readCreates();
  const index = records.findIndex((entry) => entry.id === localId && entry.status !== "synced");
  if (index === -1) return false;
  records.splice(index, 1);
  writeCreates(records);
  return true;
}

// --- Editing/removing a staff member that already has a real cloud _id --

function queueEmployeeEdit(employeeId, patch) {
  const records = readEdits();
  const record = {
    id: crypto.randomUUID(),
    employeeId,
    payload: patch,
    status: "pending", // pending | synced | failed
    queuedAt: new Date().toISOString(),
    syncedAt: null,
    lastError: null,
  };
  records.push(record);
  writeEdits(records);
  return record;
}

function listPendingEdits() {
  return readEdits().filter((record) => record.status !== "synced");
}

function markEditsSynced(ids) {
  const idSet = new Set(ids);
  const records = readEdits();
  let changed = false;
  for (const record of records) {
    if (idSet.has(record.id) && record.status !== "synced") {
      record.status = "synced";
      record.syncedAt = new Date().toISOString();
      record.lastError = null;
      changed = true;
    }
  }
  if (changed) writeEdits(records);
  return changed;
}

function markEditFailed(id, errorMessage) {
  const records = readEdits();
  const record = records.find((entry) => entry.id === id);
  if (!record) return false;
  record.status = "failed";
  record.lastError = errorMessage || "Unknown error";
  writeEdits(records);
  return true;
}

function queueEmployeeDelete(employeeId) {
  const records = readDeletes();
  const record = {
    id: crypto.randomUUID(),
    employeeId,
    status: "pending", // pending | synced | failed
    queuedAt: new Date().toISOString(),
    syncedAt: null,
    lastError: null,
  };
  records.push(record);
  writeDeletes(records);
  return record;
}

function listPendingDeletes() {
  return readDeletes().filter((record) => record.status !== "synced");
}

function markDeletesSynced(ids) {
  const idSet = new Set(ids);
  const records = readDeletes();
  let changed = false;
  for (const record of records) {
    if (idSet.has(record.id) && record.status !== "synced") {
      record.status = "synced";
      record.syncedAt = new Date().toISOString();
      record.lastError = null;
      changed = true;
    }
  }
  if (changed) writeDeletes(records);
  return changed;
}

function markDeleteFailed(id, errorMessage) {
  const records = readDeletes();
  const record = records.find((entry) => entry.id === id);
  if (!record) return false;
  record.status = "failed";
  record.lastError = errorMessage || "Unknown error";
  writeDeletes(records);
  return true;
}

module.exports = {
  queueEmployeeCreate,
  listPendingCreates,
  listAllCreates,
  markCreatesSynced,
  markCreateFailed,
  updateQueuedEmployee,
  deleteQueuedEmployee,
  queueEmployeeEdit,
  listPendingEdits,
  markEditsSynced,
  markEditFailed,
  queueEmployeeDelete,
  listPendingDeletes,
  markDeletesSynced,
  markDeleteFailed,
};
