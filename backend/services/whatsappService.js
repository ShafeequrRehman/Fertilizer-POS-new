const QRCode = require("qrcode");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Per-shop WhatsApp/Baileys sessions.
//
// Previously this whole module was one set of module-level variables
// (sock, qrBase64, socketReady, ...) - a single shared WhatsApp connection
// for every shop on the backend, regardless of which shop was actually
// asking (see whatsappRoutes.js's old comment about this). That meant
// every shop saw the same QR code and sent messages from the same number.
// Now every bit of that state lives inside a per-shop ShopWhatsAppSession,
// keyed by shopId, with its own auth folder so each shop's login is
// completely isolated from every other shop's - one shop logging out or
// getting logged out never touches another shop's session.
let cachedBaileys = null;
async function getBaileys() {
  if (!cachedBaileys) {
    const baileys = await import("@whiskeysockets/baileys");
    cachedBaileys = {
      makeWASocket: baileys.default ? baileys.default : baileys,
      useMultiFileAuthState: baileys.useMultiFileAuthState,
      DisconnectReason: baileys.DisconnectReason,
      fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
      Browsers: baileys.Browsers,
    };
  }
  return cachedBaileys;
}

const isPackaged = process.env.ELECTRON_IS_PACKAGED === "true";
const basePath = isPackaged ? path.join(os.homedir(), ".pos-system") : path.resolve(__dirname, "../../");
// Every shop gets its own subfolder: .auth_whatsapp/<shopId>/ instead of
// one shared .auth_whatsapp/ - this is the actual on-disk isolation that
// makes "each shop scans their own WhatsApp" true.
const AUTH_ROOT_DIR = path.join(basePath, ".auth_whatsapp");

function normalizePhone(phone) {
  if (!phone) return null;
  const num = phone.toString().trim().replace(/\D/g, "");

  if (num.startsWith("0") && num.length === 11) return `92${num.substring(1)}`;
  if (num.length === 10) return `92${num}`;
  if (num.startsWith("92") && num.length === 12) return num;
  if (num.startsWith("0092")) return num.replace(/^00/, "");
  return null;
}

// One instance of this class per shopId - all the state that used to be
// module-level globals now lives on `this`, so two shops' sessions can
// never leak into each other.
class ShopWhatsAppSession {
  constructor(shopId) {
    this.shopId = shopId;
    this.authDir = path.join(AUTH_ROOT_DIR, String(shopId));
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    this.sock = null;
    this.qrBase64 = null;
    this.socketReady = false;
    this.initializing = null; // Promise while connecting, so concurrent callers share one attempt
    this.messageQueue = [];
  }

  async _sendNow(phone, message) {
    if (!this.sock || !this.socketReady) throw new Error("socket-not-ready");
    const normalized = normalizePhone(phone);
    if (!normalized) throw new Error("invalid-phone");
    return this.sock.sendMessage(`${normalized}@s.whatsapp.net`, { text: message });
  }

  // `fileBuffer` is real file bytes (a Buffer), never a filesystem path -
  // the backend may be running on a completely different machine than
  // whatever client generated the PDF (see backend/README-deploy.md), so
  // a path from the client's disk means nothing here. Callers must read
  // the file into memory and send the bytes (base64 over HTTP - see
  // whatsappRoutes.js's /send-document route).
  async _sendDocumentNow(phone, fileBuffer, fileName) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new Error("invalid-phone");
    if (!this.sock || !this.socketReady) throw new Error("socket-not-ready");

