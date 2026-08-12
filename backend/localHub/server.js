const express = require("express");
const cors = require("cors");
const os = require("os");
const pairing = require("./pairing");
const localOrders = require("./localOrders");
const referenceData = require("./referenceData");
const orderCache = require("./orderCache");

// The Local Hub: a small, self-contained Express server that runs inside
// the desktop (Electron) app ALWAYS, independent of whether this till
// talks to the cloud backend or not (see main.js - unlike the legacy
// embedded full backend, which only starts when VITE_API_URL is unset and
// still needs MongoDB Atlas to do anything, this one needs nothing but
// this machine). Its only jobs: let a paired phone (or this till's own
// offline POS view) queue orders locally when the internet is down, and
// let the sync engine (pos-web/src/lib/offline-sync.ts) push them to the
// cloud once it's back.
//
// Security model: NOT the shop's normal JWT. The desktop app's bundled
// backend and the cloud backend can each have their own independently
// generated JWT_SECRET (see backend/index.js's ensureJwtSecret - it
// generates one on first run if missing), so verifying a phone's
// cloud-issued token's signature here isn't a safe assumption. Instead,
// every route below (other than /health) requires the shop's Pairing Key
// (see pairing.js) - shown as a QR code / plain text on the till's
// Connect Devices page, entered once on the phone. Two routes
// (/pairing-info, /pairing/rotate) additionally require the caller to be
// on this same machine (loopback), since they reveal or change the key
// itself - LAN devices only ever need to already know the key.

const LOCAL_HUB_PORT = Number(process.env.POS_LOCAL_HUB_PORT) || 5057;

const app = express();
// Without this, every call from the renderer (whether Vite's
// localhost:5173 in dev, or the packaged app's file:// origin) is a
// cross-origin request as far as Chromium is concerned - and gets
// blocked by the browser before it even leaves the process, regardless
// of whether the Local Hub is actually listening. That's indistinguishable
// from "unreachable" to axios (no response, just a network error), which
// is exactly the false negative isLocalHubReachable() was hitting even
// with the server confirmed up via `netstat`. allow-all mirrors the
// legacy backend (backend/index.js's own app.use(cors())) - this is a
// LAN-only, pairing-key-gated server, not a public one, so there's no
// meaningful origin to restrict to.
app.use(cors());
app.use(express.json());

function isLoopback(req) {
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function requireLoopback(req, res, next) {
  if (!isLoopback(req)) {
    return res.status(403).json({ message: "This action is only available from the till itself." });
  }
  next();
}

function requirePairingKey(req, res, next) {
  const key = req.headers["x-pairing-key"];
  if (!pairing.isValidKey(key)) {
    return res.status(401).json({ message: "Missing or incorrect pairing key.", reason: "invalid_pairing_key" });
  }
  next();
}

// Every non-internal, non-loopback IPv4 address this machine currently
// has - a LAN can have more than one adapter (WiFi + Ethernet, or a VPN
// adapter), so the Connect Devices page shows all of them and lets
// whoever's pairing pick the one that actually matches their WiFi.
function listLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// Desktop's own Connect Devices page calls this (over localhost) to
// render the QR code / manual pairing details. Loopback-only - this is
// the one place the key itself is ever revealed.
app.get("/pairing-info", requireLoopback, (req, res) => {
  res.json({
    ips: listLanAddresses(),
    port: LOCAL_HUB_PORT,
    pairingKey: pairing.getOrCreatePairingKey(),
  });
});

app.post("/pairing/rotate", requireLoopback, (req, res) => {
  res.json({ pairingKey: pairing.rotatePairingKey() });
});

// A phone calls this once, right after typing in / scanning the IP, port,
// and key, purely to confirm they're correct before saving them - doesn't
// register the device anywhere, since the key itself (sent on every
// subsequent request) is the only thing that's actually checked.
app.post("/pair", (req, res) => {
  const key = req.body?.key;
  if (!pairing.isValidKey(key)) {
    return res.status(401).json({ message: "Incorrect pairing key.", reason: "invalid_pairing_key" });
  }
  const reference = referenceData.get();
  res.json({ ok: true, shopName: reference.shopName || "" });
});

// Desktop pushes its latest products/customers/staff down while online so
// they're available for offline order-taking - loopback-only, since only
// the till itself (already logged into the shop) should ever be the
// source of truth for this cache.
app.post("/reference-data", requireLoopback, (req, res) => {
  const snapshot = referenceData.set(req.body || {});
  res.json(snapshot);
});

app.get("/reference-data", requirePairingKey, (req, res) => {
  res.json(referenceData.get());
});

// Cloud orders snapshot - see orderCache.js. Pushed down (loopback only)
// by the till whenever it successfully loads orders from the cloud;
// merged with the pending order/edit queues below by whoever reads it
// (see offline-order-helpers.ts's mergeOrdersForDisplay), never here -
// keeps the "what does an order look like" logic in exactly one place.
app.post("/orders-cache", requireLoopback, (req, res) => {
  const snapshot = orderCache.set(req.body?.orders || []);
  res.json(snapshot);
});

app.get("/orders-cache", requirePairingKey, (req, res) => {
  res.json(orderCache.get());
});

// Queue an order locally - called by a paired phone's Checkout screen, or
// by the till's own POS page, whenever the cloud is unreachable.
app.post("/orders", requirePairingKey, (req, res) => {
  const payload = req.body?.payload;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ message: "payload is required", reason: "validation_error" });
  }
  const record = localOrders.queueOrder(payload, req.body?.actor || null, req.body?.printFlags || null);
  res.status(201).json(record);
});

