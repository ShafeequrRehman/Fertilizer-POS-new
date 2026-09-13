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

const MAX_ITEM_LINES = 50;
const MAX_QTY_PER_LINE = 50;

function normalizePhone(phone) {
  return String(phone || "").trim();
}

// Same "/pos" path-prefix reasoning as getManifest below - a redirect
// target has to be an ABSOLUTE url, not "/#/order/...", or a shop deployed
// behind an nginx prefix sends the customer's browser to the bare domain
// root (a 404, or a completely different site) instead of back into this
// app.
//
// Dev-mode fallback fix: `req.protocol://req.get("host")` used to be the
// fallback here whenever VITE_API_URL is unset - correct in production
// (backend/index.js's express.static(dist) serves the built frontend +
// icons from that exact same origin/port), but WRONG in local `npm run
// dev`, where the frontend/icons live on Vite's dev server (port 5173,
// see vite.config.ts) while this controller's own `req` is always the
// *backend's* port (5000, see package.json's dev:backend). That mismatch
// silently 404'd this manifest's icons in dev - Chrome then refuses to
// fire beforeinstallprompt for an "invalid" manifest, which is exactly the
// "Install button used to show, now it doesn't" report this fixes. Only
// applies when NODE_ENV isn't "production" (dev:backend never sets it) -
// production/staging always have VITE_API_URL configured, so they never
// reach this fallback at all.
function publicOrigin(req) {
  const configured = process.env.VITE_API_URL ? process.env.VITE_API_URL.replace(/\/api\/?$/, "") : "";
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") return "http://localhost:5173";
  return `${req.protocol}://${req.get("host")}`;
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
    subtotal: order.subtotal,
    // Same "other charges" slot customerNotificationService.js's WhatsApp
    // templates use - no dedicated delivery-fee field exists yet, `tax` is
    // the only "extra line item" today (always 0 for now).
    otherCharges: order.tax,
    total: order.total,
    paymentMethod: order.paymentMethod,
    createdAt: order.createdAt,
    address: order.address || "",
    // Only meaningful for a Delivery order, once staff has actually handed
    // it to someone - see orderController.assignRider. null otherwise.
    assignedRider:
      order.assignedRider && order.assignedRider.phone
        ? { name: order.assignedRider.name || "", phone: order.assignedRider.phone }
        : null,
    // Read-only for the tracking view (CustomerOrderPage.tsx's
    // OrderStatusPanel) - a customer can see exactly what they ordered
    // here, but there's no corresponding public edit endpoint anywhere in
    // this file. Changing an already-placed order is deliberately staff/
    // shop-owner-only (see orderController.updateOrder), never something
    // this public API exposes.
    items: (order.items || []).map((item) => ({
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      variation: item.variation || "",
    })),
    customerChangeRequest: order.customerChangeRequest
      ? {
          addItems: (order.customerChangeRequest.addItems || []).map((item) => ({
            name: item.name,
            price: item.price,
            quantity: item.quantity,
            variation: item.variation || "",
          })),
          removeItems: (order.customerChangeRequest.removeItems || []).map((item) => ({
            name: item.name,
            variation: item.variation || "",
            quantity: item.quantity,
          })),
          note: order.customerChangeRequest.note || "",
          status: order.customerChangeRequest.status,
          requestedAt: order.customerChangeRequest.requestedAt,
        }
      : null,
  };
}

// A customer can only ever add NEW items within this window of placing
// the order - after that the kitchen may already be well underway, so
// only removals stay available (see requestOrderChange below and its
// gating in CustomerOrderPage.tsx's ChangeRequestModal).
const ADD_ITEMS_WINDOW_MS = 5 * 60 * 1000;

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

