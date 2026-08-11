const crypto = require("crypto");
const store = require("./jsonStore");

// The offline order queue itself. Every order placed while the shop can't
// reach the cloud (from the till's own POS page or a paired phone) lands
// here first with status "pending", gets a locally-allocated
// `localOrderNumber` (so staff have SOME ticket number to hand a customer
// and shout to the kitchen immediately), and waits for the sync engine
// (see pos-web/src/lib/offline-sync.ts) to push it to the cloud's real
// order-creation pipeline, where it gets the shop's normal, permanent
// `dailyOrderNumber`.
//
// Because every offline order - whether placed on the till itself or on a
// paired phone - is only ever written here, through this one Node
// process, `nextLocalOrderNumber()` below can be a simple in-memory
// increment with no risk of two devices colliding on the same number.
// That's the entire reason the pairing feature requires a desktop hub
// rather than letting phones queue orders fully standalone.

const ORDERS_KEY = "orders";
const COUNTER_KEY = "counter";

function readOrders() {
  return store.load(ORDERS_KEY, []);
}

function writeOrders(orders) {
  store.save(ORDERS_KEY, orders);
}

function nextLocalOrderNumber() {
  const counter = store.load(COUNTER_KEY, { sessionId: null, value: 0 });
  // Defensive floor: never hand out a number at or below one already used
  // by an order sitting in the queue right now. counter.json and
  // orders.json are two separate files updated in two separate writes
  // (see queueOrder below) - if anything ever left them out of step (a
  // half-written file from a crash mid-save, a manually restored backup,
  // etc.), this guarantees numbering still only ever goes forward instead
  // of quietly reusing a number that's already on a real, possibly
  // already-completed order.
  const highestQueued = readOrders().reduce((max, order) => Math.max(max, order.localOrderNumber || 0), 0);
  const next = Math.max(counter.value, highestQueued) + 1;
  store.save(COUNTER_KEY, { sessionId: counter.sessionId, value: next });
  return next;
}

function resetCounter() {
  const counter = store.load(COUNTER_KEY, { sessionId: null, value: 0 });
  store.save(COUNTER_KEY, { sessionId: counter.sessionId, value: 0 });
}

// --- Keeping the local counter and the cloud's ShopSession.orderCounter
// as ONE seamless sequence, regardless of connectivity --------------------
//
// Before this, the local counter (above) was completely unaware of the
// cloud's own orderCounter (backend/models/ShopSession.js) - it only ever
// protected itself against repeating ITS OWN past numbers. That let two
// symptoms both happen: a fresh Local Hub data dir (or one left over from
// old testing) could hand out numbers that collide with, or lag way
// behind, what the cloud already considers "current" for this shift; and
// reconnecting could make a brand new order look like it "restarted" at 1
// even mid-shift, because nothing ever reset - or advanced - this file to
// match the real session.
//
// The fix: the till pushes {sessionId, orderCounter} down to the hub
// every time it successfully talks to the cloud about the shop's session
// (see shop-session.tsx's refresh(), and right after any successful
// online order create/import - see offline-sync.ts / POSPage.tsx). This
// function is the one place that reconciles it:
//   - Same sessionId as last time (an already-open shift, connectivity
//     just flickered) -> advance the local counter up to at least the
//     cloud's true count. The next offline order continues the REAL
//     sequence instead of whatever this till's file happened to say.
//   - Different sessionId (a genuinely NEW shop-open - new shift/day) ->
//     reset to the cloud's counter for that brand new session (0 for a
//     freshly opened shift), so a new shift always starts clean at 1,
//     exactly like the cloud does, and never carries over the previous
//     shift's numbers into this one.
//   - No sessionId at all yet (very first sync of this till's lifetime,
//     or the shop session hasn't loaded) -> just advance, same as the
//     matching-session case - there's nothing to compare against yet.
function syncOrderCounter(sessionId, cloudCounter) {
  const counter = store.load(COUNTER_KEY, { sessionId: null, value: 0 });
  const cloudValue = Number(cloudCounter) || 0;

  if (sessionId && counter.sessionId && counter.sessionId !== sessionId) {
    store.save(COUNTER_KEY, { sessionId, value: cloudValue });
    return { reset: true, sessionId, value: cloudValue };
  }

  const value = Math.max(counter.value, cloudValue);
  const nextSessionId = sessionId || counter.sessionId || null;
  store.save(COUNTER_KEY, { sessionId: nextSessionId, value });
  return { reset: false, sessionId: nextSessionId, value };
}