app.get("/orders/pending", requirePairingKey, (req, res) => {
  res.json(localOrders.listPending());
});

// Reserves the next ticket number WITHOUT queuing an order record - called
// by POSPage.tsx right before placing an order straight online, so this
// till's order numbering is always decided here first, never by the
// cloud's own counter, whether the order ends up going through the cloud
// immediately or the offline queue. See localOrders.js's reserveNextNumber.
app.post("/orders/reserve-number", requirePairingKey, (req, res) => {
  res.json({ number: localOrders.reserveNextNumber() });
});

app.get("/orders/all", requirePairingKey, (req, res) => {
  res.json(localOrders.listAll());
});

// Called by the desktop's sync engine after it has successfully imported
// these orders into the cloud (see src/lib/offline-sync.ts + backend's
// POST /api/orders/import-offline).
app.post("/orders/ack", requirePairingKey, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const changed = localOrders.markSynced(ids);
  res.json({ ok: true, changed });
});

app.post("/orders/:id/fail", requirePairingKey, (req, res) => {
  const changed = localOrders.markFailed(req.params.id, req.body?.error);
  res.json({ ok: changed });
});

// Editing an order while offline - see localOrders.js's "Editing an order
// while offline" section for the full split between these two cases.
// Called by SalesPage.tsx's saveUpdate() when isDesktopApp() && !isOnline.

// Case 1: the order being edited is itself still only local (its frontend
// id looks like "local-<uuid>" - see SalesPage.tsx's localOrderToSavedOrder).
// :localId here is that uuid with the "local-" prefix already stripped by
// the caller.
app.patch("/orders/local/:localId", requirePairingKey, (req, res) => {
  const updated = localOrders.updateQueuedOrder(req.params.localId, req.body?.payload || {});
  if (!updated) {
    return res.status(404).json({ message: "No such queued order (it may have already synced)." });
  }
  res.json(updated);
});

// Case 2: the order already has a real cloud _id - queue the edit for the
// sync engine to replay against the real document.
app.post("/orders/:orderId/edits", requirePairingKey, (req, res) => {
  const record = localOrders.queueOrderEdit(req.params.orderId, req.body?.payload || {}, req.body?.actor || null, !!req.body?.kitchenPrinted);
  res.status(201).json(record);
});

app.get("/orders/edits/pending", requirePairingKey, (req, res) => {
  res.json(localOrders.listPendingEdits());
});

app.post("/orders/edits/ack", requirePairingKey, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const changed = localOrders.markEditsSynced(ids);
  res.json({ ok: true, changed });
});

app.post("/orders/edits/:id/fail", requirePairingKey, (req, res) => {
  const changed = localOrders.markEditFailed(req.params.id, req.body?.error);
  res.json({ ok: changed });
});

// Keeps this till's local order counter in step with the cloud's real
// ShopSession.orderCounter - see localOrders.js's syncOrderCounter for the
// full reasoning. Loopback-only: only the till itself, which just talked
// to the cloud, should ever be the source of truth for what the cloud's
// counter currently is. Called from shop-session.tsx's refresh() and
// right after any successful online order create/import.
app.post("/order-counter-sync", requireLoopback, (req, res) => {
  const { sessionId, orderCounter } = req.body || {};
  const result = localOrders.syncOrderCounter(sessionId || null, orderCounter);
  res.json(result);
});

// Called the instant Open Shop is tapped while OFFLINE (see
// shop-session.tsx's openLocally()) - there's no cloud round-trip yet at
// that moment to learn a fresh session's orderCounter from, so this is the
// only way a brand new shift starting offline gets its order numbering
// reset to 1 right away instead of wrongly continuing the previous
// shift's count until the till happens to reconnect. See
// localOrders.js's resetCounter.
app.post("/order-counter/reset", requireLoopback, (req, res) => {
  localOrders.resetCounter();
  res.json({ ok: true });
});

app.get("/sync/status", requirePairingKey, (req, res) => {
  const all = localOrders.listAll();
  const pending = all.filter((order) => order.status === "pending");
  const failed = all.filter((order) => order.status === "failed");
  const pendingEdits = localOrders.listPendingEdits();
  res.json({
    pendingCount: pending.length,
    failedCount: failed.length,
    totalQueued: all.length,
    pendingEditCount: pendingEdits.filter((edit) => edit.status === "pending").length,
    failedEditCount: pendingEdits.filter((edit) => edit.status === "failed").length,
  });
});

app.use((err, req, res, next) => {
  console.error("[localHub] error:", err);
  res.status(500).json({ message: err.message || "Local hub error" });
});

let serverInstance = null;

function startLocalHub(port = LOCAL_HUB_PORT) {
  return new Promise((resolve, reject) => {
    if (serverInstance) {
      resolve(serverInstance);
      return;
    }
    // Bind to 0.0.0.0 (default when no host is passed) so LAN devices,
    // not just this machine, can reach it.
    serverInstance = app.listen(port, () => {
      console.log(`[localHub] Local Hub listening on port ${port}`);
      resolve(serverInstance);
    });
    serverInstance.on("error", (err) => {
      console.error("[localHub] Failed to start:", err.message);
      serverInstance = null;
      reject(err);
    });
  });
}

function stopLocalHub() {
  return new Promise((resolve) => {
    if (!serverInstance) {
      resolve();
      return;
    }
    serverInstance.close(() => {
      serverInstance = null;
      resolve();
    });
  });
}

module.exports = { app, startLocalHub, stopLocalHub, LOCAL_HUB_PORT };
