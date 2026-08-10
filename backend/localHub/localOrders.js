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
  const counter = store.load(COUNTER_KEY, { value: 0 });
  counter.value += 1;
  store.save(COUNTER_KEY, counter);
  return counter.value;
}

function resetCounter() {
  store.save(COUNTER_KEY, { value: 0 });
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

// Pending orders older than this are dropped from "pending" counts shown
// in the UI as stale-but-still-queued (not deleted - sync still retries
// them) - purely so a till that's been offline for days doesn't show a
// misleadingly huge number without context. Not enforced here; left as a
// documented constant for the frontend to use if needed.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

module.exports = { queueOrder, listPending, listAll, markSynced, markFailed, resetCounter, STALE_AFTER_MS };
