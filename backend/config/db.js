const mongoose = require("mongoose");
const dns = require("dns");
const fs = require("fs");
const { exec } = require("child_process");

// Single database, reached directly: Express -> Mongoose -> MongoDB Atlas.
// No local/cloud split and no HTTP sync layer anymore.
const mongoURI = process.env.MONGO_URI;

const hasValidMongoURI = mongoURI && mongoURI !== "undefined" && mongoURI !== "null" && mongoURI.length > 10;

// In a packaged Electron build there's no terminal attached to see
// console.log output in (see main.js, which sets this env var to the same
// desktop.log it writes its own runtime log to) - mirror every connect/
// disconnect/retry message there too, so a connectivity problem is
// actually diagnosable without running the app from a dev terminal first.
// Falls back to a no-op outside Electron (dev via `node backend/index.js`,
// where the console itself is already visible).
function logConnectionEvent(message) {
  console.log(message);
  const logFile = process.env.POS_RUNTIME_LOG_FILE;
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] [db] ${message}\n`);
  } catch {
    // Best-effort only - never let logging itself take down the connection
    // attempt it's trying to describe.
  }
}

// ---------------------------------------------------------------------
// Reliable DNS resolution, independent of whatever the OS/router/ISP's
// resolver is doing.
//
// Real incident this fixes: a shop's Atlas connection died with a TCP
// timeout to the shard hosts (not a rejected connection - a silent
// packet drop), on every network they tried, and only came back after
// running `ipconfig /flushdns` on Windows. That command clears Windows'
// OWN resolver cache, which strongly suggests a stale/bad cached DNS
// answer (from the ISP's resolver, the router's DNS forwarder, or
// Windows itself) was the actual cause - not Atlas, not the app, not
// the IP access list.
//
// `ipconfig /flushdns` only clears Windows' cache for THIS process's
// future lookups going through the OS resolver - it can't be run from
// inside Node in a way that's guaranteed to help next time, and it's a
// manual step a shop owner shouldn't have to remember under pressure.
// So instead: override every DNS lookup Node does (including the ones
// the MongoDB driver does internally via net/tls sockets) to go
// straight to Google/Cloudflare's public resolvers, bypassing whatever
// local resolver was holding the stale answer in the first place. This
// is the actual permanent fix - the flush was only ever a symptom of
// "ask a different, unstuck resolver", which this does automatically,
// every time, on every network.
const reliableResolver = new dns.Resolver();
reliableResolver.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4", "1.0.0.1"]);

const originalLookup = dns.lookup.bind(dns);
const net = require("net");

// dns.lookup's real signature is (hostname, options?, callback), where
// options can be omitted, a bare number (legacy shorthand for family: 4
// or 6), or an { family, all, hints, verbatim } object - every one of
// those forms has to keep working here since this replaces the lookup
// function used by EVERY networking call in the process (http requests,
// the WhatsApp library, etc.), not just MongoDB's.
dns.lookup = (hostname, options, callback) => {
  let cb = callback;
  let opts = options;
  if (typeof options === "function") {
    cb = options;
    opts = {};
  } else if (typeof options === "number") {
    opts = { family: options };
  } else if (!options) {
    opts = {};
  }

  // IP literals (and localhost-style loopback) resolve instantly with no
  // network round-trip in real dns.lookup - a public resolver has no way
  // to know about "localhost" or an already-literal IP, so those always
  // go straight to the OS path rather than through Google/Cloudflare.
  if (net.isIP(hostname) || hostname === "localhost") {
    return originalLookup(hostname, options, callback);
  }

  const wantAll = !!opts.all;
  const wantFamily = opts.family; // 0, 4, 6, or undefined

  function respond(results) {
    if (wantAll) return cb(null, results);
    return cb(null, results[0].address, results[0].family);
  }

  function tryFamily(fam, onFail) {
    const method = fam === 6 ? "resolve6" : "resolve4";
    reliableResolver[method](hostname, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        return respond(addresses.map((address) => ({ address, family: fam })));
      }
      onFail();
    });
  }

  const fallbackToOs = () => originalLookup(hostname, options, callback);

  if (wantFamily === 4) {
    tryFamily(4, fallbackToOs);
  } else if (wantFamily === 6) {
    tryFamily(6, fallbackToOs);
  } else {
    // No family requested - try IPv4 first (matches how most of this
    // app's own outbound calls behave today), then IPv6, then give up
    // to the OS resolver as a last resort rather than ever hard-failing
    // a lookup this override didn't need to touch (e.g. an internal
    // hostname Google/Cloudflare have never heard of).
    tryFamily(4, () => tryFamily(6, fallbackToOs));
  }
};

// Best-effort, Windows-only, never blocks or throws - this is kept as a
// second line of defense alongside the resolver override above, since
// it's exactly the manual step that resolved the real incident this is
// all based on.
function flushOsDnsCacheBestEffort() {
  if (process.platform !== "win32") return;
  exec("ipconfig /flushdns", (error) => {
    if (error) {
      console.warn("[db] ipconfig /flushdns failed (non-fatal):", error.message);
    }
  });
}

// ---------------------------------------------------------------------
// Connection with automatic, indefinite retry.
//
// Previously: a failed initial mongoose.connect() call was caught,
// logged, and never retried - the comment here claimed "Mongoose keeps
// retrying the connection in the background", but that's only true
// AFTER a first successful connection; if the very first attempt
// throws, no ongoing retry loop ever gets established, and the app
// stays broken until someone manually restarts it. That's exactly what
// turned a transient DNS/network blip into "the software randomly
// stopped working for hours." This now retries on a backoff, forever,
// until it connects - no restart, no manual fix, required.
const RETRY_DELAY_START_MS = 5000;
const RETRY_DELAY_MAX_MS = 60000;

let retryTimer = null;
let retryDelayMs = RETRY_DELAY_START_MS;

function scheduleRetry(onConnected) {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    await attemptConnect(onConnected);
  }, retryDelayMs);
  if (retryTimer.unref) retryTimer.unref();
  retryDelayMs = Math.min(retryDelayMs * 1.5, RETRY_DELAY_MAX_MS);
}

// Runs once per successful connection (including reconnects) to guarantee
// every index actually declared in the schema files (schema.index(...)
// calls, e.g. Order.js's { shopId: 1, createdAt: -1 }) really exists on
// the live database - not just in the code. Mongoose's default autoIndex
// behavior is supposed to build these automatically on connect, but that's
// silent and easy to end up without in practice (a collection created
// before the index existed in the code, autoIndex disabled somewhere, a
// background build that errored and was never retried, etc.) - and the
// symptom when it's missing isn't an error, it's just every query on that
// collection silently falling back to a full collection scan, getting
// slower as the collection grows. That's exactly what was happening to
// getOrders (see orderController.js's own debug timing): 1063 documents
// taking 10+ seconds to fetch, which only makes sense as a COLLSCAN, not
// an indexed lookup. syncIndexes() is idempotent and cheap when indexes
// already match the schema - safe to run on every connect, not just once.
async function ensureCriticalIndexes() {
  try {
    const Order = require("../models/Order");
    const start = Date.now();
    const dropped = await Order.syncIndexes();
    const indexes = await Order.collection.indexes();
    logConnectionEvent(
      `[db] Order.syncIndexes() done in ${Date.now() - start}ms - ` +
      `dropped: ${dropped.length ? dropped.join(", ") : "none"} - ` +
      `current indexes: ${indexes.map((idx) => JSON.stringify(idx.key)).join(", ")}`
    );
  } catch (error) {
    logConnectionEvent(`[db] Order.syncIndexes() failed (non-fatal, queries may stay slow): ${error.message}`);
  }
}

async function attemptConnect(onConnected) {
  flushOsDnsCacheBestEffort();

  try {
    await mongoose.connect(mongoURI, {
      // Deliberately shorter than the frontend's own request timeout
      // (AXIOS_REQUEST_TIMEOUT_MS in src/lib/api.ts, 8000ms) - this used to
      // be 10000ms, which meant a query issued while Atlas was unreachable
      // could still be "trying" past the point the frontend had already
      // given up and shown a bare, generic "timeout of 8000ms exceeded"
      // instead of ever getting a chance to surface this module's own
      // clear "database unavailable" error (see index.js's readyState
      // check) or logConnectionEvent's message below.
      serverSelectionTimeoutMS: 6000,
      socketTimeoutMS: 45000,
    });
    logConnectionEvent("✅ MongoDB Atlas Connected");
    retryDelayMs = RETRY_DELAY_START_MS; // reset backoff for any future disconnect
    void ensureCriticalIndexes();
    if (onConnected) onConnected();
  } catch (error) {
    logConnectionEvent(`❌ MongoDB Connection Error: ${error.message}`);
    logConnectionEvent(`⚠️ Retrying in ${Math.round(retryDelayMs / 1000)}s - the app stays open in the meantime and will connect automatically once reachable.`);
    scheduleRetry(onConnected);
  }
}

// Once mongoose has connected successfully at least once, the MongoDB
// driver's own topology monitoring handles reconnection on its own for
// any LATER drop - this "disconnected" handler is only a safety net for
// the rare case that the driver gives up retrying entirely.
mongoose.connection.on("disconnected", () => {
  if (!hasValidMongoURI) return;
  logConnectionEvent("⚠️ MongoDB disconnected mid-session - retrying automatically...");
  scheduleRetry();
});

const connectDB = async () => {
  if (!hasValidMongoURI) {
    console.error("❌ MONGO_URI is not set in pos-web/.env. Add your MongoDB Atlas connection string.");
    return mongoose;
  }

  // Without this, a query issued while disconnected (e.g. Atlas is
  // unreachable) silently "buffers" for up to 10s before finally erroring -
  // that's exactly what turned a DNS/network failure into a confusing
  // client-side "Login request timed out" 8+ seconds later instead of an
  // immediate, readable error. With buffering off, a query issued while
  // disconnected rejects instantly with a clear message.
  mongoose.set("bufferCommands", false);

  // Deliberately not awaited all the way through retries - the app (and
  // its HTTP server) should start immediately either way; requireLicenseValid
  // /the readyState check already make routes fail fast with a clear
  // message until this succeeds, and it keeps trying silently underneath.
  await attemptConnect();
  return mongoose;
};

module.exports = { connectDB };
