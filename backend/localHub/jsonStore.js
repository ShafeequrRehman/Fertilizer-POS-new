const fs = require("fs");
const path = require("path");

// Minimal file-backed collection store for the offline Local Hub (see
// server.js). Deliberately NOT a real database - the local hub only ever
// has to hold a small, temporary queue of orders placed during an
// internet outage at a single till, so a plain JSON file per collection,
// fully loaded into memory and rewritten on every mutation, is simpler
// and safer to ship inside an Electron installer than adding a new
// database dependency (no native compilation, nothing that can fail to
// bundle). If this ever needs to hold serious volume, swap this file for
// a real embedded DB without touching server.js's call sites.
//
// Not safe for multiple Node processes sharing the same data directory -
// fine here, since exactly one Electron main process owns this directory
// at a time.

let dataDir = null;
const cache = new Map(); // name -> in-memory value

function resolveDataDir() {
  if (dataDir) return dataDir;
  dataDir =
    process.env.POS_LOCAL_HUB_DATA_DIR ||
    path.join(__dirname, ".local-hub-data");
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function filePathFor(name) {
  return path.join(resolveDataDir(), `${name}.json`);
}

function load(name, defaultValue) {
  if (cache.has(name)) return cache.get(name);

  const filePath = filePathFor(name);
  let value = defaultValue;
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      value = raw.trim() ? JSON.parse(raw) : defaultValue;
    }
  } catch (error) {
    console.error(`[localHub/jsonStore] Failed to read ${filePath}, starting fresh:`, error.message);
    value = defaultValue;
  }
  cache.set(name, value);
  return value;
}

function save(name, value) {
  cache.set(name, value);
  const filePath = filePathFor(name);
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    console.error(`[localHub/jsonStore] Failed to write ${filePath}:`, error.message);
  }
}

// Resets the in-memory cache (test/dev convenience only).
function _resetCacheForTests() {
  cache.clear();
  dataDir = null;
}

module.exports = { load, save, resolveDataDir, _resetCacheForTests };
