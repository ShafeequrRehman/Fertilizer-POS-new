const mongoose = require("mongoose");

// Continuously (every CHECK_INTERVAL_MS) verifies real internet
// connectivity in the background, independent of whether any HTTP request
// is currently in flight. backend/index.js's GET /api/health route just
// reads the cached result from here instantly instead of performing a
// fresh ping on every single request that comes in - this module is the
// thing that's actually running "continuously".
//
// Why ping MongoDB Atlas specifically: this desktop app runs its own
// Express server in-process on the same machine (see main.js's
// startBackendServer) and the renderer talks to it over localhost - so
// localhost reachability proves nothing about whether the machine has
// internet; that stays up even in airplane mode. The one thing that
// genuinely requires internet is the outbound connection to MongoDB Atlas,
// so that's the real signal used here.
//
// mongoose.connection.readyState alone is not trustworthy for this: it is
// a cached flag that only updates once the driver's own background
// heartbeat (or a query) notices the connection is gone, which can lag
// well behind the internet actually dropping - an idle TCP socket can look
// "connected" for a while after the network is cut, since nothing forces
// the OS to notice until something tries to use it. So every tick here
// does a real ping, raced against its own short timeout, so a hung/half-
// dead connection can never make this look falsely "online".
const CHECK_INTERVAL_MS = 5000;
const PING_TIMEOUT_MS = 4000;

let isOnline = false;
let lastCheckedAt = null;
let timer = null;

async function checkNow() {
  try {
    if (mongoose.connection.readyState !== 1) {
      throw new Error("Mongoose reports not connected");
    }
    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("connectivity ping timed out")), PING_TIMEOUT_MS)),
    ]);
    isOnline = true;
  } catch (error) {
    isOnline = false;
  }
  lastCheckedAt = Date.now();
  return isOnline;
}

function start() {
  if (timer) return; // already running - safe to call more than once
  void checkNow();
  timer = setInterval(() => void checkNow(), CHECK_INTERVAL_MS);
  // A background housekeeping timer shouldn't be the reason the process
  // stays alive (e.g. during graceful shutdown/tests) if everything else
  // has already finished.
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function getStatus() {
  return { isOnline, lastCheckedAt };
}

module.exports = { start, stop, checkNow, getStatus };
