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

const DEFAULT_COUNTER = { sessionId: null, value: 0, resetAt: null };

function nextLocalOrderNumber() {
  const counter = store.load(COUNTER_KEY, DEFAULT_COUNTER);
  // Defensive floor: never hand out a number at or below one already used
  // by an order STILL SITTING UNSYNCED in the queue right now. counter.json
  // and orders.json are two separate files updated in two separate writes
  // (see queueOrder below) - if anything ever left them out of step (a
  // half-written file from a crash mid-save, a manually restored backup,
  // etc.), this guarantees numbering still only ever goes forward instead
  // of quietly reusing a number that's already on a real order from the
  // SAME still-open shift.
  //
  // Two things are deliberately excluded from this floor:
  //   - Already-synced orders - orders.json keeps every offline order ever
  //     placed, forever, across every past shift, purely as a local audit
  //     trail (see queueOrder/markSynced below - nothing ever deletes from
  //     it). A closed shift's already-synced numbers are permanently
  //     recorded in the cloud and have nothing left to protect against
  //     colliding with.
  //   - Anything queued BEFORE this shift started (queuedAt earlier than
  //     counter.resetAt, set by resetCounter below whenever Open Shop
  //     happens). Without this, an old order that got stuck as "pending"
  //     and never actually synced (an abandoned/orphaned record from a
  //     previous shift - even from something as mundane as earlier
  //     testing) would sit in orders.json forever and permanently drag
  //     every future shift's numbering up to whatever high number it
  //     happened to reach, defeating the reset-to-1 this file exists to
  //     guarantee. A stuck order like that still safely finds its way to
  //     the cloud eventually via importOfflineOrders' own collision check
  //     (backend/controllers/orderController.js) - it just no longer gets
  //     to hold this till's CURRENT numbering hostage while it waits.
  const highestQueued = readOrders()
    .filter((order) => order.status !== "synced")
    .filter((order) => !counter.resetAt || new Date(order.queuedAt) >= new Date(counter.resetAt))
    .reduce((max, order) => Math.max(max, order.localOrderNumber || 0), 0);
  const next = Math.max(counter.value, highestQueued) + 1;
  store.save(COUNTER_KEY, { sessionId: counter.sessionId, value: next, resetAt: counter.resetAt });
  return next;
}

// Called the instant a new shift starts - both when Open Shop succeeds
// online (via syncOrderCounter picking up the fresh session's orderCounter
// of 0 - see shop-session.tsx's refresh()) AND, critically, the moment
// Open Shop is tapped OFFLINE (see shop-session.tsx's openLocally()),
// since in that case there's no cloud round-trip yet to learn "this is a
// new session" from - nothing else would otherwise reset this file until
// the till reconnects, so the first few offline orders of a brand new
// shift would wrongly continue the previous shift's numbers instead of
// starting at 1. Safe to call any time - resets both the counter itself
// AND (via resetAt) the floor above, so old leftover queue entries from
// before this moment can never drag the new shift's numbering back up.
function resetCounter() {
  const counter = store.load(COUNTER_KEY, DEFAULT_COUNTER);
  store.save(COUNTER_KEY, { sessionId: counter.sessionId, value: 0, resetAt: new Date().toISOString() });
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
// function is the one place that reconciles it, and it ALWAYS just
// adopts the cloud's own value directly - it never tries to be "at least
// as high as" whatever this file happened to already contain.
//
// That's deliberate, not an oversight: this call only ever happens right
// after a genuinely successful, live call to the cloud, so cloudCounter
// is always the true, current count at that exact instant - there's
// nothing more authoritative to compare it against. Blindly trusting a
// locally-stored value as a floor is exactly what caused a real bug: a
// stale counter.json left over from earlier testing (or an old
// pre-this-fix file with no sessionId at all) could sit at some high
// number with nothing behind it, and get treated as "this till is ahead
// of the cloud" - jumping a brand new order straight to #24 instead of
// #3. Any orders genuinely placed offline and not yet synced are already
// protected separately, by nextLocalOrderNumber's own highestQueued check
// against the REAL queued order records (not this file) - so adopting
// the cloud's value here directly can never cause a collision or lose
// progress, only ever correct a wrong one.
function syncOrderCounter(sessionId, cloudCounter) {
  // Preserves resetAt (see resetCounter/nextLocalOrderNumber above) -
  // this function only ever moves the raw counter VALUE, it must never be
  // the thing that decides whether old queue entries still count toward
  // the floor.
  const counter = store.load(COUNTER_KEY, DEFAULT_COUNTER);
  const cloudValue = Number(cloudCounter) || 0;
  store.save(COUNTER_KEY, { sessionId: sessionId || null, value: cloudValue, resetAt: counter.resetAt });
  return { sessionId: sessionId || null, value: cloudValue };
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
  // Reserves the next ticket number WITHOUT queuing an order record - used
  // when the till is placing an order straight online (see server.js's
  // POST /orders/reserve-number and POSPage.tsx). This is what makes order
  // numbering the same single, connectivity-independent sequence whether
  // the order ends up going through the cloud immediately or the local
  // queue - both paths pull from this exact same counter.
  reserveNextNumber: nextLocalOrderNumber,
  STALE_AFTER_MS,
  updateQueuedOrder,
  queueOrderEdit,
  listPendingEdits,
  markEditsSynced,
  markEditFailed,
};
