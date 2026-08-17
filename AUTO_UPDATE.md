# Auto-Update - How It Works & How To Ship An Update

Two separate mechanisms, since desktop and mobile can't update the same way.

## Desktop (Electron till)

Uses `electron-updater`, checking GitHub Releases on the private repo
`github.com/haider7c/pos-web-new`. Every till checks on launch and every 4
hours after. When a new version is found it downloads silently in the
background; a "Restart to Update" button appears in the topbar once it's
ready - clicking it installs and relaunches automatically, no manual
download or running an installer.

### One-time setup (do this once)

1. Create a GitHub personal access token with read access to
   `haider7c/pos-web-new` (Settings -> Developer settings -> Fine-grained
   tokens -> this repo only -> Contents: Read).
2. Add it to `pos-web/.env`:
   ```
   GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
   ```
   This file already ships inside the packaged app (see `package.json`'s
   `extraResources`), so every till will have this token and be able to
   check/download from the private repo automatically. It's also used
   below for publishing.

### Shipping an update

1. Bump the version in `pos-web/package.json` (e.g. `0.1.0` -> `0.1.1`).
2. Commit and push as usual.
3. From `pos-web/`, with `GH_TOKEN` available in your terminal (either
   already in `.env`/loaded, or `set GH_TOKEN=ghp_xxx` in PowerShell for
   that session):
   ```
   npm run electron:publish
   ```
   This builds the app and uploads the installer + update metadata
   (`latest.yml`) to a new GitHub Release. That's it - every till still
   running the old version will find it on its next check (within 4 hours,
   or immediately on next app launch) and update itself.

Tills running in dev mode (`npm run dev`/`npm run electron`) never check for
updates - only the packaged, installed app does.

## Mobile (pos-mobile APK)

pos-mobile isn't on the Play Store - it's a sideloaded APK shared with staff
phones (see `eas.json`). Android won't let a regular app silently
self-install another APK, so this can't be fully automatic like desktop:
the app checks for a newer version on launch and shows a banner; tapping it
opens the download, and the phone still needs one tap to confirm the
install (same as any sideloaded app).

### Shipping an update

1. Bump the version in `pos-mobile/app.json` (`expo.version`).
2. Build the APK: `eas build --platform android --profile preview` (from
   `pos-mobile/`).
3. Download the built APK from the EAS build page.
4. Copy it into `pos-web/backend/public/apk/` (this is served publicly at
   `/apk/<filename>` by the same backend the apps already talk to).
5. From `pos-web/`, point the update check at it:
   ```
   npm run set-app-version -- android 0.2.0 https://sybersoc.duckdns.org/pos/apk/pos-mobile-0.2.0.apk "What changed in this build"
   ```
   (Swap in the real backend URL/APK filename/version.)

No server restart needed - every phone will see the update banner the next
time the app is opened.
