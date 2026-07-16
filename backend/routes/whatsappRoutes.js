const express = require("express");
const router = express.Router();
const createWhatsAppService = require("../services/whatsappService");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");

// KNOWN LIMITATION (not fixed in this pass - see final report): this
// service is a single global WhatsApp/Baileys connection shared by every
// shop on this backend instance, not a per-shop session keyed by shopId.
// Adding auth here stops fully anonymous access, but it does NOT give
// each shop its own isolated WhatsApp number/session - any authenticated
// shop member can currently see/use whichever WhatsApp account is
// connected. Proper fix is a per-shop session pool, tracked as follow-up
// work.
router.use(authenticate, requireShopMember);

let whatsappServicePromise = null;

function getWhatsAppService() {
  if (!whatsappServicePromise) {
    whatsappServicePromise = createWhatsAppService().catch((error) => {
      whatsappServicePromise = null;
      throw error;
    });
  }

  return whatsappServicePromise;
}

// GET STATUS
router.get("/status", async (req, res) => {
  try {
    const service = await getWhatsAppService();
    res.json(service.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET QR
router.get("/qr", async (req, res) => {
  try {
    const service = await getWhatsAppService();
    const qr = service.getQR();

    if (!qr) return res.status(404).json({ message: "QR not ready" });

    res.json({ qr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SEND MESSAGE
router.post("/send", async (req, res) => {
  try {
    const service = await getWhatsAppService();
    const { phone, message } = req.body;

    const result = await service.sendMessage(phone, message);

    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json(result);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SEND DOCUMENT
router.post("/send-document", async (req, res) => {
  try {
    const service = await getWhatsAppService();
    const { phone, filePath, fileName } = req.body;

    const result = await service.sendDocument(phone, filePath, fileName);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
