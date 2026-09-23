const crypto = require("crypto");
const store = require("./jsonStore");

// Offline Mode's Customer Dues write queue - one flat queue holding every
// "Add Customer" / "+ Add Dues" / "- Pay Dues" action made while the till
// couldn't reach the cloud (or the net was too slow to trust), each
// tagged with its own `kind` so a single sync pass can replay a mixed
// batch in one go. Unlike localOrders.js this doesn't need separate
// queues per action type (create/edit/cancel) - there's no "editing an
// already-queued customer" case here worth the extra complexity, since a
// customer record itself is created once and dues actions only ever add
// new entries, never rewrite an existing one.
//
// Each action is replayed against backend/controllers/customerController.js's
// importOfflineCustomerActions - the exact same applyCreateCustomer/
// applyUpdateCustomerDues/applySettleCustomerDues logic the normal online
// routes use, so an offline "+ Add Dues" has identical real-world effects
// (cash/bank movement, duesHistory entry, balance) to doing it online.

const ACTIONS_KEY = "customerActions";

function readActions() {
  return store.load(ACTIONS_KEY, []);
}

function writeActions(actions) {
  store.save(ACTIONS_KEY, actions);
}

// kind: "create" | "add_due" | "settle_due" - payload is whatever body
// that action's cloud endpoint expects (see customerController.js).
function queueAction(kind, payload, actor) {
  const actions = readActions();
  const record = {
    id: crypto.randomUUID(),
    kind,
    payload,
    actor: actor || null, // { name } - self-reported, display only
    status: "pending", // pending | synced | failed
    queuedAt: new Date().toISOString(),
    syncedAt: null,
    lastError: null,
  };
  actions.push(record);
  writeActions(actions);
  return record;
}

function listPending() {
  return readActions().filter((action) => action.status !== "synced");
}

function listAll() {
  return readActions();
}

function markSynced(ids) {
  const idSet = new Set(ids);
  const actions = readActions();
  let changed = false;
  for (const action of actions) {
    if (idSet.has(action.id) && action.status !== "synced") {
      action.status = "synced";
      action.syncedAt = new Date().toISOString();
      action.lastError = null;
      changed = true;
    }
  }
  if (changed) writeActions(actions);
  return changed;
}

function markFailed(id, errorMessage) {
  const actions = readActions();
  const action = actions.find((entry) => entry.id === id);
  if (!action) return false;
  action.status = "failed";
  action.lastError = errorMessage || "Unknown error";
  writeActions(actions);
  return true;
}

module.exports = { queueAction, listPending, listAll, markSynced, markFailed };