// GET /api/public/:shopId/customer-status?phone=...
// Checks for ANY still-active order (any orderType) for this phone at this
// shop - the one-active-order-per-phone restriction now applies across
// Dine-In/Takeaway/Delivery alike (see createOrder below), not just
// Dine-In table reservations. CustomerOrderPage.tsx polls this as the
// customer types their phone number, to warn them (and offer a "Track it"
// shortcut) before they even try to submit.
exports.getCustomerStatus = async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) return res.json({ hasActiveOrder: false, order: null });

    const existing = await Order.findOne({
      shopId: req.shop._id,
      "customer.phone": phone,
      status: "pending",
    })
      .sort({ createdAt: -1 })
      .select("dailyOrderNumber orderType table createdAt")
      .lean();

    res.json({
      hasActiveOrder: Boolean(existing),
      order: existing
        ? {
            id: String(existing._id),
            dailyOrderNumber: existing.dailyOrderNumber,
            orderType: existing.orderType,
            table: existing.table,
            createdAt: existing.createdAt,
          }
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
      .select(
        "dailyOrderNumber orderType table status trackingStatus paymentStatus subtotal tax total paymentMethod createdAt address assignedRider items customerChangeRequest",
      )
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
    if (!["TakeAway", "Delivery"].includes(orderType)) {
      return res.status(400).json({ message: "Choose Takeaway or Delivery.", reason: "invalid_order_type" });
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
    // Real-time GPS location is mandatory for Delivery - not just
    // best-effort anymore. Re-checked here server-side, not just enforced
    // by CustomerOrderPage.tsx's own blocking UI, since the whole point of
    // never trusting the client is that a direct API call could otherwise
    // skip straight past a frontend-only gate. See deliveryLocation build
    // below for where this gets stored.
    const requestedLocation = payload.location;
    const hasValidLocation =
      requestedLocation && Number.isFinite(Number(requestedLocation.lat)) && Number.isFinite(Number(requestedLocation.lng));
    if (orderType === "Delivery" && !hasValidLocation) {
      return res.status(400).json({
        message: "Please allow location access so the rider can find you - location is required for delivery orders.",
        reason: "location_required",
      });
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
      items.push({
        name: product.name,
        price: product.price,
        quantity,
        variation: product.variation || "",
        // Carry the real product photo forward the same way a POS-placed
        // order already does (see orderItemSchema.image in models/Order.js)
        // - without this, a customer-placed order's item has no image at
        // all and Sales/staff views silently fall back to a generic
        // keyword-matched icon instead of the exact photo the customer saw
        // on the ordering page for the same product.
        image: product.image || "",
      });
    }

    // One-active-order-per-phone restriction - applies across ALL order
    // types (Dine-In, Takeaway, Delivery alike), not just Dine-In. A
    // customer can only have one order in flight with this shop at a time;
    // they have to wait for staff to complete (or cancel) it before
    // placing another. "Active" here matches the same boundary
    // orderController.applyOrderPatch's completeAndSettle uses to flip a
    // real order to status "completed" - i.e. still status: "pending".
    // Keeps CustomerOrderPage.tsx's on-device tracking session
    // unambiguous too - there's only ever one order worth remembering.
    const existingActiveForPhone = await Order.findOne({ shopId, "customer.phone": customerPhone, status: "pending" })
      .select("dailyOrderNumber orderType table")
      .lean();
    if (existingActiveForPhone) {
      return res.status(409).json({
        message: `You already have an active order (#${existingActiveForPhone.dailyOrderNumber}). Please wait until it's completed before placing another.`,
        reason: "already_has_active_order",
        existingOrder: {
          id: String(existingActiveForPhone._id),
          orderType: existingActiveForPhone.orderType,
          table: existingActiveForPhone.table,
          dailyOrderNumber: existingActiveForPhone.dailyOrderNumber,
        },
      });
    }

    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const total = subtotal; // No tax/discount on a public order - staff can still adjust before completing it.

    const dailyOrderNumber = (
      await ShopSession.findOneAndUpdate({ _id: openSession._id }, { $inc: { orderCounter: 1 } }, { new: true })
    ).orderCounter;
    const shopUpdate = await Shop.findOneAndUpdate({ _id: shopId }, { $inc: { orderSequenceCounter: 1 } }, { new: true });
    const shopSequenceNumber = shopUpdate ? shopUpdate.orderSequenceCounter : 1;

    // Two flavors of "not cash": a real gateway (JazzCash/EasyPaisa hosted
    // checkout - only offered if the shop configured credentials, see
    // getMenu's paymentMethods flags) that auto-confirms via a verified
    // webhook, and a plain "Online" option that's always available even
    // with no gateway set up - the customer is telling the shop they'll
    // pay by bank transfer/EasyPaisa-JazzCash-personal-account/etc
    // directly, and staff confirms it manually the same way they'd confirm
    // cash. Only the gateway kind triggers a redirect/awaiting_confirmation
    // paymentStatus - "Online" behaves like Cash order-flow-wise, it's just
    // tagged differently so staff know not to expect cash in hand.
    const isGatewayPayment = payload.paymentMethod === "JazzCash" || payload.paymentMethod === "EasyPaisa";
    const isOnlineIntent = isGatewayPayment || payload.paymentMethod === "Online";
    const paymentMethod = isOnlineIntent ? "E-Wallet" : "Cash";
    const customerNote = String(payload.note || "").trim();
    const noteParts = [];
    if (isGatewayPayment) noteParts.push(`Customer selected ${payload.paymentMethod} - awaiting online payment confirmation.`);
    else if (payload.paymentMethod === "Online") noteParts.push("Customer selected to pay online directly - please confirm payment with them.");
    if (customerNote) noteParts.push(customerNote);

    // Real-time location, captured once from the customer's own phone -
    // see models/Order.js's deliveryLocation comment. Mandatory (and
    // already validated above) for Delivery; not collected for the other
    // order types at all.
    const deliveryLocation =
      orderType === "Delivery" && hasValidLocation
        ? { lat: Number(requestedLocation.lat), lng: Number(requestedLocation.lng), accuracy: Number(requestedLocation.accuracy) || null, capturedAt: new Date() }
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
      paymentMethod,
      dailyOrderNumber,
      shopSequenceNumber,
      paidAmount: 0,
      remainingAmount: total,
      source: "customer-qr",
      trackingStatus: "awaiting_confirmation",
      paymentStatus: isGatewayPayment ? "awaiting_confirmation" : "unpaid",
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
      // Only a real gateway needs the frontend to redirect anywhere -
      // "Online" (no gateway) behaves like Cash from here on, the customer
      // just goes straight to the tracking view like any other order.
      requiresOnlinePayment: isGatewayPayment,
      paymentMethod: isGatewayPayment ? payload.paymentMethod : payload.paymentMethod === "Online" ? "Online" : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/public/:shopId/orders/:orderId/change-request
// body: { addItems?: [{name, variation, quantity}], removeItems?: [{name, variation, quantity}], note? }
// A customer's own request to add/remove items on an order they already
// placed - never applied directly. It just sits on the order as "pending"
// until staff approves/rejects it from the Sales dashboard (see
// orderController.respondToChangeRequest). Only one request can be
// outstanding at a time.
exports.requestOrderChange = async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.orderId, shopId: req.shop._id });
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (order.source !== "customer-qr") {
      return res.status(400).json({ message: "This order can't be changed here." });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ message: "This order is already finished and can no longer be changed.", reason: "order_finished" });
    }
    if (["preparing", "ready", "cancelled"].includes(order.trackingStatus)) {
      return res.status(409).json({
        message: "The kitchen has already started on this order - please contact the shop directly for any changes.",
        reason: "too_late",
      });
    }
    if (order.customerChangeRequest && order.customerChangeRequest.status === "pending") {
      return res.status(409).json({ message: "You already have a change request waiting for approval.", reason: "request_pending" });
    }

    const payload = req.body || {};
    const requestedAdd = Array.isArray(payload.addItems) ? payload.addItems.slice(0, MAX_ITEM_LINES) : [];
    const requestedRemove = Array.isArray(payload.removeItems) ? payload.removeItems.slice(0, MAX_ITEM_LINES) : [];
    const note = String(payload.note || "").trim().slice(0, 300);

    if (requestedAdd.length === 0 && requestedRemove.length === 0) {
      return res.status(400).json({ message: "Choose at least one item to add or remove.", reason: "empty_request" });
    }

    // The 5-minute add-items window - re-checked here server-side, not
    // just hidden client-side once the countdown hits zero.
    const orderAgeMs = Date.now() - new Date(order.createdAt).getTime();
    if (requestedAdd.length > 0 && orderAgeMs > ADD_ITEMS_WINDOW_MS) {
      return res.status(409).json({ message: "You can only add items within 5 minutes of placing your order.", reason: "add_window_expired" });
    }

    // Never trust client-submitted prices/names - re-look-up every
    // requested addition against the real catalog, same as createOrder.
    const addItems = [];
    if (requestedAdd.length > 0) {
      const catalog = await Product.find({ shopId: req.shop._id }).lean();
      const byKey = new Map();
      catalog.forEach((product) => {
        const key = `${product.name}::${product.variation || ""}`;
        byKey.set(key, product);
        if (!byKey.has(product.name)) byKey.set(product.name, product);
      });
      for (const requested of requestedAdd) {
        const name = String(requested?.name || "");
        const variation = String(requested?.variation || "");
        const quantity = Math.min(Math.max(Math.floor(Number(requested?.quantity) || 0), 1), MAX_QTY_PER_LINE);
        const product = byKey.get(`${name}::${variation}`) || byKey.get(name);
        if (!product) {
          return res.status(400).json({ message: `"${name}" is no longer on the menu - please refresh and try again.`, reason: "item_not_found" });
        }
        // Same image carry-forward as createOrder above - these lines get
        // folded straight into the real order.items on approval (see
        // respondToChangeRequest in orderController.js), so without this
        // they'd hit the same missing-photo bug for a mid-order addition.
        addItems.push({ name: product.name, price: product.price, quantity, variation: product.variation || "", image: product.image || "" });
      }
    }

    // Removals have to actually be part of what's already on the order,
    // and can't exceed what's currently there.
    const removeItems = [];
    if (requestedRemove.length > 0) {
      const currentQuantities = new Map();
      (order.items || []).forEach((item) => {
        const key = `${item.name}::${item.variation || ""}`;
        currentQuantities.set(key, (currentQuantities.get(key) || 0) + item.quantity);
      });
      for (const requested of requestedRemove) {
        const name = String(requested?.name || "");
        const variation = String(requested?.variation || "");
        const key = `${name}::${variation}`;
        const available = currentQuantities.get(key) || 0;
        const quantity = Math.min(Math.max(Math.floor(Number(requested?.quantity) || 0), 1), available);
        if (quantity <= 0) {
          return res.status(400).json({ message: `"${name}" isn't part of your order.`, reason: "item_not_in_order" });
        }
        removeItems.push({ name, variation, quantity });
      }
    }

    order.customerChangeRequest = {
      addItems,
      removeItems,
      note,
      status: "pending",
      requestedAt: new Date(),
      respondedAt: null,
      respondedBy: "",
    };
    order.version = Number(order.version || 0) + 1;
    await order.save();

    res.json({
      message: "Request sent - waiting for the shop to approve.",
      customerChangeRequest: publicOrderShape(order).customerChangeRequest,
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
