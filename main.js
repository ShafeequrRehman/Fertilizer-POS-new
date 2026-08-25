const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const pdfPrinter = require("pdf-to-printer");
const React = require("react");
const ReactPDF = require("@react-pdf/renderer");
const { autoUpdater } = require("electron-updater");

const { Document, Page, StyleSheet, Text, View, Image } = ReactPDF;

// Fix for net_error -202 (ERR_CERT_AUTHORITY_INVALID) when talking to cloud API
app.commandLine.appendSwitch('ignore-certificate-errors');

const LOADING_SCREEN_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>POS System</title>
    <style>
      :root {
        color-scheme: light;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Segoe UI", Tahoma, sans-serif;
        background:
          radial-gradient(circle at top, rgba(247, 179, 43, 0.18), transparent 32%),
          linear-gradient(135deg, #f5efe4 0%, #fff9f1 55%, #f2f6fb 100%);
        color: #18212f;
      }

      .shell {
        width: min(520px, calc(100vw - 48px));
        padding: 32px 28px;
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.86);
        border: 1px solid rgba(24, 33, 47, 0.08);
        box-shadow: 0 24px 64px rgba(24, 33, 47, 0.14);
        backdrop-filter: blur(14px);
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(195, 112, 42, 0.1);
        color: #8c3d16;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      h1 {
        margin: 18px 0 10px;
        font-size: clamp(28px, 5vw, 42px);
        line-height: 1.05;
      }

      p {
        margin: 0;
        font-size: 15px;
        line-height: 1.7;
        color: #4c5667;
      }

      .meter {
        margin-top: 24px;
        height: 10px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(24, 33, 47, 0.09);
      }

      .meter::before {
        content: "";
        display: block;
        width: 42%;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #d95f1a, #f2b84b);
        animation: progress 1.15s ease-in-out infinite;
      }

      .pulse {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: #d95f1a;
        box-shadow: 0 0 0 rgba(217, 95, 26, 0.45);
        animation: pulse 1.6s infinite;
      }

      @keyframes progress {
        0% {
          transform: translateX(-120%);
        }
        100% {
          transform: translateX(320%);
        }
      }

      @keyframes pulse {
        0% {
          box-shadow: 0 0 0 0 rgba(217, 95, 26, 0.42);
        }
        70% {
          box-shadow: 0 0 0 14px rgba(217, 95, 26, 0);
        }
        100% {
          box-shadow: 0 0 0 0 rgba(217, 95, 26, 0);
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="eyebrow">
        <span class="pulse"></span>
        Starting POS System
      </div>
      <h1>Preparing your workspace</h1>
      <p>The desktop app is loading local data, syncing essential services, and opening your dashboard.</p>
      <div class="meter"></div>
    </main>
  </body>
</html>`;

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  const dev = !app.isPackaged;
  const runtimeDataDir = path.join(app.getPath("userData"), "runtime");
  const runtimeLogFile = path.join(runtimeDataDir, "desktop.log");

  // Set only by `npm run dev` (see dev:electron script in package.json).
  // When present, the Vite dev server and the Express backend are already
  // running as separate processes (started by `vite` and
  // `node backend/index.js`), and `wait-on` has already confirmed both
  // ports are open before Electron was even launched. In that case this
  // window should just attach to the Vite dev server directly. Leave this
  // unset (the default) for `npm run electron` and for the packaged
  // production app, both of which load the static production build
  // (`dist/index.html`) produced by `vite build` instead.
  const devServerUrl = process.env.ELECTRON_DEV_SERVER_URL || null;

  let backendPort = 5000;
  let mainWindow = null;
  let backendStarted = false;
  let localHubStarted = false;
  // Set whenever startLocalHubServer's try/catch below actually catches
  // something (most commonly EADDRINUSE - a previous run's process still
  // holding port 5057). Exposed to the renderer via get-local-hub-status
  // so a genuinely failed start shows a real reason in the UI instead of
  // a generic "not reachable" that looks identical to "hasn't started yet".
  let localHubStartError = null;

  if (!fs.existsSync(runtimeDataDir)) {
    fs.mkdirSync(runtimeDataDir, { recursive: true });
  }

  // Local Hub (see backend/localHub/server.js) data lives under userData,
  // same as everything else this app persists locally - separate from
  // `runtimeDataDir` (just logs) and unrelated to the legacy embedded
  // backend's MongoDB connection. Setting this env var before the module
  // is ever required is what points its file-backed store here instead of
  // a path relative to the (possibly read-only, inside an asar) install
  // directory.
  process.env.POS_LOCAL_HUB_DATA_DIR = path.join(app.getPath("userData"), "local-hub");

  // Same reasoning as POS_LOCAL_HUB_DATA_DIR above - the embedded backend
  // (backend/config/db.js) runs in-process inside this same Electron main
  // process, so its own console.log/console.error calls (Mongo connect/
  // disconnect/retry messages) have nowhere visible to go in a packaged
  // app - there's no terminal attached to a double-clicked .exe. Pointing
  // it at this same desktop.log file (already written by logRuntime below)
  // means a shop owner - or anyone helping them remotely - can actually see
  // *why* the app is timing out ("MongoDB Connection Error: ...") without
  // needing to run the app from a terminal first.
  process.env.POS_RUNTIME_LOG_FILE = runtimeLogFile;

  function logRuntime(message, error) {
    const line = `[${new Date().toISOString()}] ${message}${error ? `\n${error.stack || error.message || String(error)}` : ""}\n`;
    try {
      fs.appendFileSync(runtimeLogFile, line);
    } catch (writeError) {
      console.error("Failed to write runtime log:", writeError);
    }
    console.log(line.trim());
  }

  function reportFatal(title, error) {
    logRuntime(title, error);
    if (app.isReady()) {
      dialog.showErrorBox(title, error?.stack || error?.message || String(error));
    }
  }

  process.on("uncaughtException", (error) => {
    reportFatal("Uncaught Exception", error);
  });

  process.on("unhandledRejection", (reason) => {
    reportFatal("Unhandled Rejection", reason);
  });

  // Load .env from the correct location
  let envLoaded = false;
  const possibleEnvPaths = [
    path.join(__dirname, ".env"),
    path.join(process.resourcesPath, ".env"),
    path.join(app.getAppPath(), ".env")
  ];

  for (const envPath of possibleEnvPaths) {
    if (fs.existsSync(envPath)) {
      require("dotenv").config({ path: envPath });
      logRuntime(`Loaded .env from ${envPath}`);
      envLoaded = true;
      break;
    }
  }

  if (!envLoaded) {
    require("dotenv").config();
    logRuntime("Loaded .env from default location");
  }

  process.env.ELECTRON_IS_PACKAGED = String(app.isPackaged);
  process.env.NODE_ENV = dev ? "development" : "production";

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      // The dashboard layouts (POS checkout, Sales order details, etc.) are
      // built to always sit side-by-side rather than stack/scroll
      // horizontally - that only holds up down to a sane minimum window
      // width, so the window itself is not allowed to get narrower than
      // that instead of letting content overflow.
      minWidth: 1100,
      minHeight: 650,
      autoHideMenuBar: true,
      show: true,
      backgroundColor: "#f5efe4",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
      icon: path.join(__dirname, "public/icon-512.png"),
    });
    mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(LOADING_SCREEN_HTML)}`);

    mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
      logRuntime(`Renderer failed to load ${url} (${code}): ${description}`);
    });

    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      const error = new Error(`Renderer process gone: ${details.reason}`);
      reportFatal("Renderer Crash", error);
    });

    mainWindow.on("unresponsive", () => {
      logRuntime("Main window became unresponsive");
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    if (dev) {
      mainWindow.webContents.openDevTools();
    }
  }

  async function startBackendServer() {
    if (backendStarted) return true;

    try {
      // Find backend directory
      let backendDir = path.join(__dirname, "backend");
      if (!fs.existsSync(backendDir) && process.resourcesPath) {
        backendDir = path.join(process.resourcesPath, "backend");
      }

      const backendIndexPath = path.join(backendDir, "index.js");

      if (!fs.existsSync(backendIndexPath)) {
        logRuntime(`Backend not found at ${backendIndexPath}`);
        return false;
      }

      logRuntime(`Loading backend from ${backendIndexPath}`);

      // Clear cache to ensure fresh module load
      delete require.cache[require.resolve(backendIndexPath)];

      // Import and start backend
      const { startBackend } = require(backendIndexPath);
      await startBackend(backendPort);

      backendStarted = true;
      logRuntime(`Backend server started successfully on port ${backendPort}`);
      return true;
    } catch (error) {
      logRuntime("Failed to start backend", error);
      // Don't throw - allow app to continue in offline mode
      return false;
    }
  }

  // Unlike startBackendServer (the legacy full API, gated on VITE_API_URL
  // being unset because it needs MongoDB Atlas), the Local Hub starts
  // ALWAYS - it's what lets this till take orders offline and lets a
  // paired phone reach it over LAN, regardless of whether this till
  // itself is also configured to talk to the cloud. See
  // backend/localHub/server.js for the full design rationale.
  async function startLocalHubServer() {
    if (localHubStarted) return true;

    try {
      let backendDir = path.join(__dirname, "backend");
      if (!fs.existsSync(backendDir) && process.resourcesPath) {
        backendDir = path.join(process.resourcesPath, "backend");
      }
      const localHubPath = path.join(backendDir, "localHub", "server.js");

      if (!fs.existsSync(localHubPath)) {
        logRuntime(`Local Hub not found at ${localHubPath}`);
        return false;
      }

      delete require.cache[require.resolve(localHubPath)];
      const { startLocalHub } = require(localHubPath);
      await startLocalHub();

      localHubStarted = true;
      localHubStartError = null;
      logRuntime("Local Hub started successfully");
      return true;
    } catch (error) {
      localHubStartError = error?.code ? `${error.code}: ${error.message}` : (error?.message || String(error));
      logRuntime("Failed to start Local Hub - offline mode will be unavailable this session", error);
      // Never fatal - the till should still work normally against the
      // cloud even if the Local Hub couldn't bind its port for some reason
      // (e.g. another instance already running).
      return false;
    }
  }

  async function stopLocalHubServer() {
    if (!localHubStarted) return;
    try {
      let backendDir = path.join(__dirname, "backend");
      if (!fs.existsSync(backendDir) && process.resourcesPath) {
        backendDir = path.join(process.resourcesPath, "backend");
      }
      const localHubPath = path.join(backendDir, "localHub", "server.js");
      if (fs.existsSync(localHubPath)) {
        const { stopLocalHub } = require(localHubPath);
        await stopLocalHub();
        logRuntime("Local Hub stopped");
      }
    } catch (error) {
      logRuntime("Error stopping Local Hub", error);
    }
    localHubStarted = false;
  }

  // Auto-update via electron-updater, checking GitHub Releases on the
  // (private) haider7c/pos-web-new repo - see package.json's `build.publish`
  // config, and `npm run electron:publish` for how a new release actually
  // gets uploaded there. Private-repo access needs a `GH_TOKEN` env var
  // (a GitHub personal access token with read access to this repo) present
  // at runtime - it's loaded the same way as everything else in `.env`
  // above, and `.env` is bundled into the packaged app via `extraResources`,
  // so adding `GH_TOKEN=...` to `pos-web/.env` before building is enough;
  // no separate wiring needed here.
  //
  // Never runs for `npm run dev`/`npm run electron` (unpackaged) - there's
  // nothing published for those, and it would just log noisy failed-check
  // errors every run.
  let updateAlreadyDownloaded = false;

  function setupAutoUpdater() {
    if (dev) {
      logRuntime("Skipping auto-update check - not a packaged build.");
      return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      logRuntime("Checking for app update...");
    });
    autoUpdater.on("update-available", (info) => {
      logRuntime(`App update available: ${info.version}`);
      mainWindow?.webContents.send("app-update-available", { version: info.version });
    });
    autoUpdater.on("update-not-available", () => {
      logRuntime("App is up to date.");
    });
    autoUpdater.on("error", (error) => {
      // Never fatal - the till should keep working normally even if the
      // update check itself fails (no internet, GitHub unreachable, bad
      // token, etc).
      logRuntime("Auto-update check failed", error);
    });
    autoUpdater.on("download-progress", (progress) => {
      mainWindow?.webContents.send("app-update-progress", { percent: progress.percent });
    });
    autoUpdater.on("update-downloaded", (info) => {
      updateAlreadyDownloaded = true;
      logRuntime(`App update downloaded: ${info.version} - ready to install.`);
      mainWindow?.webContents.send("app-update-downloaded", { version: info.version });
    });

    autoUpdater.checkForUpdates().catch((error) => logRuntime("Initial update check failed", error));

    // A till can stay open for days without ever restarting, so checking
    // only once at launch could miss a same-day release entirely. Every 4
    // hours is frequent enough to notice a new release quickly without
    // hammering GitHub's API.
    setInterval(() => {
      autoUpdater.checkForUpdates().catch((error) => logRuntime("Periodic update check failed", error));
    }, 4 * 60 * 60 * 1000);
  }

  ipcMain.handle("check-for-app-updates", async () => {
    if (dev) return { success: false, error: "Not available in dev mode." };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, version: result?.updateInfo?.version };
    } catch (error) {
      return { success: false, error: error.toString() };
    }
  });

  ipcMain.on("install-app-update-now", () => {
    if (!updateAlreadyDownloaded) return;
    // isSilent=true, isForceRunAfter=true - installs without showing the
    // NSIS wizard again (this till was already installed once) and
    // relaunches the app automatically afterward.
    autoUpdater.quitAndInstall(true, true);
  });

  async function loadApp(explicitUrl) {
    if (!mainWindow) {
      createWindow();
    }

    if (!mainWindow) {
      return;
    }

    try {
      if (explicitUrl) {
        // Dev mode: attach to the external Vite dev server.
        await mainWindow.loadURL(explicitUrl);
      } else {
        // `npm run electron` (standalone) and the packaged production app:
        // load the static production build produced by `vite build`.
        // `base: './'` in vite.config.ts makes the build's asset URLs
        // relative so this works correctly under the `file://` origin.
        const distIndexPath = path.join(app.getAppPath(), "dist", "index.html");
        await mainWindow.loadFile(distIndexPath);
      }
      mainWindow.show();
    } catch (error) {
      logRuntime("Failed to load app URL", error);
      // Show error page
      mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(`
        <!DOCTYPE html>
        <html>
        <head><title>Error</title></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <div style="text-align:center;">
            <h1>Failed to Load Application</h1>
            <p>${error.message}</p>
            <button onclick="location.reload()">Retry</button>
          </div>
        </body>
        </html>
      `)}`);
    }
  }

  async function shutdownServers() {
    // Stop backend if it was started
    if (backendStarted) {
      try {
        // Find backend directory again
        let backendDir = path.join(__dirname, "backend");
        if (!fs.existsSync(backendDir) && process.resourcesPath) {
          backendDir = path.join(process.resourcesPath, "backend");
        }
        const backendIndexPath = path.join(backendDir, "index.js");

        if (fs.existsSync(backendIndexPath)) {
          const { stopBackend } = require(backendIndexPath);
          await stopBackend();
          logRuntime("Backend stopped");
        }
      } catch (error) {
        logRuntime("Error stopping backend", error);
      }
      backendStarted = false;
    }
    await stopLocalHubServer();
  }

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Lets the renderer tell "Local Hub never started at all (with a real
  // reason)" apart from "started fine but this particular /health request
  // failed" - see src/lib/local-hub-api.ts's isLocalHubReachable, used to
  // put an actionable message on POSPage/OfflineSyncPage instead of a
  // generic "not reachable".
  ipcMain.handle("get-local-hub-status", () => ({
    started: localHubStarted,
    error: localHubStartError,
  }));

  // Printing Handlers
  ipcMain.handle("get-printers", async () => {
    try {
      if (mainWindow) {
        const printers = await mainWindow.webContents.getPrintersAsync();
        return printers.map(p => p.name);
      }
      return [];
    } catch (error) {
      logRuntime("Error getting printers", error);
      return [];
    }
  });

  // Settings & print-logo persistence -----------------------------------
  // Chromium's localStorage for this app's packaged, file://-loaded
  // production build was not reliably surviving an app restart, which
  // meant printer selections (kitchenPrinter/counterPrinter) and the
  // uploaded receipt logo silently reset every time the app reopened.
  // These mirror both to plain files in Electron's userData directory,
  // which - unlike browser storage - always survives restarts and updates.
  // Read back synchronously the moment the renderer's JS starts (see
  // src/lib/pos-settings.ts / src/lib/print-logo.ts), before anything else
  // has a chance to read localStorage.
  const appSettingsFilePath = path.join(app.getPath("userData"), "pos-settings.json");
  const printLogoFilePath = path.join(app.getPath("userData"), "print-logo.dat");

  ipcMain.handle("save-app-settings", async (_event, settingsJson) => {
    try {
      fs.writeFileSync(appSettingsFilePath, JSON.stringify(settingsJson));
      return { success: true };
    } catch (error) {
      logRuntime("Failed to save app settings to disk", error);
      return { success: false, error: error.toString() };
    }
  });

  // Synchronous on purpose - paired with ipcRenderer.sendSync so the
  // renderer can hydrate localStorage before the very first component
  // reads it, with no async race against page load.
  ipcMain.on("load-app-settings-sync", (event) => {
    try {
      event.returnValue = fs.existsSync(appSettingsFilePath) ? fs.readFileSync(appSettingsFilePath, "utf-8") : null;
    } catch (error) {
      logRuntime("Failed to load app settings from disk", error);
      event.returnValue = null;
    }
  });

  ipcMain.handle("save-print-logo", async (_event, logo) => {
    try {
      fs.writeFileSync(printLogoFilePath, logo || "");
      return { success: true };
    } catch (error) {
      logRuntime("Failed to save print logo to disk", error);
      return { success: false, error: error.toString() };
    }
  });

  ipcMain.on("load-print-logo-sync", (event) => {
    try {
      event.returnValue = fs.existsSync(printLogoFilePath) ? fs.readFileSync(printLogoFilePath, "utf-8") : null;
    } catch (error) {
      logRuntime("Failed to load print logo from disk", error);
      event.returnValue = null;
    }
  });

  const mmToPt = (mm) => (mm * 72) / 25.4;
  const RECEIPT_WIDTH_PT = mmToPt(80);
  // Was 72mm, leaving only ~4mm of margin per side on an 80mm roll - too
  // tight a safety margin against real-world thermal printer calibration
  // drift, which is why price digits on the right (e.g. "Rs 550.00") were
  // getting clipped by the actual printer even though they measured fine
  // on-screen. 68mm gives an extra ~2mm of buffer on each side.
  const RECEIPT_CONTENT_WIDTH_PT = mmToPt(68);
  const h = React.createElement;

  // Scoped to this one shop only, per an explicit request not to change
  // anything for other shops on the same shared codebase. Checks
  // loginUsername/shopName (added to getStoreSettings()'s return
  // specifically for this - see pos-settings.ts's comment) rather than
  // businessEmail, which turned out to default to a placeholder
  // ("admin@vanguard.io") most shops never edit - a check keyed on it
  // silently never matched, which is why the first version of this fix had
  // no visible effect at all. loginUsername/shopName instead mirror
  // exactly what was typed to log in / the shop's registered name, both
  // required fields that can't be blank.
  function isHeavenSliceShop(settings) {
    const haystack = `${settings?.loginUsername || ""} ${settings?.shopName || ""} ${settings?.businessEmail || ""}`.toLowerCase();
    return haystack.includes("heavenslice") || haystack.includes("heaven slice");
  }

  // Heaven Slice's printers were still losing content on the right even
  // after widening the safety margin, because the margin was split EVENLY
  // on both sides (centering) - that pushes the whole content block
  // rightward by half the leftover space instead of using that space as
  // pure safety buffer. Left-flush (all the leftover width kept as margin
  // on the right, only a small fixed margin on the left) means the block
  // starts as close to the paper's true left edge as possible, so a
  // narrower-than-expected printer clips only the unused blank space on
  // the right, never real content. Fixed the kitchen ticket first (KOT
  // Order#4); this is the same treatment for the cashier/customer receipt.
  const LEFT_FLUSH_MARGIN_PT = mmToPt(2);
  function leftFlushPageStyleFor(settings) {
    if (!isHeavenSliceShop(settings)) return receiptStyles.page;
    const totalMargin = RECEIPT_WIDTH_PT - RECEIPT_CONTENT_WIDTH_PT;
    return {
      ...receiptStyles.page,
      paddingLeft: LEFT_FLUSH_MARGIN_PT,
      paddingRight: Math.max(totalMargin - LEFT_FLUSH_MARGIN_PT, LEFT_FLUSH_MARGIN_PT),
    };
  }

  function formatReceiptDate(value) {
    const date = value ? new Date(value) : new Date();
    return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  }

  function formatReceiptTime(value) {
    const date = value ? new Date(value) : new Date();
    return date.toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function getOrderNumber(orderData) {
    const raw = orderData?.dailyOrderNumber ?? orderData?.orderNo ?? orderData?.orderNumber ?? orderData?._id ?? orderData?.id ?? "1";
    const digits = String(raw).match(/\d+$/)?.[0] || String(raw).slice(-3);
    return digits.padStart(3, "0").slice(-3);
  }

  function getItemsTotal(orderData) {
    if (typeof orderData?.total === "number") return orderData.total;
    return (orderData?.items || []).reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
  }

  function estimateReceiptHeightPt(orderData, type, hasLogo) {
    // Order-number token slip - printed before the TakeAway customer
    // receipt so the customer has a small tear-off with just their order
    // number to hold up at the counter. Nothing else on it, so it gets a
    // tiny fixed height instead of running through all the section math
    // below (which assumes a full receipt: header, meta, items, footer).
    if (type === "token") {
      return 50 + 65; // paddingBottom/margin + order label & big number
    }

    let h = 50; // paddingBottom + safety margin

    if (hasLogo) h += 115;
    h += 60; // Store Name + address + rule
    h += 65; // Order label + large number + rule
    if (type === "kitchen") h += 25;
    // kitchen-cancel (whole order cancelled) and kitchen-remove (some
    // items edited out of a still-active order) both print two label
    // lines instead of kitchen's one, plus an optional reason line -
    // see ReceiptPdf below.
    if (type === "kitchen-cancel" || type === "kitchen-remove") h += 50;
    if (type === "kitchen-cancel" && orderData?.cancelReason) h += 20;

    h += 45; // Date, Time, Type
    if (orderData?.customer?.name) h += 15;
    const cashierCustomerShown = type === "cashier" && orderData?.customer?.name && orderData.customer.name !== "Walk-in Customer";
    if (cashierCustomerShown && orderData.customer.phone && orderData.customer.phone !== "03000000000") h += 15;
    if (type === "cashier" && orderData?.customer?.address) h += 15;
    if (orderData?.table) h += 15;
    if (orderData?.waiter) h += 15;
    h += 25; // Dashed rule + "Items:" label

    const items = orderData?.items || [];
    items.forEach(item => {
      const nameLength = String(item.name || "").length;
      const wrappedNameLines = Math.max(1, Math.ceil((nameLength + 4) / 26));
      h += wrappedNameLines * 15;
      if (item.variation) h += 12;
      h += 6; // Item spacing
    });
    h += 15; // Dashed rule

    if (type === "cashier") {
      h += 50; // Items Total, TOTAL, PAID
      if (Number(orderData?.discount?.amount) > 0) h += 15; // Discount row
      const total = getItemsTotal(orderData);
      const amountTendered = orderData?.paidAmount !== undefined ? Math.min(Number(orderData.paidAmount), total) : undefined;
      const dueAmount = Math.max(total - (amountTendered ?? 0), 0);
      if (amountTendered !== undefined) h += 15;
      if (dueAmount > 0) h += 15;
      if (Number(orderData?.previousDues) > 0) h += 60; // Arrears/Arrears+Inv Balance/Invoice Balance/Account Balance rows
      h += 15; // Dashed rule
    }

    h += 50; // Footer
    return h;
  }

  const receiptStyles = StyleSheet.create({
    page: {
      backgroundColor: "#ffffff",
      color: "#000000",
      fontFamily: "Helvetica",
      fontSize: 9.5,
      lineHeight: 1.2,
      paddingTop: 0,
      paddingBottom: 32,
      paddingLeft: (RECEIPT_WIDTH_PT - RECEIPT_CONTENT_WIDTH_PT) / 2,
      paddingRight: (RECEIPT_WIDTH_PT - RECEIPT_CONTENT_WIDTH_PT) / 2,
      width: RECEIPT_WIDTH_PT,
    },
    center: {
      textAlign: "center",
      alignItems: "center",
    },
    storeName: {
      fontSize: 14,
      fontWeight: "bold",
      marginTop: 0,
      marginBottom: 4, // ~5px gap down to the sub-heading line below it
      textAlign: "center",
    },
    small: {
      fontSize: 8.5,
      textAlign: "center",
    },
    rule: {
      borderBottomWidth: 1.5,
      borderBottomColor: "#000000",
      borderBottomStyle: "solid",
      marginVertical: 4,
    },
    dashedRule: {
      borderBottomWidth: 1,
      borderBottomColor: "#000000",
      borderBottomStyle: "dashed",
      marginVertical: 4,
    },
    orderLabel: {
      fontSize: 11,
      fontWeight: "bold",
      marginBottom: 1,
      textAlign: "center",
    },
    orderNumber: {
      fontSize: 45,
      fontWeight: "bold",
      lineHeight: 1,
      textAlign: "center",
    },
    // Kitchen tickets are for staff prepping the order, not the customer -
    // the giant number is less important there than on the cashier's
    // customer-facing receipt, so it's rendered smaller.
    orderNumberKitchen: {
      fontSize: 26,
      fontWeight: "bold",
      lineHeight: 1,
      textAlign: "center",
    },
    ticketLabel: {
      fontSize: 12,
      fontWeight: "bold",
      textAlign: "center",
      marginTop: 4,
      marginBottom: 2,
    },
    // Deliberately louder than the normal kitchen ticketLabel (bigger,
    // red) - this is the one label a busy kitchen printer needs to be
    // impossible to miss at a glance among a stack of tickets.
    ticketLabelCancel: {
      fontSize: 13,
      fontWeight: "bold",
      textAlign: "center",
      marginTop: 4,
      marginBottom: 2,
      color: "#C0392B",
    },
    cancelReason: {
      fontSize: 9,
      fontWeight: "bold",
      textAlign: "center",
      marginBottom: 4,
    },
    meta: {
    },
    variation: {
      fontSize: 7.6,
      marginLeft: 14,
    },
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 6,
    },
    rowLeft: {
      flexGrow: 1,
      flexShrink: 1,
    },
    rowRight: {
      flexGrow: 0,
      flexShrink: 0,
      fontSize: 8.5, // slightly smaller than the base 9.5 so a wide price
      // ("Rs 1234.00") never has to fight the right-hand margin for room
    },
    footer: {
      fontSize: 9,
      marginTop: 7,
      textAlign: "center",
    },
    bold: {
      fontWeight: 700,
    },
  });

  function ReceiptPdf({ orderData, type, printLogo, settings }) {
    const orderNumber = getOrderNumber(orderData);

    // Order-number token slip for TakeAway - printed first, before the
    // customer's cashier receipt, so they have something short with just
    // the number to hold up when their order is ready. Deliberately skips
    // the logo/header/meta/items/footer that every other receipt type has.
    if (type === "token") {
      const pageHeight = estimateReceiptHeightPt(orderData, type, false);
      return h(Document, null,
        h(Page, { size: [RECEIPT_WIDTH_PT, pageHeight], style: receiptStyles.page },
          h(Text, { style: receiptStyles.orderLabel }, "ORDER NO."),
          h(Text, { style: receiptStyles.orderNumber }, orderNumber)
        )
      );
    }

    const items = orderData?.items || [];
    const total = getItemsTotal(orderData);
    // getItemsTotal prefers orderData.total when it's set, which is already
    // net of any discount (see SalesPage.tsx's completeOrder) - that's
    // right for the actual TOTAL line, but it meant "Items Total" printed
    // that SAME already-discounted number, with no discount line anywhere
    // to explain why it was less than the raw item sum. itemsSubtotal is
    // that raw, pre-discount sum specifically for the "Items Total" row.
    const itemsSubtotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
    const discountAmount = Number(orderData?.discount?.amount) || 0;
    const amountTendered = orderData?.paidAmount !== undefined ? Math.min(Number(orderData.paidAmount), total) : undefined;
    const dueAmount = Math.max(total - (amountTendered ?? 0), 0);
    // Dues carried forward from the customer's OTHER unpaid orders, not
    // this one - attached onto orderData at print time by whoever called
    // createReceiptPdfFromOrderData (see SalesPage.tsx's saveUpdate /
    // sendCompletedReceiptOnWhatsApp), so it shows on the customer's
    // receipt exactly like it shows in the Complete Payment panel.
    const previousDues = Number(orderData?.previousDues) || 0;
    const pageHeight = estimateReceiptHeightPt(orderData, type, !!printLogo);

    return h(Document, null,
      h(Page, { size: [RECEIPT_WIDTH_PT, pageHeight], style: leftFlushPageStyleFor(settings) },
        h(View, { style: receiptStyles.center },
          // No fixed height here on purpose - a fixed square box with
          // objectFit:'contain' letterboxes any logo that isn't itself
          // square, which is exactly the visible blank strip above/below
          // the logo on a printed receipt. Capping only the width and
          // letting react-pdf scale height by the image's own aspect ratio
          // means the logo fills its box edge-to-edge for any shape logo.
          printLogo ? h(Image, { src: printLogo, style: { width: 95, marginBottom: 0 } }) : null,
          h(Text, { style: receiptStyles.storeName }, settings?.receiptHeader || "THE HEAVEN SLICE"),
          settings?.receiptSubHeader ? h(Text, { style: receiptStyles.small }, settings.receiptSubHeader) : null,
          settings?.receiptAddress ? h(Text, { style: receiptStyles.small }, settings.receiptAddress) : null,
          settings?.receiptContact ? h(Text, { style: receiptStyles.small }, settings.receiptContact) : null,
          settings?.receiptPaymentInfo ? h(Text, { style: receiptStyles.small }, settings.receiptPaymentInfo) : null
        ),
        h(View, { style: receiptStyles.rule }),
        h(Text, { style: receiptStyles.orderLabel }, "ORDER NO."),
        h(Text, { style: (type === "kitchen" || type === "kitchen-cancel" || type === "kitchen-remove") ? receiptStyles.orderNumberKitchen : receiptStyles.orderNumber }, orderNumber),
        type === "kitchen" ? h(Text, { style: receiptStyles.ticketLabel }, "*** KITCHEN TICKET ***") : null,
        type === "kitchen-cancel" ? h(Text, { style: receiptStyles.ticketLabelCancel }, "*** ORDER CANCELLED ***") : null,
        type === "kitchen-cancel" ? h(Text, { style: receiptStyles.ticketLabel }, "STOP PREPARATION / DISCARD ITEMS") : null,
        type === "kitchen-cancel" && orderData?.cancelReason ? h(Text, { style: receiptStyles.cancelReason }, `REASON: ${String(orderData.cancelReason).toUpperCase()}`) : null,
        // The order itself is still active here - only these specific
        // items were edited out - so the wording deliberately does NOT
        // say "ORDER CANCELLED" (that would wrongly tell the kitchen to
        // stop the whole ticket, see kitchen-cancel above).
        type === "kitchen-remove" ? h(Text, { style: receiptStyles.ticketLabelCancel }, "*** ITEMS REMOVED FROM ORDER ***") : null,
        type === "kitchen-remove" ? h(Text, { style: receiptStyles.ticketLabel }, "DO NOT PREPARE / DISCARD BELOW ITEMS") : null,
        h(View, { style: receiptStyles.rule }),
        h(View, { style: receiptStyles.meta },
          h(Text, null, `DATE: ${formatReceiptDate(orderData?.createdAt)}`),
          h(Text, null, `TIME: ${formatReceiptTime(orderData?.createdAt)}`),
          h(Text, null, `TYPE: ${String(orderData?.orderType || "").toUpperCase()}`),
          orderData?.customer?.name ? h(Text, null, `CUSTOMER: ${String(orderData.customer.name).toUpperCase()}`) : null,
          // Phone/address only belong on the customer's own copy, not the
          // kitchen ticket - see estimateReceiptHeightPt above for the
          // matching height budget. Same "Walk-in Customer" gate as the
          // on-screen ThermalReceipt.tsx uses for its own Customer line
          // (TakeAway/Delivery orders can now be placed with no name at
          // all - see POSPage.tsx's validateOrderForm - and fall back to
          // that exact placeholder, so this print path has to recognize it
          // too or it'd print "PHONE:"/"ADDRESS:" lines with nothing real
          // behind them). Walk-in placeholder phone (03000000000) excluded
          // the same way, since it was never a real number the customer
          // gave. ADDRESS is deliberately NOT gated on name being present -
          // a Delivery order can be placed with an address but no typed
          // name, and the address is exactly what the delivery needs, so it
          // still has to print even then.
          type === "cashier" && orderData?.customer?.name && orderData.customer.name !== "Walk-in Customer" && orderData.customer.phone && orderData.customer.phone !== "03000000000" ? h(Text, null, `PHONE: ${orderData.customer.phone}`) : null,
          type === "cashier" && orderData?.customer?.address ? h(Text, null, `ADDRESS: ${orderData.customer.address}`) : null,
          orderData?.table ? h(Text, null, `TABLE: ${orderData.table}`) : null,
          orderData?.waiter ? h(Text, null, `WAITER: ${String(orderData.waiter).toUpperCase()}`) : null
        ),
        h(View, { style: receiptStyles.dashedRule }),
        h(Text, null, "Items:"),
        h(View, null,
          items.map((item, index) => {
            const quantity = Number(item.quantity || 1);
            const name = String(item.name || "").toUpperCase();
            const itemTotal = Number(item.price || 0) * quantity;
            // Kitchen staff scan this ticket fast, so on kitchen-bound
            // tickets (regular, cancel, and remove - never the customer's
            // cashier receipt) the quantity prefix and the flavour/
            // variation line are bolded to stand out at a glance.
            const isKitchenTicket = type === "kitchen" || type === "kitchen-cancel" || type === "kitchen-remove";
            return h(View, { key: `${name}-${index}`, style: receiptStyles.item },
              h(View, { style: receiptStyles.row },
                h(Text, { style: receiptStyles.rowLeft }, isKitchenTicket ? name : `${quantity}x ${name}`),
                isKitchenTicket
                  ? h(Text, { style: [receiptStyles.bold, receiptStyles.rowRight] }, `${quantity}x`)
                  : type === "cashier"
                    ? h(Text, { style: receiptStyles.rowRight }, `Rs ${itemTotal.toFixed(2)}`)
                    : null
              ),
              item.variation
                ? h(Text, { style: isKitchenTicket ? [receiptStyles.variation, receiptStyles.bold] : receiptStyles.variation }, `- ${String(item.variation).toUpperCase()}`)
                : null
            );
          })
        ),
        h(View, { style: receiptStyles.dashedRule }),
        type === "cashier" ? h(View, null,
          h(View, { style: receiptStyles.row },
            h(Text, null, "Items Total:"),
            h(Text, { style: receiptStyles.rowRight }, `Rs ${itemsSubtotal.toFixed(2)}`)
          ),
          discountAmount > 0 ? h(View, { style: receiptStyles.row },
            h(Text, null, `Discount ${orderData?.discount?.type === "percent" ? `(${orderData.discount.value}% - Percentage)` : "(Fixed Value)"}:`),
            h(Text, { style: receiptStyles.rowRight }, `-Rs ${discountAmount.toFixed(2)}`)
          ) : null,
          h(View, { style: receiptStyles.row },
            h(Text, { style: receiptStyles.bold }, "TOTAL:"),
            h(Text, { style: [receiptStyles.bold, receiptStyles.rowRight] }, `Rs ${total.toFixed(2)}`)
          ),
          h(Text, { style: { marginTop: 6 } }, `PAID: ${String(orderData?.paymentMethod || "Cash").toUpperCase()}`),
          amountTendered !== undefined ? h(Text, null, `AMOUNT TENDERED: Rs ${amountTendered.toFixed(2)}`) : null,
          dueAmount > 0 ? h(Text, null, `DUE: Rs ${dueAmount.toFixed(2)}`) : null,
          // Full arrears breakdown - only for a customer who actually has
          // previous dues (see this receipt's own doc comment); a
          // customer with none never sees any of this, unchanged from
          // before.
          previousDues > 0 ? h(Text, { style: { marginTop: 4 } }, `ARREARS: Rs ${previousDues.toFixed(2)}`) : null,
          previousDues > 0 ? h(View, { style: receiptStyles.row },
            h(Text, null, "ARREARS+INV BALANCE:"),
            h(Text, { style: receiptStyles.rowRight }, `Rs ${(total + previousDues).toFixed(2)}`)
          ) : null,
          previousDues > 0 ? h(View, { style: receiptStyles.row },
            h(Text, null, "INVOICE BALANCE:"),
            h(Text, { style: receiptStyles.rowRight }, `Rs ${dueAmount.toFixed(2)}`)
          ) : null,
          previousDues > 0 ? h(View, { style: receiptStyles.row },
            h(Text, { style: receiptStyles.bold }, "ACCOUNT BALANCE:"),
            h(Text, { style: [receiptStyles.bold, receiptStyles.rowRight] }, `Rs ${(previousDues + dueAmount).toFixed(2)}`)
          ) : null,
          h(View, { style: receiptStyles.dashedRule })
        ) : null,
        h(View, { style: receiptStyles.footer },
          settings?.receiptFooterMessage ? h(Text, { style: receiptStyles.bold }, settings.receiptFooterMessage) : null,
          h(Text, null, "Haider's Creation"),
          h(Text, null, "0315-0707167")
        )
      )
    );
  }

  // --- Alternate receipt templates ----------------------------------------
  // See src/pages/dashboard/components/ReceiptRenderer.tsx (renderer app)
  // for the Settings > Manage Receipt picker that lets a shop choose these,
  // and ItemizedBillReceipt.tsx / KitchenKotReceipt.tsx for the on-screen
  // Print Center preview of the exact same layouts. react-pdf can't render
  // those Tailwind/HTML React components directly - this is a completely
  // separate rendering engine running in the Electron MAIN process, not the
  // renderer - so the same visual template has to be rebuilt here from
  // react-pdf primitives (View/Text/StyleSheet) for what an actual silent
  // PDF print (see createReceiptPdfFromOrderData below) produces. Without
  // this, a shop could pick a template in Settings and see it correctly in
  // the on-screen Print Center, yet every REAL printed ticket would keep
  // silently coming out in the classic ReceiptPdf layout above - exactly
  // the bug this file exists to prevent.

  // Plain-JS port of src/lib/number-to-words.ts's numberToWords - see that
  // file for the full reasoning. Duplicated rather than imported for the
  // same reason every other pure helper in this file is its own copy: this
  // is a separate Node process (Electron main) with no TypeScript loader,
  // not the renderer app's module graph.
  function numberToWordsPdf(value) {
    const ONES = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
    const TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
    function threeDigitsToWords(n) {
      const parts = [];
      if (n >= 100) {
        parts.push(ONES[Math.floor(n / 100)], "HUNDRED");
        n %= 100;
      }
      if (n >= 20) {
        const tensWord = TENS[Math.floor(n / 10)];
        const onesWord = ONES[n % 10];
        parts.push(onesWord ? `${tensWord}-${onesWord}` : tensWord);
      } else if (n > 0) {
        parts.push(ONES[n]);
      }
      return parts.join(" ");
    }
    const n = Math.max(0, Math.round(Math.abs(value || 0)));
    if (n === 0) return "ZERO";
    const groups = [[1000000000, "BILLION"], [1000000, "MILLION"], [1000, "THOUSAND"], [1, ""]];
    let remaining = n;
    const words = [];
    for (const [size, label] of groups) {
      const count = Math.floor(remaining / size);
      if (count > 0) {
        words.push(threeDigitsToWords(count));
        if (label) words.push(label);
        remaining %= size;
      }
    }
    return words.join(" ").replace(/\s+/g, " ").trim();
  }

  const altReceiptStyles = StyleSheet.create({
    boxedType: {
      borderWidth: 1,
      borderColor: "#000000",
      borderStyle: "solid",
      paddingVertical: 3,
      marginVertical: 4,
    },
    boxedTypeText: {
      fontSize: 10,
      fontWeight: "bold",
      textAlign: "center",
    },
    billTitle: {
      fontSize: 13,
      fontWeight: "bold",
      textAlign: "center",
      marginBottom: 4,
    },
    tableHeaderRow: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: "#000000",
      borderBottomStyle: "solid",
      paddingBottom: 2,
      marginBottom: 3,
      gap: 4,
    },
    headerBold: {
      fontSize: 8.5,
      fontWeight: "bold",
    },
    col3: { flexGrow: 3, flexShrink: 1 },
    col1Right: { flexGrow: 1, flexShrink: 0, textAlign: "right", fontSize: 8.5 },
    // Applied to each individual line inside the meta block (Tr#, Date,
    // M/S, Order#, Waiter, etc.) so they have breathing room from each
    // other - react-pdf has no space-y equivalent, this is the per-row
    // substitute (Tailwind's space-y-2 is the web-preview counterpart, see
    // KitchenKotReceipt.tsx/ItemizedBillReceipt.tsx).
    metaRow: { marginBottom: 6 },
  });

  // Customer-facing "Bill" template - see ItemizedBillReceipt.tsx (renderer
  // app) for the on-screen preview this must match.
  function ItemizedBillReceiptPdf({ orderData, printLogo, settings }) {
    const items = orderData?.items || [];
    const orderNumber = getOrderNumber(orderData);
    const subtotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
    const scPercent = Number(settings?.serviceChargePercent) || 0;
    const scAmount = scPercent > 0 ? Math.round((subtotal * scPercent) / 100) : 0;
    const billTotal = typeof orderData?.total === "number" ? orderData.total : Math.max(subtotal + scAmount, 0);
    const discountAmount = Number(orderData?.discount?.amount) || 0;
    const amountTendered = orderData?.paidAmount !== undefined ? Math.min(Number(orderData.paidAmount), billTotal) : undefined;
    const dueAmount = Math.max(billTotal - (amountTendered ?? billTotal), 0);
    const previousDues = Number(orderData?.previousDues) || 0;
    const pageHeight = estimateItemizedBillHeightPt(orderData, !!printLogo, settings);

    return h(Document, null,
      h(Page, { size: [RECEIPT_WIDTH_PT, pageHeight], style: leftFlushPageStyleFor(settings) },
        h(View, { style: receiptStyles.center },
          printLogo ? h(Image, { src: printLogo, style: { width: 90 } }) : null,
          h(Text, { style: receiptStyles.storeName }, settings?.receiptHeader || "THE HEAVEN SLICE"),
          settings?.receiptSubHeader ? h(Text, { style: receiptStyles.small }, settings.receiptSubHeader) : null,
          settings?.receiptAddress ? h(Text, { style: receiptStyles.small }, settings.receiptAddress) : null,
          settings?.receiptContact ? h(Text, { style: [receiptStyles.small, receiptStyles.bold] }, settings.receiptContact) : null
        ),
        h(Text, { style: altReceiptStyles.billTitle }, "Bill"),
        h(View, { style: altReceiptStyles.boxedType },
          h(Text, { style: altReceiptStyles.boxedTypeText }, String(orderData?.orderType || "").toUpperCase())
        ),
        h(View, { style: [receiptStyles.meta, { marginTop: 8, marginBottom: 8 }] },
          h(View, { style: [receiptStyles.row, altReceiptStyles.metaRow] },
            h(Text, null, `Order#: ${orderNumber}`),
            h(Text, null, `${formatReceiptDate(orderData?.createdAt)} ${formatReceiptTime(orderData?.createdAt)}`)
          ),
          orderData?.orderType === "DineIn" && orderData?.table ? h(Text, { style: altReceiptStyles.metaRow }, `Table: ${orderData.table}`) : null,
          h(Text, { style: altReceiptStyles.metaRow }, `M/S: ${String(orderData?.paymentMethod || "Cash").toUpperCase()}`),
          orderData?.waiter ? h(Text, { style: altReceiptStyles.metaRow }, `Waiter: ${orderData.waiter}`) : null,
          orderData?.customer?.name && orderData.customer.name !== "Walk-in Customer" ? h(Text, { style: altReceiptStyles.metaRow }, `Customer: ${orderData.customer.name}`) : null,
          // Same customer/Walk-in gate as the name line above - walk-in
          // placeholder phone (03000000000) excluded since it was never a
          // real number the customer gave. Address is deliberately NOT
          // gated on name being present - a Delivery order can be placed
          // with an address but no typed name, and the address is exactly
          // what the delivery needs, so it still has to print even then.
          orderData?.customer?.name && orderData.customer.name !== "Walk-in Customer" && orderData.customer.phone && orderData.customer.phone !== "03000000000" ? h(Text, { style: altReceiptStyles.metaRow }, `Phone: ${orderData.customer.phone}`) : null,
          orderData?.customer?.address ? h(Text, { style: altReceiptStyles.metaRow }, `Address: ${orderData.customer.address}`) : null
        ),
        h(View, { style: receiptStyles.dashedRule }),
        h(View, { style: altReceiptStyles.tableHeaderRow },
          h(Text, { style: [altReceiptStyles.col3, altReceiptStyles.headerBold] }, "Item"),
          h(Text, { style: [altReceiptStyles.col1Right, altReceiptStyles.headerBold] }, "Qty"),
          h(Text, { style: [altReceiptStyles.col1Right, altReceiptStyles.headerBold] }, "Price"),
          h(Text, { style: [altReceiptStyles.col1Right, altReceiptStyles.headerBold] }, "Amount")
        ),
        h(View, null,
          items.map((item, index) => {
            const quantity = Number(item.quantity || 1);
            const price = Number(item.price || 0);
            return h(View, { key: `${item.name}-${index}`, style: { marginBottom: 2 } },
              h(View, { style: receiptStyles.row },
                h(Text, { style: altReceiptStyles.col3 }, String(item.name || "")),
                h(Text, { style: altReceiptStyles.col1Right }, String(quantity)),
                h(Text, { style: altReceiptStyles.col1Right }, price.toFixed(0)),
                h(Text, { style: altReceiptStyles.col1Right }, (price * quantity).toFixed(0))
              ),
              item.variation ? h(Text, { style: receiptStyles.variation }, `- ${String(item.variation).toUpperCase()}`) : null
            );
          })
        ),
        scAmount > 0 ? h(View, { style: receiptStyles.row },
          h(Text, null, `SC ${scPercent}%`),
          h(Text, { style: receiptStyles.rowRight }, scAmount.toFixed(0))
        ) : null,
        h(View, { style: receiptStyles.rule }),
        h(View, { style: receiptStyles.row },
          h(Text, { style: receiptStyles.bold }, "Total:"),
          h(Text, { style: [receiptStyles.bold, receiptStyles.rowRight] }, (subtotal + scAmount).toFixed(0))
        ),
        discountAmount > 0 ? h(View, { style: receiptStyles.row },
          h(Text, null, `Discount ${orderData?.discount?.type === "percent" ? `(${orderData.discount.value}% - Percentage)` : "(Fixed Value)"}:`),
          h(Text, { style: receiptStyles.rowRight }, `-${discountAmount.toFixed(0)}`)
        ) : null,
        // Two-column row (label + value in its own right-aligned Text),
        // same as the "Total:" row above it - NOT one bold string with
        // textAlign:"right", which is what was actually causing the real
        // printout's rightmost digit to clip (see the RECEIPT_CONTENT_WIDTH_PT
        // comment above: bold text renders a touch wider than regular
        // weight, and a single string right-aligned right up against the
        // page's inner edge has nowhere for that extra width to go except
        // past the physical paper edge). Splitting into two Text nodes lets
        // rowRight's own smaller font-size + dedicated column do the same
        // job the item table's Amount column already does safely.
        h(View, { style: [receiptStyles.row, { marginTop: 6 }] },
          h(Text, { style: receiptStyles.bold }, "Bill Total:"),
          h(Text, { style: [receiptStyles.bold, receiptStyles.rowRight] }, billTotal.toFixed(0))
        ),
        amountTendered !== undefined ? h(Text, { style: { marginTop: 4 } }, `Amount Tendered: ${amountTendered.toFixed(0)}`) : null,
        dueAmount > 0 ? h(Text, null, `Due: ${dueAmount.toFixed(0)}`) : null,
        // Full arrears breakdown - only for a customer who actually has
        // previous dues, matching ItemizedBillReceipt.tsx's own on-screen
        // preview; a customer with none never sees any of this.
        previousDues > 0 ? h(Text, { style: { marginTop: 4 } }, `Arrears: ${previousDues.toFixed(0)}`) : null,
        previousDues > 0 ? h(View, { style: receiptStyles.row },
          h(Text, null, "Arrears+Inv Balance:"),
          h(Text, { style: receiptStyles.rowRight }, (billTotal + previousDues).toFixed(0))
        ) : null,
        previousDues > 0 ? h(View, { style: receiptStyles.row },
          h(Text, null, "Invoice Balance:"),
          h(Text, { style: receiptStyles.rowRight }, dueAmount.toFixed(0))
        ) : null,
        previousDues > 0 ? h(View, { style: receiptStyles.row },
          h(Text, { style: receiptStyles.bold }, "Account Balance:"),
          h(Text, { style: [receiptStyles.bold, receiptStyles.rowRight] }, (previousDues + dueAmount).toFixed(0))
        ) : null,
        h(View, { style: { marginTop: 6 } },
          h(Text, { style: receiptStyles.bold }, "In Words:"),
          h(Text, null, `${numberToWordsPdf(billTotal)} ONLY.`)
        ),
        h(View, { style: receiptStyles.footer },
          settings?.receiptFooterMessage ? h(Text, { style: receiptStyles.bold }, settings.receiptFooterMessage) : null,
          h(Text, null, "Haider's Creation"),
          h(Text, null, "0315-0707167")
        )
      )
    );
  }

  // Kitchen-facing "KOT" ticket - see KitchenKotReceipt.tsx (renderer app)
  // for the on-screen preview this must match.
  function KitchenKotReceiptPdf({ orderData, settings }) {
    const items = orderData?.items || [];
    const orderNumber = getOrderNumber(orderData);
    const totalQty = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    // Shop-lifetime, never-resetting order count (backend/models/Order.js's
    // shopSequenceNumber) - starts at 1 on this shop's very first order
    // ever and keeps counting up forever, unlike Order# above which resets
    // every shift. Falls back to the old id-derived value only for orders
    // placed before this field existed (won't have shopSequenceNumber set).
    const rawId = String(orderData?.id || orderData?._id || "");
    const trNumber = orderData?.shopSequenceNumber
      ? String(orderData.shopSequenceNumber).padStart(6, "0")
      : rawId.replace(/[^0-9a-z]/gi, "").slice(-6).toUpperCase();
    const pageHeight = estimateKitchenKotHeightPt(orderData);

    return h(Document, null,
      h(Page, { size: [RECEIPT_WIDTH_PT, pageHeight], style: leftFlushPageStyleFor(settings) },
        h(View, { style: receiptStyles.center },
          h(Text, { style: receiptStyles.storeName }, settings?.receiptHeader || "THE HEAVEN SLICE"),
          settings?.receiptSubHeader ? h(Text, { style: receiptStyles.small }, settings.receiptSubHeader) : null
        ),
        h(View, { style: altReceiptStyles.boxedType },
          h(Text, { style: altReceiptStyles.boxedTypeText }, String(orderData?.orderType || "").toUpperCase())
        ),
        h(View, { style: [receiptStyles.meta, { marginTop: 8, marginBottom: 8 }] },
          h(Text, { style: altReceiptStyles.metaRow }, `Tr#: ${trNumber}`),
          h(View, { style: [receiptStyles.row, altReceiptStyles.metaRow] },
            h(Text, null, `DATE: ${formatReceiptDate(orderData?.createdAt)}`),
            h(Text, null, formatReceiptTime(orderData?.createdAt))
          ),
          h(Text, { style: altReceiptStyles.metaRow }, `M/S: ${String(orderData?.paymentMethod || "Cash").toUpperCase()}`),
          h(View, { style: [receiptStyles.row, altReceiptStyles.metaRow] },
            h(Text, null, `Order#: ${orderNumber}`),
            orderData?.orderType === "DineIn" && orderData?.table ? h(Text, null, `Table: ${orderData.table}`) : null
          ),
          orderData?.waiter ? h(Text, { style: altReceiptStyles.metaRow }, `Waiter: ${orderData.waiter}`) : null
        ),
        h(View, { style: receiptStyles.rule }),
        h(Text, { style: receiptStyles.ticketLabel }, "*** KOT ***"),
        h(View, { style: altReceiptStyles.tableHeaderRow },
          h(Text, { style: [{ width: 16, flexShrink: 0 }, altReceiptStyles.headerBold] }, "#"),
          h(Text, { style: [{ flexGrow: 1, flexShrink: 1, width: 0 }, altReceiptStyles.headerBold] }, "Item Detail"),
          h(Text, { style: [{ width: 30, flexShrink: 0, textAlign: "right" }, altReceiptStyles.headerBold] }, "Qty")
        ),
        h(View, null,
          items.map((item, index) => {
            const quantity = Number(item.quantity || 1);
            const name = String(item.name || "").toUpperCase();
            return h(View, { key: `${name}-${index}`, style: { marginBottom: 4 } },
              h(View, { style: receiptStyles.row },
                h(Text, { style: { width: 16, flexShrink: 0 } }, String(index + 1)),
                // flexShrink: 1 + width: 0 forces this cell to wrap/shrink to
                // its allotted space instead of growing past it - react-pdf's
                // layout engine (Yoga) defaults flexShrink to 0, unlike web
                // CSS flexbox, so a long unbroken item name (no spaces to
                // wrap at) would otherwise overflow straight through the Qty
                // column instead of wrapping onto its own line.
                h(Text, { style: { flexGrow: 1, flexShrink: 1, width: 0 } }, item.variation ? `${name} (${String(item.variation).toUpperCase()})` : name),
                h(Text, { style: [receiptStyles.bold, { width: 30, flexShrink: 0, textAlign: "right" }] }, String(quantity))
              )
            );
          })
        ),
        h(View, { style: receiptStyles.rule }),
        h(View, { style: receiptStyles.row },
          h(Text, { style: receiptStyles.bold }, "Total:"),
          h(Text, { style: [receiptStyles.bold, receiptStyles.rowRight] }, String(totalQty))
        ),
        orderData?.note ? h(View, { style: { marginTop: 8, borderWidth: 1, borderColor: "#000000", borderStyle: "solid", padding: 4 } },
          h(Text, { style: receiptStyles.bold }, "Note:"),
          h(Text, null, String(orderData.note))
        ) : null
      )
    );
  }

  function estimateItemizedBillHeightPt(orderData, hasLogo, settings) {
    let h = 55;
    if (hasLogo) h += 100;
    h += 55; // store name/sub/address/contact
    h += 25; // "Bill" title + boxed type
    h += 45 + 16 + 24; // meta block (order#/date, table, M/S, waiter, customer) + its extra top/bottom margin + per-row spacing
    const billCustomerShown = orderData?.customer?.name && orderData.customer.name !== "Walk-in Customer";
    if (billCustomerShown && orderData?.customer?.phone && orderData.customer.phone !== "03000000000") h += 14;
    if (orderData?.customer?.address) h += 14;
    h += 20; // dashed rule + table header
    const items = orderData?.items || [];
    items.forEach((item) => {
      h += 14;
      if (item.variation) h += 10;
    });
    if (Number(settings?.serviceChargePercent) > 0) h += 14;
    if (Number(orderData?.discount?.amount) > 0) h += 14; // Discount row
    h += 40; // Total + Bill Total
    const total = typeof orderData?.total === "number" ? orderData.total : 0;
    const amountTendered = orderData?.paidAmount !== undefined ? Math.min(Number(orderData.paidAmount), total) : undefined;
    if (amountTendered !== undefined) h += 14;
    if (Math.max(total - (amountTendered ?? total), 0) > 0) h += 14;
    if (Number(orderData?.previousDues) > 0) h += 56; // Arrears/Arrears+Inv Balance/Invoice Balance/Account Balance rows
    h += 40; // In Words block
    h += 50; // footer (optional footer message + fixed "Haider's Creation" / phone lines)
    return h;
  }

  function estimateKitchenKotHeightPt(orderData) {
    let h = 55;
    h += 35; // header
    h += 25; // boxed order type
    h += 70 + 16 + 24; // meta (Tr#, date/time, M/S, order#/table, waiter) + its extra top/bottom margin + per-row spacing
    h += 25; // rule + KOT label
    h += 20; // table header
    const items = orderData?.items || [];
    items.forEach((item) => {
      const nameLength = String(item.name || "").length;
      const wrappedLines = Math.max(1, Math.ceil((nameLength + 10) / 22));
      h += wrappedLines * 13 + 4;
    });
    h += 25; // total row
    if (orderData?.note) h += 35;
    return h;
  }

  // Picks which react-pdf template to actually print - the main-process
  // equivalent of ReceiptRenderer.tsx's decision in the renderer app. Only
  // the two main receipt types (a plain "kitchen" ticket, a "cashier"
  // receipt) have alternates right now - cancel/remove tickets and the
  // TakeAway order-number token always use the classic ReceiptPdf layout
  // regardless of what a shop has picked, same scope ReceiptRenderer.tsx
  // covers on the renderer side.
  function pickReceiptElement({ orderData, type, printLogo, settings }) {
    if (type === "cashier" && settings?.cashierReceiptTemplate === "itemizedBill") {
      return h(ItemizedBillReceiptPdf, { orderData, printLogo, settings });
    }
    if (type === "kitchen" && settings?.kitchenReceiptTemplate === "kot") {
      return h(KitchenKotReceiptPdf, { orderData, settings });
    }
    return h(ReceiptPdf, { orderData, type, printLogo, settings });
  }

  async function createReceiptPdfFromOrderData(orderData, type = "kitchen", filePrefix = "receipt", printLogo = null, settings = null) {
    const safePrefix = String(filePrefix).replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "receipt";
    const pdfPath = path.join(os.tmpdir(), `${safePrefix}_${Date.now()}.pdf`);
    await ReactPDF.render(pickReceiptElement({ orderData, type, printLogo, settings }), pdfPath);
    logRuntime(`ReactPDF ${type} receipt created: ${pdfPath}`);
    return { success: true, pdfPath };
  }

  async function printReceiptPdfFile(filePath, printerName) {
    await pdfPrinter.print(filePath, {
      printer: printerName,
      scale: "noscale",
      silent: true,
    });
  }

  ipcMain.handle("print-kitchen-receipt-data", async (_event, orderData, printerName, printLogo, settings) => {
    if (!printerName) {
      return { success: false, error: "No kitchen printer configured" };
    }

    try {
      const result = await createReceiptPdfFromOrderData(orderData, "kitchen", "kitchen_receipt", printLogo, settings);
      await printReceiptPdfFile(result.pdfPath, printerName);
      fs.unlink(result.pdfPath, () => {});
      logRuntime(`ReactPDF kitchen receipt printed on ${printerName}`);
      return { success: true };
    } catch (error) {
      logRuntime(`ReactPDF kitchen receipt print failed: ${error}`);
      return { success: false, error: error.toString() };
    }
  });

  ipcMain.handle("print-kitchen-cancel-receipt-data", async (_event, orderData, printerName, printLogo, settings) => {
    if (!printerName) {
      return { success: false, error: "No kitchen printer configured" };
    }

    try {
      const result = await createReceiptPdfFromOrderData(orderData, "kitchen-cancel", "kitchen_cancel_receipt", printLogo, settings);
      await printReceiptPdfFile(result.pdfPath, printerName);
      fs.unlink(result.pdfPath, () => {});
      logRuntime(`ReactPDF kitchen cancel receipt printed on ${printerName}`);
      return { success: true };
    } catch (error) {
      logRuntime(`ReactPDF kitchen cancel receipt print failed: ${error}`);
      return { success: false, error: error.toString() };
    }
  });

  ipcMain.handle("print-kitchen-remove-receipt-data", async (_event, orderData, printerName, printLogo, settings) => {
    if (!printerName) {
      return { success: false, error: "No kitchen printer configured" };
    }

    try {
      const result = await createReceiptPdfFromOrderData(orderData, "kitchen-remove", "kitchen_remove_receipt", printLogo, settings);
      await printReceiptPdfFile(result.pdfPath, printerName);
      fs.unlink(result.pdfPath, () => {});
      logRuntime(`ReactPDF kitchen remove-items receipt printed on ${printerName}`);
      return { success: true };
    } catch (error) {
      logRuntime(`ReactPDF kitchen remove-items receipt print failed: ${error}`);
      return { success: false, error: error.toString() };
    }
  });

  ipcMain.handle("print-order-token-data", async (_event, orderData, printerName, printLogo, settings) => {
    if (!printerName) {
      return { success: false, error: "No cashier printer configured" };
    }

    try {
      const result = await createReceiptPdfFromOrderData(orderData, "token", "order_token", printLogo, settings);
      await printReceiptPdfFile(result.pdfPath, printerName);
      fs.unlink(result.pdfPath, () => {});
      logRuntime(`ReactPDF order-number token printed on ${printerName}`);
      return { success: true };
    } catch (error) {
      logRuntime(`ReactPDF order-number token print failed: ${error}`);
      return { success: false, error: error.toString() };
    }
  });

  ipcMain.handle("print-cashier-receipt-data", async (_event, orderData, printerName, printLogo, settings) => {
    if (!printerName) {
      return { success: false, error: "No cashier printer configured" };
    }

    try {
      const result = await createReceiptPdfFromOrderData(orderData, "cashier", "cashier_receipt", printLogo, settings);
      await printReceiptPdfFile(result.pdfPath, printerName);
      fs.unlink(result.pdfPath, () => {});
      logRuntime(`ReactPDF cashier receipt printed on ${printerName}`);
      return { success: true };
    } catch (error) {
      logRuntime(`ReactPDF cashier receipt print failed: ${error}`);
      return { success: false, error: error.toString() };
    }
  });

  ipcMain.handle("create-customer-receipt-pdf-data", async (_event, orderData, filePrefix, printLogo, settings) => {
    try {
      const result = await createReceiptPdfFromOrderData(orderData, "cashier", filePrefix || "customer_receipt", printLogo, settings);
      // Also read the PDF back as base64 - the WhatsApp send flow
      // (sendWhatsappDocument in src/lib/pos-api.ts) needs the actual
      // bytes, not this till's local pdfPath. The backend may now run on
      // a completely different machine (see backend/README-deploy.md),
      // so a path from this disk means nothing to it - result.pdfPath
      // stays here only for any other local-only use of this handler.
      const fileBase64 = fs.readFileSync(result.pdfPath).toString("base64");
      fs.unlink(result.pdfPath, () => {});
      return { ...result, fileBase64 };
    } catch (error) {
      logRuntime(`ReactPDF customer receipt creation failed: ${error}`);
      return { success: false, error: error.toString() };
    }
  });

  const RECEIPT_PAPER_WIDTH_PX = 302; // 80mm at Chromium's 96 DPI CSS pixel ratio.
  const RECEIPT_PAPER_WIDTH_MICRONS = 80000;
  const CSS_PIXEL_TO_MICRONS = 264.583;

  async function waitForReceiptWindow(printWin, urlToPrint) {
    await printWin.loadURL(urlToPrint);

    return printWin.webContents.executeJavaScript(`
      (async function() {
        const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

        const alignToTop = () => {
          const style = document.createElement('style');
          style.id = 'electron-tight-receipt-print-style';
          style.textContent = \`
            @page { margin: 0 !important; size: 80mm auto; }
            html, body {
              margin: 0 !important;
              padding: 0 !important;
              width: 80mm !important;
              min-height: 0 !important;
              height: auto !important;
              background: #fff !important;
              display: block !important;
              position: static !important;
              overflow: visible !important;
            }
            body > div, main, #receipt-print-area {
              margin: 0 !important;
              padding: 0 !important;
              width: 80mm !important;
              min-height: 0 !important;
              height: auto !important;
              display: block !important;
              position: static !important;
              transform: none !important;
              overflow: visible !important;
            }
            #receipt-print-area .thermal-receipt {
              width: 70mm !important;
              max-width: 70mm !important;
              margin: 0 auto !important;
              position: static !important;
              transform: none !important;
            }
          \`;
          document.getElementById(style.id)?.remove();
          document.head.appendChild(style);

          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
        };

        const startedAt = Date.now();
        let receipt = document.getElementById('receipt-print-area');
        while ((!receipt || !receipt.textContent.includes('DATE:') || !receipt.textContent.includes('Items:')) && Date.now() - startedAt < 7000) {
          await wait(100);
          receipt = document.getElementById('receipt-print-area');
        }

        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready.catch(() => undefined);
        }

        await Promise.all(Array.from(document.images).map(img => {
          if (img.complete && img.naturalWidth !== 0) return Promise.resolve();
          return new Promise(resolve => {
            img.onload = resolve;
            img.onerror = resolve;
          });
        }));

        await nextFrame();
        await wait(150);
        alignToTop();
        await nextFrame();
        await wait(100);
        alignToTop();

        const content = document.querySelector('.thermal-receipt') || receipt || document.body;
        const rect = content.getBoundingClientRect();
        return {
          height: Math.max(Math.ceil(rect.height), content.scrollHeight, content.offsetHeight, 100),
          textLength: content.textContent.length,
          width: Math.max(Math.ceil(rect.width), content.scrollWidth, content.offsetWidth, 272)
        };
      })()
    `);
  }

  async function createReceiptPdf(urlToPrint, filePrefix = "receipt") {
    const printWin = new BrowserWindow({
      show: false,
      width: RECEIPT_PAPER_WIDTH_PX,
      height: 700,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      backgroundColor: "#ffffff"
    });

    try {
      const measurement = await waitForReceiptWindow(printWin, urlToPrint);
      const contentHeight = Math.max(Number(measurement.height) || 0, 100);
      const paperHeightMicrons = Math.max(30000, Math.ceil((contentHeight + 60) * CSS_PIXEL_TO_MICRONS));

      printWin.setContentSize(RECEIPT_PAPER_WIDTH_PX, Math.ceil(contentHeight) + 60);
      await new Promise(resolve => setTimeout(resolve, 100));

      const pdfData = await printWin.webContents.printToPDF({
        printBackground: true,
        marginsType: 1,
        pageSize: {
          width: RECEIPT_PAPER_WIDTH_MICRONS,
          height: paperHeightMicrons
        },
        scale: 1
      });

      const safePrefix = String(filePrefix).replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "receipt";
      const pdfPath = path.join(os.tmpdir(), `${safePrefix}_${Date.now()}.pdf`);
      fs.writeFileSync(pdfPath, pdfData);

      logRuntime(`Receipt PDF created: ${pdfPath} (${RECEIPT_PAPER_WIDTH_MICRONS} x ${paperHeightMicrons} microns, ${contentHeight}px content)`);

      return {
        success: true,
        pdfPath,
        contentHeight,
        pageSize: {
          width: RECEIPT_PAPER_WIDTH_MICRONS,
          height: paperHeightMicrons
        }
      };
    } finally {
      if (!printWin.isDestroyed()) {
        printWin.close();
      }
    }
  }

  ipcMain.handle("create-receipt-pdf", async (_event, urlToPrint, filePrefix) => {
    try {
      return await createReceiptPdf(urlToPrint, filePrefix);
    } catch (error) {
      logRuntime(`Receipt PDF creation failed: ${error}`);
      return { success: false, error: error.toString() };
    }
  });

  ipcMain.handle("print-receipt", async (_event, urlToPrint, printerName) => {
    if (!printerName) {
      logRuntime("Silent PDF print failed: No printer specified");
      return { success: false, error: "No printer specified" };
    }

    try {
      logRuntime(`Printing receipt PDF ${urlToPrint} to ${printerName}`);
      const result = await createReceiptPdf(urlToPrint, "kitchen_receipt");
      if (!result.success) return result;

      await pdfPrinter.print(result.pdfPath, {
        printer: printerName,
        scale: "noscale",
        silent: true
      });

      fs.unlink(result.pdfPath, () => {});
      logRuntime(`PDF receipt print successful on ${printerName}`);
      return { success: true };
    } catch (error) {
      logRuntime(`PDF receipt print failed: ${error}`);
      return { success: false, error: error.toString() };
    }
  });
  app.whenReady().then(async () => {
    try {
      createWindow();

      if (devServerUrl) {
        // `npm run dev`: Vite (localhost:5173) and the Express backend
        // (localhost:5000) are already up externally, confirmed by wait-on
        // before this process was even spawned. Just attach to them.
        logRuntime(`Dev mode: attaching to external dev server at ${devServerUrl}`);
        await startLocalHubServer();
        await loadApp(devServerUrl);
      } else {
        // `npm run electron` (standalone) and the packaged production app.
        //
        // If VITE_API_URL is set (see pos-web/.env), the backend now runs
        // centrally on a server instead of in-process on this till - see
        // backend/README-deploy.md. Starting a redundant local backend in
        // that case would pointlessly try to connect to Atlas from every
        // till and serve on a port nothing talks to (src/lib/api.ts
        // already prefers VITE_API_URL over localhost:5000 - see
        // DEFAULT_CLOUD_API_BASES there), so skip it entirely.
        if (process.env.VITE_API_URL) {
          logRuntime(`VITE_API_URL is set (${process.env.VITE_API_URL}) - skipping legacy local backend, this till talks to the remote server only.`);
        } else {
          logRuntime("Starting backend server...");
          await startBackendServer();
        }
        // Local Hub starts regardless of the branch above - see
        // startLocalHubServer's comment.
        logRuntime("Starting Local Hub...");
        await startLocalHubServer();
        await loadApp();
      }
    } catch (error) {
      reportFatal("Initialization Error", error);
    }

    setupAutoUpdater();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    void shutdownServers();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