function queueOrder(payload, actor) {
  const orders = readOrders();
  const record = {
    id: crypto.randomUUID(),
    localOrderNumber: nextLocalOrderNumber(),
    payload,
    actor: actor || null, // { name, deviceLabel } - self-reported, display only
    status: "pending", // pending | synced | failed
    queuedAt: new Date().toISOString(),
    syncedAt: null,
    lastError: null,
  };
  orders.push(record);
  writeOrders(orders);
  return record;
}

function listPending() {
  return readOrders().filter((order) => order.status !== "synced");
}

function listAll() {
  return readOrders();
}

function markSynced(ids) {
  const idSet = new Set(ids);
  const orders = readOrders();
  let changed = false;
  for (const order of orders) {
    if (idSet.has(order.id) && order.status !== "synced") {
      order.status = "synced";
      order.syncedAt = new Date().toISOString();
      order.lastError = null;
      changed = true;
    }
  }
  if (changed) writeOrders(orders);
  return changed;
}

function markFailed(id, errorMessage) {
  const orders = readOrders();
  const order = orders.find((entry) => entry.id === id);
  if (!order) return false;
  order.status = "failed";
  order.lastError = errorMessage || "Unknown error";
  writeOrders(orders);
  return true;
}

// --- Editing an order while offline -----------------------------------
//
// SalesPage.tsx's order-card actions (add items, replace items, complete
// payment, and simple field edits like note/waiter/table - everything
// except Cancel, which stays online-only since it needs the shop's Cancel
// Order Key that never reaches the till at all) need to keep working with
// no internet. There are two completely different cases, because an
// order being edited might not have a real cloud _id yet:
//
//   1. The order is itself still sitting in the queue above, unsynced -
//      just mutate its stored payload directly (updateQueuedOrder). It'll
//      reach the cloud with its final state already baked in the next
//      time importOfflineOrders runs; there's nothing to "replay" since
//      it's never been anywhere else yet.
//
//   2. The order already has a real cloud _id (it existed before this
//      offline stretch) - queue the edit itself (queueOrderEdit below),
//      to be replayed against the real document via
//      POST /orders/import-offline-updates once synced, through the exact
//      same logic (backend/controllers/orderController.js's
//      applyOrderPatch) the online PATCH handler uses.

// Duplicated from backend/controllers/orderController.js's
// recalculateTotals/computeDiscountAmount on purpose - this file has zero
// dependency on mongoose or the rest of the backend so the Local Hub stays
// usable standalone, and this is pure arithmetic with nothing to drift.
// Deliberately does NOT attempt the customer-dues cascade completeAndSettle
// triggers online (see applyOrderPatch) - a not-yet-synced order has no
// real _id yet for any other order to reference, so that cascade only
// ever runs once this order is actually created in the cloud.
function computeDiscountAmount(discount, subtotal) {
  if (!discount || typeof discount !== "object") return 0;
  const value = Number(discount.value) || 0;
  if (value <= 0 || subtotal <= 0) return 0;
  if (discount.type === "percent") return Math.min(Math.round((subtotal * value) / 100), subtotal);
  return Math.min(Math.round(value), subtotal);
}

function recalculateTotals(items, discount) {
  const subtotal = (items || []).reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  const discountAmount = computeDiscountAmount(discount, subtotal);
  const total = Math.max(subtotal - discountAmount, 0);
  return { subtotal, tax: 0, total, discountAmount };
}

