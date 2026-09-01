require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// BUILD MARKER - proves this exact backend/index.js file is the one that
// is actually running. Check the terminal for this line every time you
// restart `npm run dev`, to rule out a stale backend process holding
// port 5000 from an earlier run.
console.log("[backend/index.js] LOADED build-marker: 2026-07-08-debug-v2");

// Ensure JWT_SECRET is present in .env
function ensureJwtSecret() {
  if (process.env.JWT_SECRET) return;
  const secret = crypto.randomBytes(64).toString("hex");
  const envPath = path.join(__dirname, "..", ".env");
  const envVar = `\nJWT_SECRET=${secret}\n`;
  try {
    fs.appendFileSync(envPath, envVar);
    process.env.JWT_SECRET = secret;
    console.log("Generated secure JWT_SECRET and saved to .env");
  } catch (err) {
    console.error("Failed to save JWT_SECRET to .env", err);
    process.env.JWT_SECRET = secret; // fallback in memory
  }
}
ensureJwtSecret();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { connectDB } = require("./config/db");
const seedDefaults = require("./config/seed");
const connectivityMonitor = require("./config/connectivityMonitor");
const authRoutes = require("./routes/authRoutes");
const superAdminRoutes = require("./routes/superAdminRoutes");
const shopOwnerRoutes = require("./routes/shopOwnerRoutes");
const productRoutes = require("./routes/productRoutes");
const customerRoutes = require("./routes/customerRoutes");
const orderRoutes = require("./routes/orderRoutes");
const shopSessionRoutes = require("./routes/shopSessionRoutes");
const waiterRoutes = require("./routes/waiterRoutes");
const tableRoutes = require("./routes/tableRoutes");
const supplierRoutes = require("./routes/supplierRoutes");
const purchaseRoutes = require("./routes/purchaseRoutes");
const expenseRoutes = require("./routes/expenseRoutes");
const whatsappRoutes = require("./routes/whatsappRoutes");
const printerRoutes = require("./routes/printerRoutes");
const appVersionRoutes = require("./routes/appVersionRoutes");
const publicOrderRoutes = require("./routes/publicOrderRoutes");

const sanitizeInput = require("./middleware/sanitizeInput");

const app = express();

app.use(cors());
app.use(express.json());
// See sanitizeInput.js - strips Mongo operator keys ($ne, $gt, etc.) out
// of every request body/query/params before any route handler runs.
app.use(sanitizeInput);

// Reachability check for the frontend's real online/offline indicator (see
// src/lib/network-status.ts). The actual continuous checking happens in
// config/connectivityMonitor.js (started below in startBackend, ticking
// every 5s in the background regardless of whether any request is in
// flight) - this route just reads that cached result instantly, so the
// frontend gets an immediate answer instead of waiting out a fresh ping on
// every single poll.
app.get("/api/health", (req, res) => {
  const status = connectivityMonitor.getStatus();
  res.status(status.isOnline ? 200 : 503).json({ ok: status.isOnline, dbConnected: status.isOnline, lastCheckedAt: status.lastCheckedAt, time: Date.now() });
});

// Mobile app-update check (see routes/appVersionRoutes.js) - mounted here,
// same as /api/health above, so it works even when MongoDB Atlas is
// unreachable and without needing a logged-in session (a phone should be
// able to tell it needs an update before it can even log in).
app.use("/api/app-version", appVersionRoutes);

// Static hosting for built pos-mobile APKs - drop a new build into
// backend/public/apk/ and point `npm run set-app-version` at
// /apk/<filename> (see backend/scripts/setAppVersion.js). No auth - the
// file itself isn't sensitive, and a phone needs to download it before it
// can log in.
app.use("/apk", express.static(path.join(__dirname, "public", "apk")));

// TEMPORARY DEBUG LOGGING - proves whether a request from the frontend
// ever actually reaches this Express process at all. Remove once the
// login issue is confirmed fixed.
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

