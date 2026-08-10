const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const pdfPrinter = require("pdf-to-printer");
const React = require("react");
const ReactPDF = require("@react-pdf/renderer");

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
      logRuntime("Local Hub started successfully");
      return true;
    } catch (error) {
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
      h += 50; // Total, PAID
      const total = getItemsTotal(orderData);
      const amountTendered = orderData?.paidAmount !== undefined ? Math.min(Number(orderData.paidAmount), total) : undefined;
      const dueAmount = Math.max(total - (amountTendered ?? 0), 0);
      if (amountTendered !== undefined) h += 15;
      if (dueAmount > 0) h += 15;
      if (Number(orderData?.previousDues) > 0) h += 30; // Previous Dues + Total Outstanding rows
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
      h(Page, { size: [RECEIPT_WIDTH_PT, pageHeight], style: receiptStyles.page },
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
            h(Text, { style: receiptStyles.rowRight }, `Rs ${total.toFixed(2)}`)
          ),
          h(View, { style: receiptStyles.row },
            h(Text, { style: receiptStyles.bold }, "TOTAL:"),
            h(Text, { style: [receiptStyles.bold, receiptStyles.rowRight] }, `Rs ${total.toFixed(2)}`)
          ),
          h(Text, { style: { marginTop: 6 } }, `PAID: ${String(orderData?.paymentMethod || "Cash").toUpperCase()}`),
          amountTendered !== undefined ? h(Text, null, `AMOUNT TENDERED: Rs ${amountTendered.toFixed(2)}`) : null,
          dueAmount > 0 ? h(Text, null, `DUE: Rs ${dueAmount.toFixed(2)}`) : null,
          previousDues > 0 ? h(Text, { style: { marginTop: 4 } }, `PREVIOUS DUES: Rs ${previousDues.toFixed(2)}`) : null,
          previousDues > 0 ? h(View, { style: receiptStyles.row },
            h(Text, { style: receiptStyles.bold }, "TOTAL OUTSTANDING:"),
            h(Text, { style: [receiptStyles.bold, receiptStyles.rowRight] }, `Rs ${(total + previousDues).toFixed(2)}`)
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

  async function createReceiptPdfFromOrderData(orderData, type = "kitchen", filePrefix = "receipt", printLogo = null, settings = null) {
    const safePrefix = String(filePrefix).replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "receipt";
    const pdfPath = path.join(os.tmpdir(), `${safePrefix}_${Date.now()}.pdf`);
    await ReactPDF.render(h(ReceiptPdf, { orderData, type, printLogo, settings }), pdfPath);
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
              width: 72mm !important;
              max-width: 72mm !important;
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
