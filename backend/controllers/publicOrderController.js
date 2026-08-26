const Product = require("../models/Product");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const ShopSession = require("../models/ShopSession");
const Shop = require("../models/Shop");
const {
  isJazzCashConfigured,
  isEasyPaisaConfigured,
  buildJazzCashCheckoutPayload,
  verifyJazzCashCallback,
  buildEasyPaisaCheckoutPayload,
  verifyEasyPaisaCallback,
} = require("../services/paymentGatewayService");
const { notifyRiderForDelivery } = require("../services/riderNotificationService");

// Everything in this file is reachable with NO login at all (see
// routes/publicOrderRoutes.js / middleware/requireShopOrderable.js) - a
// customer's own phone browser, after scanning the shop's QR code. That
// means every input here is untrusted in a way staff-facing controllers
// never have to worry about: item prices are always re-looked-up from the
// real catalog below (never trusted from the request), every string is
// length/shape-checked, and the routes are rate-limited (see
// publicOrderRoutes.js) since there's no auth gate to slow down abuse.

const DEFAULT_TABLE_COUNT = 20;
const MAX_ITEM_LINES = 50;
const MAX_QTY_PER_LINE = 50;

function defaultTableOptions() {
  return Array.from({ length: DEFAULT_TABLE_COUNT }, (_, index) => String(index + 1));
}

function normalizePhone(phone) {
  return String(phone || "").trim();
}

// Same "/pos" path-prefix reasoning as getManifest below - a redirect
// target has to be an ABSOLUTE url, not "/#/order/...", or a shop deployed
// behind an nginx prefix sends the customer's browser to the bare domain
// root (a 404, or a completely different site) instead of back into this
// app.
function publicOrigin(req) {
  const configured = process.env.VITE_API_URL ? process.env.VITE_API_URL.replace(/\/api\/?$/, "") : "";
  return configured || `${req.protocol}://${req.get("host")}`;
}

function publicOrderShape(order) {
  return {
    id: String(order._id),
    dailyOrderNumber: order.dailyOrderNumber,
    orderType: order.orderType,
    table: order.table,
    status: order.status,
    trackingStatus: order.trackingStatus,
    paymentStatus: order.paymentStatus,
    total: order.total,
    createdAt: order.createdAt,
  };
}

// GET /api/public/:shopId/manifest.json
// A per-shop PWA manifest, so "Add to Home Screen" on CustomerOrderPage.tsx
// installs an icon labelled with THIS shop's own name, not the generic
// staff-dashboard manifest at /manifest.json - see CustomerOrderPage.tsx's
// manifest-link swap. start_url deep-links straight back to this shop's
// ordering page. scope has to stay "/" (not "/#/order/:shopId") because
// this whole app is HashRouter-based (see src/main.tsx) and PWA manifest
// scope-matching only ever looks at the real URL path, never the hash
// fragment - a known limitation of hash-routed SPAs, not a bug here.
exports.getManifest = (req, res) => {
  // Icon src has to be an ABSOLUTE url, not "/icon-192.png" - a shop
  // deployed behind an nginx path prefix (e.g. VITE_API_URL=
  // https://host/pos/api - see backend/README-deploy.md) serves its static
  // frontend (and these icon files) under that same "/pos" prefix, which
  // Express itself has no idea about (nginx strips it before proxying).
  // VITE_API_URL is present in process.env here too (dotenv loads the
  // whole .env file for this process, not just the VITE_-prefixed subset
  // Vite exposes to the frontend bundle) - stripping its trailing "/api"
  // gives the real public origin+prefix the static files actually live
  // under. Falls back to this request's own protocol+host when unset,
  // which is correct for local dev (no prefix at all).
  const origin = publicOrigin(req);

  res.set("Content-Type", "application/manifest+json");
  res.json({
    name: `${req.shop.name} - Order Online`,
    short_name: req.shop.name,
    start_url: `${origin}/#/order/${req.shop._id}`,
    scope: `${origin}/`,
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#000000",
    icons: [
      { src: `${origin}/icon-192.png`, sizes: "192x192", type: "image/png" },
      { src: `${origin}/icon-512.png`, sizes: "512x512", type: "image/png" },
    ],
  });
};

