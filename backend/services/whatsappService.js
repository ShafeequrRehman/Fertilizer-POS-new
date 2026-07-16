const QRCode = require("qrcode");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const os = require("os");

let cachedBaileys = null;
async function getBaileys() {
  if (!cachedBaileys) {
    const baileys = await import("@whiskeysockets/baileys");
    cachedBaileys = {
      makeWASocket: baileys.default ? baileys.default : baileys,
      useMultiFileAuthState: baileys.useMultiFileAuthState,
      DisconnectReason: baileys.DisconnectReason,
      fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
      Browsers: baileys.Browsers
    };
  }
  return cachedBaileys;
}
const isPackaged = process.env.ELECTRON_IS_PACKAGED === "true";
const basePath = isPackaged ? path.join(os.homedir(), ".pos-system") : path.resolve(__dirname, "../../");
const AUTH_DIR = path.join(basePath, ".auth_whatsapp");

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let qrBase64 = null;
let socketReady = false;
let initializing = false;
let serviceInstance = null;

const messageQueue = [];

function normalizePhone(phone) {
  if (!phone) return null;
  const num = phone.toString().trim().replace(/\D/g, "");

  if (num.startsWith("0") && num.length === 11) return `92${num.substring(1)}`;
  if (num.length === 10) return `92${num}`;
  if (num.startsWith("92") && num.length === 12) return num;
  if (num.startsWith("0092")) return num.replace(/^00/, "");
  return null;
}

async function _sendNow(phone, message) {
  if (!sock || !socketReady) throw new Error("socket-not-ready");

  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error("invalid-phone");

  return sock.sendMessage(`${normalized}@s.whatsapp.net`, { text: message });
}

async function _sendDocumentNow(phone, filePath, fileName) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error("invalid-phone");
  if (!fs.existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);
  if (!sock || !socketReady) throw new Error("socket-not-ready");

  return sock.sendMessage(`${normalized}@s.whatsapp.net`, {
    document: fs.readFileSync(filePath),
    mimetype: "application/pdf",
    fileName,
  });
}

function sendMessage(phone, message, { queueIfNotReady = true } = {}) {
  return new Promise(async (resolve, reject) => {
    const normalized = normalizePhone(phone);
    if (!normalized) return reject(new Error("invalid-phone"));

    if (!sock || !socketReady) {
      if (queueIfNotReady) {
        messageQueue.push({ type: "message", phone, message, resolve, reject });
        return;
      }

      return reject(new Error("socket-not-ready"));
    }

    try {
      await _sendNow(phone, message);
      resolve({ success: true });
    } catch (error) {
      reject(error);
    }
  });
}

async function sendDocument(phone, filePath, fileName) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error("invalid-phone");
  if (!fs.existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);

  return new Promise(async (resolve, reject) => {
    if (!sock || !socketReady) {
      messageQueue.push({ type: "document", phone, filePath, fileName, resolve, reject });
      return;
    }

    try {
      await _sendDocumentNow(phone, filePath, fileName);
      resolve({ success: true });
    } catch (error) {
      reject(error);
    }
  });
}

async function initializeWhatsApp() {
  if (initializing) {
    return { getQR, getStatus, sendMessage, sendDocument };
  }

  initializing = true;

  try {
    const {
      makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      Browsers
    } = await getBaileys();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Pos-desktop"),
      printQRInTerminal: false,
    });

    console.log("WhatsApp socket initialized");

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrBase64 = await QRCode.toDataURL(qr);
        socketReady = false;
        console.log("WhatsApp QR generated");
      }

      if (connection === "open") {
        socketReady = true;
        qrBase64 = null;
        console.log("WhatsApp connected successfully");
        await flushQueue();
      }

      if (connection === "close") {
        const { DisconnectReason } = await getBaileys();
        const reasonCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.message ||
          "unknown";

        socketReady = false;
        console.log("WhatsApp disconnected:", reasonCode);

        if (reasonCode === DisconnectReason.loggedOut) {
          console.log("WhatsApp logged out. Deleting .auth_whatsapp to generate new QR.");
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        setTimeout(() => {
          serviceInstance = null;
          initializeWhatsApp().catch((error) => {
            console.error("WhatsApp re-initialization failed:", error);
          });
        }, 5000);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    return { getQR, getStatus, sendMessage, sendDocument };
  } finally {
    initializing = false;
  }
}

function getQR() {
  return qrBase64;
}

function getStatus() {
  return {
    isConnected: socketReady,
    socketReady,
    hasQR: !!qrBase64,
  };
}

async function flushQueue() {
  if (!socketReady) return;

  while (messageQueue.length > 0) {
    const job = messageQueue.shift();
    if (!job) {
      continue;
    }

    try {
      if (job.type === "document") {
        await _sendDocumentNow(job.phone, job.filePath, job.fileName);
      } else {
        await _sendNow(job.phone, job.message);
      }
      job.resolve({ success: true });
    } catch (error) {
      job.reject(error);
    }
  }
}

module.exports = async function createWhatsAppService() {
  if (!serviceInstance) {
    serviceInstance = initializeWhatsApp().catch((error) => {
      serviceInstance = null;
      throw error;
    });
  }

  return serviceInstance;
};
