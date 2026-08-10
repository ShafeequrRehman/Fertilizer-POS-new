const express = require("express");
const os = require("os");
const pairing = require("./pairing");
const localOrders = require("./localOrders");
const referenceData = require("./referenceData");

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

// Queue an order locally - called by a paired phone's Checkout screen, or
// by the till's own POS page, whenever the cloud is unreachable.
app.post("/orders", requirePairingKey, (req, res) => {
  const payload = req.body?.payload;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ message: "payload is required", reason: "validation_error" });
  }
  const record = localOrders.queueOrder(payload, req.body?.actor || null);
  res.status(201).json(record);
});

app.get("/orders/pending", requirePairingKey, (req, res) => {
  res.json(localOrders.listPending());
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

app.get("/sync/status", requirePairingKey, (req, res) => {
  const all = localOrders.listAll();
  const pending = all.filter((order) => order.status === "pending");
  const failed = all.filter((order) => order.status === "failed");
  res.json({
    pendingCount: pending.length,
    failedCount: failed.length,
    totalQueued: all.length,
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