// GET /api/public/:shopId/menu
exports.getMenu = async (req, res) => {
  try {
    const shopId = req.shop._id;
    const [products, openSession] = await Promise.all([
      Product.find({ shopId }).sort({ category: 1, name: 1 }).lean(),
      ShopSession.findOne({ shopId, status: "open" }).lean(),
    ]);

    const gateway = req.shop.paymentGateway || {};
    res.json({
      shopName: req.shop.name,
      isOpen: Boolean(openSession),
      // Only tells the frontend WHICH online methods are actually usable
      // for this shop - never the credentials themselves (this endpoint is
      // public/unauthenticated).
      paymentMethods: {
        jazzCash: isJazzCashConfigured(gateway.jazzCash),
        easyPaisa: isEasyPaisaConfigured(gateway.easyPaisa),
      },
      products: products.map((product) => ({
        id: String(product._id),
        name: product.name,
        price: product.price,
        category: product.category || "General",
        variation: product.variation || "",
        image: product.image || "",
        // Same per-product color chip POSPage.tsx's product grid uses
        // behind each icon (see models/Product.js) - included here so the
        // customer ordering page's cards visually match the exact same
        // catalog a shop set up on desktop, not a generic customer-only
        // look.
        color: product.color || "bg-slate-50",
        description: product.description || "",
        isDeal: Boolean(product.isDeal),
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/public/:shopId/tables
exports.getTables = async (req, res) => {
  try {
    const shopId = req.shop._id;
    const orders = await Order.find({
      shopId,
      orderType: "DineIn",
      status: "pending",
      table: { $nin: [null, ""] },
    })
      .select("table")
      .lean();
    const occupied = Array.from(new Set(orders.map((order) => order.table).filter(Boolean)));
    res.json({ tables: req.shop.tables || [], occupied });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/public/:shopId/customer-status?phone=...
exports.getCustomerStatus = async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) return res.json({ hasActiveDineInOrder: false, order: null });

    const existing = await Order.findOne({
      shopId: req.shop._id,
      "customer.phone": phone,
      orderType: "DineIn",
      status: "pending",
    })
      .sort({ createdAt: -1 })
      .select("dailyOrderNumber table createdAt")
      .lean();

    res.json({
      hasActiveDineInOrder: Boolean(existing),
      order: existing
        ? { id: String(existing._id), dailyOrderNumber: existing.dailyOrderNumber, table: existing.table, createdAt: existing.createdAt }
        : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/public/:shopId/orders/:orderId
exports.getOrderStatus = async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.orderId, shopId: req.shop._id })
      .select("dailyOrderNumber orderType table status trackingStatus paymentStatus total createdAt")
      .lean();
    if (!order) return res.status(404).json({ message: "Order not found." });
    res.json(publicOrderShape(order));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/public/:shopId/orders
// body: { orderType, table?, customer: { name, phone, address? },
//         paymentMethod, paymentApp?, note?, items: [{ name, variation, quantity }],
//         location?: { lat, lng, accuracy } }
exports.createOrder = async (req, res) => {
  try {
    const shopId = req.shop._id;
    const payload = req.body || {};

    const orderType = payload.orderType;
    if (!["DineIn", "TakeAway", "Delivery"].includes(orderType)) {
      return res.status(400).json({ message: "Choose Dine-In, Takeaway, or Delivery.", reason: "invalid_order_type" });
    }

    const customerName = String(payload.customer?.name || "").trim();
    const customerPhone = normalizePhone(payload.customer?.phone);
    const customerAddress = String(payload.customer?.address || payload.address || "").trim();

    if (customerName.length < 2) {
      return res.status(400).json({ message: "Please enter your name.", reason: "invalid_name" });
    }
    const phoneDigits = customerPhone.replace(/\D/g, "");
    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
      return res.status(400).json({ message: "Please enter a valid phone number.", reason: "invalid_phone" });
    }
    if (orderType === "Delivery" && customerAddress.length < 5) {
      return res.status(400).json({ message: "Please enter a delivery address.", reason: "invalid_address" });
    }

    let table = "";
    if (orderType === "DineIn") {
      table = String(payload.table || "").trim();
      const allowedTables = req.shop.tables && req.shop.tables.length > 0 ? req.shop.tables : defaultTableOptions();
      if (!table || !allowedTables.includes(table)) {
        return res.status(400).json({ message: "Please choose a table.", reason: "invalid_table" });
      }
    }

    const openSession = await ShopSession.findOne({ shopId, status: "open" }).lean();
    if (!openSession) {
      return res.status(409).json({ message: "This shop is currently closed and isn't taking orders right now.", reason: "shop_closed" });
    }

    // Never trust client-submitted prices/names - re-look-up every line
    // against this shop's real catalog and use ITS price.
    const requestedItems = Array.isArray(payload.items) ? payload.items.slice(0, MAX_ITEM_LINES) : [];
    if (requestedItems.length === 0) {
      return res.status(400).json({ message: "Your cart is empty.", reason: "empty_cart" });
    }

    const catalog = await Product.find({ shopId }).lean();
    const byKey = new Map();
    catalog.forEach((product) => {
      const key = `${product.name}::${product.variation || ""}`;
      byKey.set(key, product);
      if (!byKey.has(product.name)) byKey.set(product.name, product);
    });

    const items = [];
    for (const requested of requestedItems) {
      const name = String(requested?.name || "");
      const variation = String(requested?.variation || "");
      const quantity = Math.min(Math.max(Math.floor(Number(requested?.quantity) || 0), 1), MAX_QTY_PER_LINE);
      const product = byKey.get(`${name}::${variation}`) || byKey.get(name);
      if (!product) {
        return res.status(400).json({ message: `"${name}" is no longer on the menu - please refresh and try again.`, reason: "item_not_found" });
      }
      items.push({ name: product.name, price: product.price, quantity, variation: product.variation || "" });
    }

    if (orderType === "DineIn") {
      const [tableTaken, existingForPhone] = await Promise.all([
        Order.exists({ shopId, orderType: "DineIn", status: "pending", table }),
        Order.findOne({ shopId, "customer.phone": customerPhone, orderType: "DineIn", status: "pending" })
          .select("dailyOrderNumber table")
          .lean(),
      ]);
      if (tableTaken) {
        return res.status(409).json({ message: `Table ${table} is already occupied - please choose another.`, reason: "table_occupied" });
      }
      // One-table-per-phone restriction.
      if (existingForPhone) {
        return res.status(409).json({
          message: `You already have an active order at Table ${existingForPhone.table} (Order #${existingForPhone.dailyOrderNumber}). Please finish that order before starting another.`,
          reason: "already_has_table",
          existingOrder: { id: String(existingForPhone._id), table: existingForPhone.table, dailyOrderNumber: existingForPhone.dailyOrderNumber },
        });
      }
    }

    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const total = subtotal; // No tax/discount on a public order - staff can still adjust before completing it.

    const dailyOrderNumber = (
      await ShopSession.findOneAndUpdate({ _id: openSession._id }, { $inc: { orderCounter: 1 } }, { new: true })
    ).orderCounter;
    const shopUpdate = await Shop.findOneAndUpdate({ _id: shopId }, { $inc: { orderSequenceCounter: 1 } }, { new: true });
    const shopSequenceNumber = shopUpdate ? shopUpdate.orderSequenceCounter : 1;

    const isOnlinePayment = payload.paymentMethod === "JazzCash" || payload.paymentMethod === "EasyPaisa";
    const paymentMethod = isOnlinePayment ? "E-Wallet" : "Cash";
    const customerNote = String(payload.note || "").trim();
    const noteParts = [];
    if (isOnlinePayment) noteParts.push(`Customer selected ${payload.paymentMethod} - awaiting online payment confirmation.`);
    if (customerNote) noteParts.push(customerNote);

    // Real-time location, captured once from the customer's own phone -
    // see models/Order.js's deliveryLocation comment. Only kept for
    // Delivery orders; silently ignored otherwise.
    const location = payload.location;
    const deliveryLocation =
      orderType === "Delivery" && location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))
        ? { lat: Number(location.lat), lng: Number(location.lng), accuracy: Number(location.accuracy) || null, capturedAt: new Date() }
        : null;

    const order = await Order.create({
      shopId,
      items,
      subtotal,
      tax: 0,
      total,
      orderType,
      customer: { name: customerName, phone: customerPhone, address: customerAddress },
      address: customerAddress,
      note: noteParts.join(" - "),
      table,
      paymentMethod,
      dailyOrderNumber,
      shopSequenceNumber,
      paidAmount: 0,
      remainingAmount: total,
      source: "customer-qr",
      trackingStatus: "awaiting_confirmation",
      paymentStatus: isOnlinePayment ? "awaiting_confirmation" : "unpaid",
      deliveryLocation,
    });

    // Best-effort contact sync - never allowed to fail the order itself.
    try {
      await Customer.findOneAndUpdate(
        { phone: customerPhone, shopId },
        { name: customerName, phone: customerPhone, address: customerAddress, shopId },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } catch (customerError) {
      console.error("Non-fatal: customer contact-info sync failed for a public QR order", customerError);
    }

    res.status(201).json({
      id: String(order._id),
      dailyOrderNumber: order.dailyOrderNumber,
      orderType: order.orderType,
      table: order.table,
      total: order.total,
      status: order.status,
      trackingStatus: order.trackingStatus,
      paymentStatus: order.paymentStatus,
      requiresOnlinePayment: isOnlinePayment,
      paymentMethod: isOnlinePayment ? payload.paymentMethod : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/public/:shopId/orders/:orderId/pay/:provider  (provider: jazzcash|easypaisa)
// Builds the redirect payload for the customer's browser to auto-POST to
// the gateway's own hosted checkout page - see paymentGatewayService.js.
exports.initiatePayment = async (req, res) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    if (!["jazzcash", "easypaisa"].includes(provider)) {
      return res.status(400).json({ message: "Unknown payment provider." });
    }

    const order = await Order.findOne({ _id: req.params.orderId, shopId: req.shop._id });
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (order.paymentStatus === "paid") {
      return res.status(409).json({ message: "This order is already paid." });
    }

    const gateway = req.shop.paymentGateway || {};
    // Same "/pos" path-prefix reasoning as publicOrigin() above, but for
    // the API base itself (not the frontend origin) - this is the URL the
    // GATEWAY calls back to, so it has to be the real externally-reachable
    // address, prefix included, or JazzCash/EasyPaisa's callback never
    // reaches this backend at all on a shop deployed behind one.
    const apiBase = process.env.VITE_API_URL || `${req.protocol}://${req.get("host")}/api`;
    const publicBase = `${apiBase.replace(/\/$/, "")}/public/${req.shop._id}`;

    if (provider === "jazzcash") {
      const { url, fields, txnRefNo } = buildJazzCashCheckoutPayload(order, gateway.jazzCash, `${publicBase}/payments/jazzcash/callback`);
      order.paymentGateway = { provider: "JazzCash", txnRefNo, transactionId: "", raw: null };
      await order.save();
      return res.json({ url, fields });
    }

    const { url, fields, orderRefNum } = buildEasyPaisaCheckoutPayload(order, gateway.easyPaisa, `${publicBase}/payments/easypaisa/callback`);
    order.paymentGateway = { provider: "EasyPaisa", txnRefNo: orderRefNum, transactionId: "", raw: null };
    await order.save();
    res.json({ url, fields });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message, reason: error.reason });
    res.status(500).json({ message: error.message });
  }
};

async function findOrderByTxnRef(shopId, txnRefNo) {
  return Order.findOne({ shopId, "paymentGateway.txnRefNo": txnRefNo });
}

// The gateway calls this (or redirects the customer's browser through it)
// once payment finishes on its own hosted page - never trusted at face
// value, always re-verified via the hash (see paymentGatewayService.js).
// A verified success here is the ONE automatic path to trackingStatus
// "confirmed" - see updateTrackingStatus in orderController.js for the
// manual (staff/admin) path.
exports.jazzCashCallback = async (req, res) => {
  try {
    const fields = { ...req.query, ...req.body };
    const gateway = req.shop.paymentGateway?.jazzCash;
    const order = await findOrderByTxnRef(req.shop._id, fields.pp_TxnRefNo);
    if (!order || !gateway) return res.status(404).send("Order not found.");

    const result = verifyJazzCashCallback(fields, gateway);
    if (result.verified && result.success) {
      order.paymentStatus = "paid";
      order.paymentGateway.transactionId = result.transactionId || "";
      order.paymentGateway.raw = fields;
      if (order.trackingStatus === "awaiting_confirmation") order.trackingStatus = "confirmed";
      await order.save();
      if (order.orderType === "Delivery" && order.trackingStatus === "confirmed") {
        void notifyRiderForDelivery(order, req.shop);
      }
    } else if (result.verified) {
      order.paymentStatus = "failed";
      order.paymentGateway.raw = fields;
      await order.save();
    }
    // Send the customer's browser back to their order-status page either way.
    res.redirect(302, `${publicOrigin(req)}/#/order/${req.shop._id}/status/${order._id}`);
  } catch (error) {
    res.status(500).send(error.message);
  }
};

exports.easyPaisaCallback = async (req, res) => {
  try {
    const fields = { ...req.query, ...req.body };
    const gateway = req.shop.paymentGateway?.easyPaisa;
    const order = await findOrderByTxnRef(req.shop._id, fields.orderRefNum);
    if (!order || !gateway) return res.status(404).send("Order not found.");

    const result = verifyEasyPaisaCallback(fields, gateway);
    if (result.verified && result.success) {
      order.paymentStatus = "paid";
      order.paymentGateway.transactionId = result.transactionId || "";
      order.paymentGateway.raw = fields;
      if (order.trackingStatus === "awaiting_confirmation") order.trackingStatus = "confirmed";
      await order.save();
      if (order.orderType === "Delivery" && order.trackingStatus === "confirmed") {
        void notifyRiderForDelivery(order, req.shop);
      }
    } else if (result.verified) {
      order.paymentStatus = "failed";
      order.paymentGateway.raw = fields;
      await order.save();
    }
    res.redirect(302, `${publicOrigin(req)}/#/order/${req.shop._id}/status/${order._id}`);
  } catch (error) {
    res.status(500).send(error.message);
  }
};