// With bufferCommands disabled (see config/db.js), a DB-touching route hit
// while Atlas is unreachable now fails fast instead of hanging - but the
// error message was still a raw Mongoose internals string ("Cannot call
// ... before initial connection is complete"), which is meaningless to
// someone looking at a failed login. This turns that into one unambiguous
// message before the request ever reaches a controller. readyState: 0 =
// disconnected, 1 = connected, 2 = connecting, 3 = disconnecting.
app.use("/api", (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      message: "Database is not connected. This is a MongoDB Atlas connectivity issue (DNS/network/IP allowlist), not an application error - check the backend terminal for the exact connection error, and verify your current IP is allowed in Atlas Network Access.",
      reason: "database_unavailable",
    });
  }
  next();
});

app.use("/api/auth", authRoutes);
app.use("/api/superadmin", superAdminRoutes);
app.use("/api/shop", shopOwnerRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/shop-session", shopSessionRoutes);
app.use("/api/waiters", waiterRoutes);
app.use("/api/tables", tableRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/purchases", purchaseRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/printers", printerRoutes);
// Customer-facing QR ordering (menu/tables/order-status/place-order/
// payment) - no login, see requireShopOrderable.js/publicOrderController.js
// for why every input there is treated as untrusted. Still mounted under
// /api so it inherits the DB-readiness check above (matched by prefix),
// just never the `authenticate` middleware any other /api/* route runs.
app.use("/api/public", publicOrderRoutes);

// Serves the built pos-web frontend (npm run build's dist/ output) so the
// customer QR ordering PWA (HashRouter route /order/:shopId - see
// src/App.tsx) is reachable from a customer's own phone browser at this
// same public domain, without needing the Electron app at all. Staff still
// normally use the Electron shell, which loads its own local copy of this
// same build - this is purely an ADDITIONAL way to reach it, over plain
// HTTP(S). Because this app is HashRouter-based (see src/main.tsx), every
// real route lives after the "#" and is resolved entirely client-side -
// Express only ever needs to serve index.html/manifest.json/sw.js at "/",
// never a wildcard catch-all for arbitrary paths. Registered BEFORE the
// plain-text "/" handler below so it actually gets first crack at "/" once
// dist/ exists; if dist/ doesn't exist yet, express.static just calls
// next() and the plain-text handler still answers instead of 404ing.
const distPath = path.join(__dirname, "..", "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

app.get("/", (req, res) => {
    res.send("POS Backend Running ...");
});

// Global error handler - catches synchronous throws from any middleware
// (e.g. shopScope() in middleware/attachShopScope.js when shopId is
// unexpectedly missing) and anything explicitly passed to next(err).
// Kept last, after all routes.
app.use((err, req, res, next) => {
  console.error(`[HTTP ERROR] ${req.method} ${req.originalUrl}:`, err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({ message: err.message || "Internal server error" });
});

let serverInstance = null;

async function startBackend(port = 5000) {
  if (serverInstance) return serverInstance;

  try {
    await connectDB();
    await seedDefaults();
    // Starts the background connectivity poller (see
    // config/connectivityMonitor.js) - runs continuously on its own
    // 5-second timer from here on, independent of the HTTP server.
    connectivityMonitor.start();

    return new Promise((resolve, reject) => {
      const PORT = process.env.PORT || port;
      serverInstance = app.listen(PORT, () => {
        console.log(`Backend server running on port ${PORT}`);
        resolve(serverInstance);
      });
      serverInstance.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${PORT} is already in use. Please close any other application using this port.`));
        } else {
          reject(err);
        }
      });
    });
  } catch (error) {
    console.error("Failed to start backend:", error);
    throw error;
  }
}

async function stopBackend() {
  connectivityMonitor.stop();
  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
    serverInstance = null;
    console.log("Backend server stopped");
  }
}

// Only auto-start if running directly (not imported)
if (require.main === module) {
  startBackend().catch((error) => {
    console.error("Startup error:", error);
    process.exit(1);
  });
}

module.exports = { app, startBackend, stopBackend };
