const crypto = require("crypto");
const store = require("./jsonStore");

// The Local Hub's whole security model rests on this key, not on verifying
// the shop's normal JWT signature - see server.js's file-level comment for
// why (the desktop's bundled backend and the cloud backend can have
// different JWT_SECRET values, so signature verification isn't a safe
// bridge between them). Physical LAN access + knowing this key (shown as a
// QR code / plain text on the till, entered once on the phone) is the
// trust boundary instead - the same shape as this app's existing Cancel
// Order Key / Page Visibility Key patterns, just for LAN pairing instead
// of a specific action.
const META_KEY = "meta";

function readMeta() {
  return store.load(META_KEY, { pairingKey: null });
}

function generateKey() {
  // 8 uppercase alphanumeric chars, no ambiguous 0/O/1/I - easy to read off
  // a screen and type on a phone keyboard.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let key = "";
  for (let i = 0; i < 8; i++) {
    key += alphabet[crypto.randomInt(alphabet.length)];
  }
  return key;
}

function getOrCreatePairingKey() {
  const meta = readMeta();
  if (meta.pairingKey) return meta.pairingKey;
  meta.pairingKey = generateKey();
  store.save(META_KEY, meta);
  return meta.pairingKey;
}

function rotatePairingKey() {
  const meta = readMeta();
  meta.pairingKey = generateKey();
  store.save(META_KEY, meta);
  return meta.pairingKey;
}

function isValidKey(candidate) {
  const meta = readMeta();
  return Boolean(candidate) && meta.pairingKey && String(candidate) === meta.pairingKey;
}

module.exports = { getOrCreatePairingKey, rotatePairingKey, isValidKey };
