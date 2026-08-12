const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Public, no-auth, no-DB "is there a newer mobile app?" check - pos-mobile
// has no in-store auto-update mechanism (it's a sideloaded APK, not on the
// Play Store), so this is what makes its update banner possible: on launch
// it calls GET /api/app-version?platform=android and compares the returned
// version against its own (see pos-mobile/src/lib/app-update.ts).
//
// Deliberately file-backed instead of a DB model/mongoose - this needs to
// keep working even if MongoDB Atlas is unreachable (same reasoning as
// /api/health, see index.js), and it changes maybe once every few weeks
// whenever a new APK ships, so there's no real benefit to a DB round-trip.
// Update it with `node backend/scripts/setAppVersion.js` after building a
// new APK - see that script for usage.
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'appVersion.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

router.get('/', (req, res) => {
  const platform = String(req.query.platform || 'android');
  const config = readConfig();
  const entry = config[platform];
  if (!entry) {
    return res.json({ platform, version: null, url: null, notes: null });
  }
  res.json({ platform, version: entry.version || null, url: entry.url || null, notes: entry.notes || null });
});

module.exports = router;
