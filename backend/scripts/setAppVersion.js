// Updates backend/config/appVersion.json - what pos-mobile's update banner
// checks against (see routes/appVersionRoutes.js). Run this on the server
// after building and uploading a new pos-mobile APK, so phones start
// showing the "Update available" banner.
//
// Usage (run from pos-web/):
//   node backend/scripts/setAppVersion.js <platform> <version> <url> ["notes"]
//
// Example, after building pos-mobile 0.2.0 and copying the APK into
// backend/public/apk/ (served at /apk/<filename> - see index.js):
//   node backend/scripts/setAppVersion.js android 0.2.0 https://sybersoc.duckdns.org/pos/apk/pos-mobile-0.2.0.apk "Fixes kitchen ticket printing"
//
// <version> must be plain semver (e.g. "0.2.0", no leading "v") - it's
// compared against pos-mobile's own app.json version with the same
// major.minor.patch numeric comparison, not a string comparison.

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "appVersion.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function isValidSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function run() {
  const [platform, version, url, notes] = process.argv.slice(2);

  if (!platform || !version || !url) {
    console.error('Usage: node backend/scripts/setAppVersion.js <platform> <version> <url> ["notes"]');
    process.exit(1);
  }
  if (!isValidSemver(version)) {
    console.error(`"${version}" is not a valid version - use plain major.minor.patch, e.g. 0.2.0 (no "v" prefix).`);
    process.exit(1);
  }

  const config = readConfig();
  config[platform] = { version, url, notes: notes || "" };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  console.log(`Set ${platform} latest version to ${version}.`);
  console.log(`Download URL: ${url}`);
  if (notes) console.log(`Notes: ${notes}`);
  console.log("Phones will see the update banner next time they open the app (no server restart needed).");
}

run();