    return this.sock.sendMessage(`${normalized}@s.whatsapp.net`, {
      document: fileBuffer,
      mimetype: "application/pdf",
      fileName,
    });
  }

  sendMessage(phone, message, { queueIfNotReady = true } = {}) {
    return new Promise((resolve, reject) => {
      const normalized = normalizePhone(phone);
      if (!normalized) return reject(new Error("invalid-phone"));

      if (!this.sock || !this.socketReady) {
        if (queueIfNotReady) {
          this.messageQueue.push({ type: "message", phone, message, resolve, reject });
          return;
        }
        return reject(new Error("socket-not-ready"));
      }

      this._sendNow(phone, message).then(() => resolve({ success: true })).catch(reject);
    });
  }

  sendDocument(phone, fileBuffer, fileName) {
    const normalized = normalizePhone(phone);
    if (!normalized) return Promise.reject(new Error("invalid-phone"));

    return new Promise((resolve, reject) => {
      if (!this.sock || !this.socketReady) {
        this.messageQueue.push({ type: "document", phone, fileBuffer, fileName, resolve, reject });
        return;
      }
      this._sendDocumentNow(phone, fileBuffer, fileName).then(() => resolve({ success: true })).catch(reject);
    });
  }

  async _flushQueue() {
    if (!this.socketReady) return;

    while (this.messageQueue.length > 0) {
      const job = this.messageQueue.shift();
      if (!job) continue;

      try {
        if (job.type === "document") {
          await this._sendDocumentNow(job.phone, job.fileBuffer, job.fileName);
        } else {
          await this._sendNow(job.phone, job.message);
        }
        job.resolve({ success: true });
      } catch (error) {
        job.reject(error);
      }
    }
  }

  async initialize() {
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = await getBaileys();

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        // Distinguishes shops in WhatsApp Linked Devices UI - was a fixed
        // "Pos-desktop" name for every shop before, now includes the
        // shopId so a shop owner can tell their session apart if they
        // ever look at Linked Devices.
        browser: Browsers.macOS(`POS-${this.shopId}`),
        printQRInTerminal: false,
      });

      console.log(`[whatsapp:${this.shopId}] socket initialized`);

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrBase64 = await QRCode.toDataURL(qr);
          this.socketReady = false;
          console.log(`[whatsapp:${this.shopId}] QR generated`);
        }

        if (connection === "open") {
          this.socketReady = true;
          this.qrBase64 = null;
          console.log(`[whatsapp:${this.shopId}] connected`);
          await this._flushQueue();
        }

        if (connection === "close") {
          const { DisconnectReason: DR } = await getBaileys();
          const reasonCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.message || "unknown";

          this.socketReady = false;
          console.log(`[whatsapp:${this.shopId}] disconnected:`, reasonCode);

          if (reasonCode === DR.loggedOut) {
            console.log(`[whatsapp:${this.shopId}] logged out - clearing this shop's session only, generating a fresh QR next time.`);
            fs.rmSync(this.authDir, { recursive: true, force: true });
            fs.mkdirSync(this.authDir, { recursive: true });
          }

          setTimeout(() => {
            this.initializing = null;
            this.initialize().catch((error) => {
              console.error(`[whatsapp:${this.shopId}] re-initialization failed:`, error);
            });
          }, 5000);
        }
      });

      this.sock.ev.on("creds.update", saveCreds);

      return this;
    })().catch((error) => {
      this.initializing = null;
      throw error;
    });

    return this.initializing;
  }

  getQR() {
    return this.qrBase64;
  }

  getStatus() {
    return {
      isConnected: this.socketReady,
      socketReady: this.socketReady,
      hasQR: !!this.qrBase64,
    };
  }
}

// shopId -> Promise<ShopWhatsAppSession>, so concurrent requests for the
// same shop while it's still connecting share one in-flight attempt
// instead of racing to create two sockets for the same shop.
const sessionsByShop = new Map();

function getWhatsAppServiceForShop(shopId) {
  if (!shopId) {
    return Promise.reject(new Error("shopId is required for a WhatsApp session"));
  }

  const key = String(shopId);
  let sessionPromise = sessionsByShop.get(key);

  if (!sessionPromise) {
    const session = new ShopWhatsAppSession(key);
    sessionPromise = session.initialize().catch((error) => {
      sessionsByShop.delete(key);
      throw error;
    });
    sessionsByShop.set(key, sessionPromise);
  }

  return sessionPromise;
}

module.exports = { getWhatsAppServiceForShop };