function updateQueuedOrder(localId, patch) {
  const orders = readOrders();
  const index = orders.findIndex((entry) => entry.id === localId);
  if (index === -1) return null;
  const record = orders[index];
  if (record.status === "synced") return null;

  const payload = { ...record.payload };
  const touchesItems = (patch.action === "addItems" || patch.action === "replaceItems") && Array.isArray(patch.items);

  if (patch.action === "addItems" && Array.isArray(patch.items)) {
    payload.items = [...(payload.items || []), ...patch.items];
  } else if (patch.action === "replaceItems" && Array.isArray(patch.items)) {
    payload.items = patch.items;
  }
  if (patch.discount !== undefined) payload.discount = patch.discount;

  if (touchesItems || patch.discount !== undefined) {
    const totals = recalculateTotals(payload.items, payload.discount);
    payload.subtotal = totals.subtotal;
    payload.tax = totals.tax;
    payload.total = totals.total;
    payload.discount = totals.discountAmount > 0 ? payload.discount : null;
    payload.remainingAmount = Math.max(totals.total - (Number(payload.paidAmount) || 0), 0);
  }

  if (patch.action === "completeAndSettle") {
    // No dues cascade here - see the file-level comment above.
    payload.status = "completed";
    payload.paidAmount = Math.max(Number(patch.paidAmount) || 0, 0);
    payload.remainingAmount = Math.max((Number(payload.total) || 0) - payload.paidAmount, 0);
    if (typeof patch.paymentMethod === "string") payload.paymentMethod = patch.paymentMethod;
    if (typeof patch.note === "string") payload.note = patch.note;
  } else {
    ["note", "waiter", "table", "address", "status", "paymentMethod"].forEach((field) => {
      if (patch[field] !== undefined) payload[field] = patch[field];
    });
    if (typeof patch.paidAmount === "number") payload.paidAmount = patch.paidAmount;
    if (typeof patch.remainingAmount === "number") payload.remainingAmount = patch.remainingAmount;
  }
  if (patch.customer) payload.customer = patch.customer;

  record.payload = payload;
  orders[index] = record;
  writeOrders(orders);
  return record;
}

const EDITS_KEY = "orderEdits";

function readEdits() {
  return store.load(EDITS_KEY, []);
}

function writeEdits(edits) {
  store.save(EDITS_KEY, edits);
}

function queueOrderEdit(orderId, patch, actor) {
  const edits = readEdits();
  const record = {
    id: crypto.randomUUID(),
    orderId,
    payload: patch,
    actor: actor || null,
    status: "pending", // pending | synced | failed
    queuedAt: new Date().toISOString(),
    syncedAt: null,
    lastError: null,
  };
  edits.push(record);
  writeEdits(edits);
  return record;
}

function listPendingEdits() {
  return readEdits().filter((edit) => edit.status !== "synced");
}

function markEditsSynced(ids) {
  const idSet = new Set(ids);
  const edits = readEdits();
  let changed = false;
  for (const edit of edits) {
    if (idSet.has(edit.id) && edit.status !== "synced") {
      edit.status = "synced";
      edit.syncedAt = new Date().toISOString();
      edit.lastError = null;
      changed = true;
    }
  }
  if (changed) writeEdits(edits);
  return changed;
}

function markEditFailed(id, errorMessage) {
  const edits = readEdits();
  const edit = edits.find((entry) => entry.id === id);
  if (!edit) return false;
  edit.status = "failed";
  edit.lastError = errorMessage || "Unknown error";
  writeEdits(edits);
  return true;
}

// Pending orders older than this are dropped from "pending" counts shown
// in the UI as stale-but-still-queued (not deleted - sync still retries
// them) - purely so a till that's been offline for days doesn't show a
// misleadingly huge number without context. Not enforced here; left as a
// documented constant for the frontend to use if needed.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

module.exports = {
  queueOrder,
  listPending,
  listAll,
  markSynced,
  markFailed,
  resetCounter,
  syncOrderCounter,
  STALE_AFTER_MS,
  updateQueuedOrder,
  queueOrderEdit,
  listPendingEdits,
  markEditsSynced,
  markEditFailed,
};
