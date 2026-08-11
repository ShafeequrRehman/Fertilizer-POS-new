const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const Customer = require("../models/Customer");
const Order = require("../models/Order");
const ShopSession = require("../models/ShopSession");
const Shop = require("../models/Shop");
const User = require("../models/User");
const { shopScope } = require("../middleware/attachShopScope");

// Discount is either a flat rupee amount (type "value") or a percentage of
// the subtotal (type "percent"). The frontend only ever sends one type at a
// time (the checkout has two inputs - Amount and Percent - and packages
// whichever one the cashier actually used, with Amount winning if both are
// filled), so this just computes the rupee amount for whichever type it
// receives. Clamped so a discount can never exceed the subtotal.
function computeDiscountAmount(discount, subtotal) {
  if (!discount || typeof discount !== "object") return 0;
  const value = Number(discount.value) || 0;
  if (value <= 0 || subtotal <= 0) return 0;
  if (discount.type === "percent") {
    return Math.min(Math.round((subtotal * value) / 100), subtotal);
  }
  return Math.min(Math.round(value), subtotal);
}

// No tax is added by default (previously a hardcoded 10% of subtotal) - the
// discount, if any, is subtracted straight from the subtotal to get the
// final payable total - never trusted from the client's own "total" field.
function recalculateTotals(items, discount) {
  const subtotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  const tax = 0;
  const discountAmount = computeDiscountAmount(discount, subtotal);
  const total = Math.max(subtotal + tax - discountAmount, 0);
  return { subtotal, tax, total, discountAmount };
}

// Only ever stores a discount when it actually reduced the total by
// something - avoids leaving a stray { type, value: 0, amount: 0 } object
// on every order that never had one.
function buildDiscountRecord(discount, discountAmount) {
  if (!discount || discountAmount <= 0) return null;
  return {
    type: discount.type === "percent" ? "percent" : "value",
    value: Number(discount.value) || 0,
    amount: discountAmount,
  };
}

function kitchenItemKey(item) {
  return `${item.name}::${item.variation || ""}`;
}

// Sums an item list's quantities per name+variation, since the same item
// can legitimately appear as more than one line (e.g. added at different
// times) - the kitchen ticket only cares about the net quantity per item.
function sumQuantitiesByKey(items) {
  const map = new Map();
  (items || []).forEach((item) => {
    const key = kitchenItemKey(item);
    map.set(key, (map.get(key) || 0) + (Number(item.quantity) || 0));
  });
  return map;
}

// What "replaceItems" (the action EditOrderPage.tsx and pos-mobile's
// quantity steppers both use) changed that the kitchen actually needs to
// know about: only INCREASES, whether that's an existing line's quantity
// going up or a brand new line being added via replaceItems (e.g. desktop's
// Quick Add Product panel). Removed items / quantity decreases are
// deliberately excluded - those go through the separate "kitchen-remove"
// ticket (see EditOrderPage.tsx's printKitchenRemoveTicket), which says
// "stop preparing" rather than "prepare more".
function computeKitchenIncreaseDelta(oldItems, newItems) {
  const oldQuantities = sumQuantitiesByKey(oldItems);
  const newQuantities = sumQuantitiesByKey(newItems);
  const meta = new Map();
  (newItems || []).forEach((item) => {
    const key = kitchenItemKey(item);
    if (!meta.has(key)) meta.set(key, { name: item.name, price: item.price, variation: item.variation || "" });
  });

  const delta = [];
  newQuantities.forEach((newQty, key) => {
    const oldQty = oldQuantities.get(key) || 0;
    const diff = newQty - oldQty;
    if (diff > 0) {
      delta.push({ ...meta.get(key), quantity: diff });
    }
  });
  return delta;
}

// Folds a new delta into whatever's already queued and unprinted, summing
// quantities per item - so a customer bumping the same item's quantity
// twice before a till gets around to printing it doesn't lose the first
// bump, and a till doesn't have to print twice for two quick edits.
function mergeKitchenDelta(existingItems, delta) {
  const map = new Map();
  (existingItems || []).forEach((item) => {
    map.set(kitchenItemKey(item), { name: item.name, price: item.price, variation: item.variation || "", quantity: Number(item.quantity) || 0 });
  });
  delta.forEach((item) => {
    const key = kitchenItemKey(item);
    const existing = map.get(key);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      map.set(key, { ...item });
    }
  });
  return Array.from(map.values());
}

// Previously orders were scoped by `userId` (the logged-in account), which
// worked fine with a single admin account but is wrong for a shop with
// multiple staff: a Cashier ringing up a sale needs to see orders the
// Manager or another Cashier created too. The tenant boundary is now the
// shop (`shopId`), not the individual account - `userId` is kept on the
// Order purely as "who created this" attribution, unfiltered on read.
function buildShopScope(req) {
  return shopScope(req);
}

exports.getOrders = async (req, res) => {
  try {
    const query = buildShopScope(req);
    if (req.query.date) {
      const start = new Date(`${req.query.date}T00:00:00.000Z`);
      const end = new Date(`${req.query.date}T23:59:59.999Z`);
      query.createdAt = { $gte: start, $lte: end };
    } else if (req.query.since) {
      // Bounds an otherwise-unbounded "give me this shop's orders" fetch -
      // used by pages that only ever care about recent activity (today's
      // shift, the kitchen's currently-pending tickets) so they don't pull
      // a shop's entire lifetime order history over the wire on every poll
      // (Dashboard/Sales every 45s, Kitchen every 10s). Without this, that
      // query only gets slower as a shop accumulates history, eventually
      // past the point of timing out client-side even on a perfectly fine
      // connection - see pos-web/src/pages/dashboard/components/
      // DashboardPageClient.tsx, SalesPage.tsx, KitchenPage.tsx.
      const since = new Date(req.query.since);
      if (!Number.isNaN(since.getTime())) {
        query.createdAt = { $gte: since };
      }
    }

    const orders = await Order.find(query).sort({ createdAt: -1 });
    res.json(orders.map((order) => ({ ...order.toObject(), id: String(order._id) })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getOrder = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = await Order.findOne({ _id: req.params.id, ...buildShopScope(req) });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json({ ...order.toObject(), id: String(order._id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createOrder = async (req, res) => {
  try {
    // The shop must be explicitly "opened" (see shopSessionController) for
    // new orders to be rung up at all - enforced here, not just hidden in
    // the UI, so a stale POS tab or a direct API call can't slip an order
    // in while the shop is marked closed. This same call also atomically
    // hands out the next order number for the shift (see orderCounter on
    // the ShopSession model) - findOneAndUpdate + $inc is a single atomic
    // operation in MongoDB, so two orders placed at the exact same instant
    // can never read/get the same number the way a separate
    // "countDocuments() then +1" step could (that was producing duplicate
    // "#001" tickets under real-world concurrent submissions). A dropped
    // request after this point burns a number (a small gap in the
    // sequence), which is a fine trade-off for guaranteeing no duplicates.
    // Defense-in-depth: ShopSession now has a partial unique index that
    // makes more than one "open" session per shop impossible going forward
    // (see models/ShopSession.js), but this `sort` guarantees that if any
    // legacy duplicate ever slips through some other way, the oldest (the
    // one actually carrying the real running count) always wins rather
    // than a non-deterministic match landing on a fresher duplicate whose
    // orderCounter defaults to 0.
    const openSession = await ShopSession.findOneAndUpdate(
      { ...buildShopScope(req), status: "open" },
      { $inc: { orderCounter: 1 } },
      { new: true, sort: { openedAt: 1 } }
    );
    if (!openSession) {
      return res.status(409).json({ error: "The shop is closed. Open the shop before taking new orders.", reason: "shop_closed" });
    }

    const payload = req.body;
    const totals = recalculateTotals(payload.items || [], payload.discount);
    const dailyOrderNumber = openSession.orderCounter;

    const order = await Order.create({
      ...payload,
      ...buildShopScope(req),
      userId: req.user?.id ? String(req.user.id) : payload.userId,
      subtotal: totals.subtotal,
      tax: totals.tax,
      total: totals.total,
      discount: buildDiscountRecord(payload.discount, totals.discountAmount),
      dailyOrderNumber,
      clientSyncId: payload.clientSyncId || payload.orderId || "",
      paidAmount: payload.paidAmount || 0,
      remainingAmount: typeof payload.remainingAmount === "number" ? payload.remainingAmount : totals.total,
    });

    // Surfaced to the client (instead of only console.error) so a broken
    // customer sync is never silently invisible again - this exact class of
    // bug (orders saving fine while the customer record quietly never got
    // created, because of a stale legacy unique index on customers.phone -
    // see config/seed.js's dropLegacyCustomerPhoneIndex) went unnoticed for
    // a while precisely because nothing surfaced it anywhere.
    let customerSyncWarning = null;

    if (payload.customer?.phone && payload.customer.phone !== "03000000000") {
      const customerUpdate = {
        name: payload.customer.name,
        phone: payload.customer.phone,
        address: payload.customer.address || payload.address || "",
        shopId: req.user.shopId,
      };

      // Best-effort contact-info sync - never allowed to fail the order
      // itself, which is already safely saved above by this point. Two
      // orders for a phone number that has never placed an order before,
      // submitted within the same instant, can both pass Mongoose's
      // upsert "not found" check and then race on the actual insert -
      // MongoDB's unique index on `phone` then rejects the loser with an
      // E11000 duplicate-key error even though the upsert itself is
      // per-operation atomic. Retry as a plain (non-upsert) update in that
      // case, since the document now certainly exists.
      try {
        await Customer.findOneAndUpdate(
          { phone: payload.customer.phone, ...buildShopScope(req) },
          customerUpdate,
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } catch (customerError) {
        if (customerError?.code === 11000) {
          try {
            await Customer.findOneAndUpdate(
              { phone: payload.customer.phone, ...buildShopScope(req) },
              customerUpdate
            );
          } catch (retryError) {
            console.error("Non-fatal: customer contact-info retry sync failed", retryError);
            customerSyncWarning = "The order was saved, but this customer's info could not be saved to Customers/Ledger. Ask your admin to check the backend logs.";
          }
        } else {
          console.error("Non-fatal: failed to sync customer contact info during createOrder", customerError);
          customerSyncWarning = "The order was saved, but this customer's info could not be saved to Customers/Ledger. Ask your admin to check the backend logs.";
        }
      }
    }

    res.status(201).json({ ...order.toObject(), id: String(order._id), customerSyncWarning });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /api/orders/import-offline
// Called by the desktop app's offline sync engine (see
// pos-web/src/lib/offline-sync.ts) every 5 minutes (and on demand) once
// the shop is back online, to push everything queued in the Local Hub
// (backend/localHub/) while the internet was down. Deliberately a
// separate endpoint rather than looping the client over POST /orders,
// for two reasons: it needs to assign the real dailyOrderNumber to
// several orders in the correct original order (oldest offline order
// first) in one request, and it needs to be safely retryable - if the
// sync engine's earlier attempt got a response but the Local Hub never
// received the ack (crash, closed lid, whatever), retrying must not
// create duplicates. clientSyncId is what makes that safe: each offline
// order already carries the same clientSyncId it would have gotten from
// a normal online submission, and any order that already exists with that
// clientSyncId for this shop is treated as already-imported and skipped
// rather than re-created.
exports.importOfflineOrders = async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.orders) ? req.body.orders : [];
    if (incoming.length === 0) {
      return res.json({ imported: [], skipped: [], failed: [] });
    }

    // Oldest-queued-first, so dailyOrderNumbers come out in the same
    // relative order the till actually rang these up in, even though
    // they're all being created in this one online burst.
    const ordered = [...incoming].sort((a, b) => {
      const aTime = new Date(a.offlineCreatedAt || 0).getTime();
      const bTime = new Date(b.offlineCreatedAt || 0).getTime();
      return aTime - bTime;
    });

    const imported = [];
    const skipped = [];
    const failed = [];

    for (const entry of ordered) {
      const payload = entry?.payload;
      const clientSyncId = payload?.clientSyncId || payload?.orderId || "";

      try {
        if (clientSyncId) {
          const existing = await Order.findOne({ clientSyncId, ...buildShopScope(req) });
          if (existing) {
            skipped.push({ localOrderId: entry.localOrderId, orderId: String(existing._id), dailyOrderNumber: existing.dailyOrderNumber });
            continue;
          }
        }

        // Same atomic-counter allocation createOrder uses - see its
        // comment above for why this has to be a single $inc, not a
        // separate read-then-write. The shop must still be "open" right
        // now for these to import; if it's been closed since the offline
        // orders were queued, importing stops and reports what's left as
        // failed so a human can decide (re-open the shop, or handle these
        // manually) rather than silently dropping them.
        const openSession = await ShopSession.findOneAndUpdate(
          { ...buildShopScope(req), status: "open" },
          { $inc: { orderCounter: 1 } },
          { new: true, sort: { openedAt: 1 } }
        );
        if (!openSession) {
          failed.push({ localOrderId: entry.localOrderId, error: "Shop is closed - open the shop to import queued offline orders." });
          continue;
        }

        const totals = recalculateTotals(payload.items || [], payload.discount);
        const dailyOrderNumber = openSession.orderCounter;

        const order = await Order.create({
          ...payload,
          ...buildShopScope(req),
          userId: payload.userId || (req.user?.id ? String(req.user.id) : ""),
          subtotal: totals.subtotal,
          tax: totals.tax,
          total: totals.total,
          discount: buildDiscountRecord(payload.discount, totals.discountAmount),
          dailyOrderNumber,
          clientSyncId,
          paidAmount: payload.paidAmount || 0,
          remainingAmount: typeof payload.remainingAmount === "number" ? payload.remainingAmount : totals.total,
          createdOffline: true,
          offlineOrderNumber: entry.localOrderNumber || null,
          offlineCreatedAt: entry.offlineCreatedAt ? new Date(entry.offlineCreatedAt) : null,
        });

        if (payload.customer?.phone && payload.customer.phone !== "03000000000") {
          try {
            await Customer.findOneAndUpdate(
              { phone: payload.customer.phone, ...buildShopScope(req) },
              {
                name: payload.customer.name,
                phone: payload.customer.phone,
                address: payload.customer.address || payload.address || "",
                shopId: req.user.shopId,
              },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );
          } catch (customerError) {
            console.error("Non-fatal: customer contact-info sync failed during offline import", customerError);
          }
        }

        imported.push({ localOrderId: entry.localOrderId, orderId: String(order._id), dailyOrderNumber });
      } catch (entryError) {
        console.error("Failed to import one offline order:", entryError);
        failed.push({ localOrderId: entry.localOrderId, error: entryError.message });
      }
    }

    res.json({ imported, skipped, failed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/orders/kitchen/unprinted
// Feeds the till's background "print kitchen tickets for orders nobody has
// printed yet" poll (see pos-web's DashboardShell.tsx) - this is what makes
// an order placed on pos-mobile show up on the desktop's kitchen printer
// without the phone needing its own Bluetooth printer. Cancelled orders are
// excluded (nothing to cook); oldest first so tickets come out in the order
// they were actually placed.
exports.getUnprintedKitchenOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      ...buildShopScope(req),
      kitchenPrintedAt: null,
      status: { $ne: "cancelled" },
    }).sort({ createdAt: 1 });
    res.json(orders.map((order) => ({ ...order.toObject(), id: String(order._id) })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PATCH /api/orders/:id/claim-kitchen-print
// Atomically claims an order for printing - the `kitchenPrintedAt: null`
// filter means only ONE caller can ever win this update for a given order,
// even if two tills (or a till and a stale poll tick) race for the same
// order at the same instant. The desktop app always claims BEFORE printing,
// never after - if the claim fails (409, someone/something already got it),
// it silently skips rather than printing a duplicate ticket.
exports.claimKitchenPrint = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, kitchenPrintedAt: null, ...buildShopScope(req) },
      { kitchenPrintedAt: new Date() },
      { new: true }
    );

    if (!order) {
      return res.status(409).json({ error: "Already claimed or printed by another till.", reason: "already_claimed" });
    }

    res.json({ ...order.toObject(), id: String(order._id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/orders/receipts/unprinted
// Sibling to getUnprintedKitchenOrders above, for the customer-receipt side.
// Two kinds of orders are candidates here: (1) TakeAway orders, printed the
// moment they're placed (still pending) so the customer gets their receipt
// right away, and (2) ANY order (DineIn/Delivery/TakeAway) that just
// reached "completed" without a till already having claimed+printed it
// locally - this is what makes completing an order from the mobile app
// (which has no printer of its own) result in the same receipt printing on
// this till that completing it here directly would. SalesPage.tsx's own
// completion flow claims the receipt itself the instant it completes an
// order on this till, so a normal desktop completion never lingers here
// long enough to double-print.
exports.getUnprintedReceiptOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      ...buildShopScope(req),
      customerReceiptPrintedAt: null,
      status: { $ne: "cancelled" },
      $or: [{ orderType: "TakeAway" }, { status: "completed" }],
    }).sort({ createdAt: 1 });
    res.json(orders.map((order) => ({ ...order.toObject(), id: String(order._id) })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PATCH /api/orders/:id/claim-receipt-print
// Atomic claim, identical shape to claimKitchenPrint above - only one
// caller ever wins this for a given order, so the till that created a
// TakeAway order and the shop's background receipt-print watcher can never
// both print the customer's receipt.
exports.claimReceiptPrint = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, customerReceiptPrintedAt: null, ...buildShopScope(req) },
      { customerReceiptPrintedAt: new Date() },
      { new: true }
    );

    if (!order) {
      return res.status(409).json({ error: "Already claimed or printed by another till.", reason: "already_claimed" });
    }

    res.json({ ...order.toObject(), id: String(order._id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/orders/kitchen-updates/unprinted
// Sibling to getUnprintedKitchenOrders above, but for items added to (or
// increased in quantity on) an order that was ALREADY kitchen-printed once
// - kitchenPrintedAt is a one-shot flag for the order's original ticket, so
// it can never fire again for a later edit. pendingKitchenUpdate is the
// queue that makes those later edits reach the kitchen too, including ones
// made from pos-mobile (no printer of its own) via SalesPage.tsx's own
// edit flow (which claims+prints locally, see saveUpdate) or
// DashboardShell.tsx's KitchenUpdateWatcher (which catches everything
// else, same as ReceiptPrintWatcher does for customer receipts).
exports.getUnprintedKitchenUpdateOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      ...buildShopScope(req),
      pendingKitchenUpdate: { $ne: null },
      status: { $ne: "cancelled" },
    }).sort({ "pendingKitchenUpdate.queuedAt": 1 });
    res.json(orders.map((order) => ({ ...order.toObject(), id: String(order._id) })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PATCH /api/orders/:id/claim-kitchen-update-print
// Same claim-before-print invariant as claimKitchenPrint/claimReceiptPrint,
// but atomically CLEARS the queue instead of just stamping a timestamp
// (pendingKitchenUpdate can be set again by a later edit, unlike the
// one-shot kitchenPrintedAt) - `new: false` returns the document as it was
// BEFORE this update, which is what hands the caller the exact items it
// just claimed the right to print.
exports.claimKitchenUpdatePrint = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, pendingKitchenUpdate: { $ne: null }, ...buildShopScope(req) },
      { pendingKitchenUpdate: null },
      { new: false }
    );

    if (!order) {
      return res.status(409).json({ error: "Already claimed or printed by another till.", reason: "already_claimed" });
    }

    res.json({
      order: { ...order.toObject(), id: String(order._id) },
      items: order.pendingKitchenUpdate.items,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.checkPendingOrder = async (req, res) => {
  try {
    const exists = await Order.exists({ ...buildShopScope(req), "customer.phone": req.params.phone, status: "pending" });
    res.json({ exists: Boolean(exists) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Shared by the online PATCH /orders/:id handler below and the offline
// bulk replay path (exports.importOfflineOrderUpdates) - an edit queued
// while a till was offline (see pos-web/src/lib/offline-sync.ts) gets
// applied with EXACTLY this same logic once synced - the item/total
// recalculation, the completeAndSettle dues cascade, all of it - instead
// of a second copy of this logic that could quietly drift out of sync.
// Throws an Error with a `.status` (and optional `.reason`) attached for
// anything that should reject with a specific non-500 response (e.g.
// attempting to cancel through here); callers should catch that and use
// those fields instead of always falling back to a generic 500.
async function applyOrderPatch(order, patch, req) {
    // Items changing (addItems/replaceItems) or the discount itself
    // changing both require the subtotal/tax/total/remainingAmount to be
    // recomputed from scratch, rather than trusting whatever the client
    // sends for those - see recalculateTotals above.
    let itemsOrDiscountChanged = false;

    if (patch.action === "addItems" && Array.isArray(patch.items)) {
      // Every item in an addItems payload IS the delta by definition - the
      // whole point of this action is appending brand new lines.
      const delta = patch.items
        .map((item) => ({ name: item.name, price: item.price, variation: item.variation || "", quantity: Number(item.quantity) || 0 }))
        .filter((item) => item.quantity > 0);
      if (delta.length > 0) {
        order.pendingKitchenUpdate = { items: mergeKitchenDelta(order.pendingKitchenUpdate?.items, delta), queuedAt: new Date() };
      }
      order.items = [...order.items, ...patch.items];
      itemsOrDiscountChanged = true;
    }

    if (patch.action === "replaceItems" && Array.isArray(patch.items)) {
      const delta = computeKitchenIncreaseDelta(order.items, patch.items);
      if (delta.length > 0) {
        order.pendingKitchenUpdate = { items: mergeKitchenDelta(order.pendingKitchenUpdate?.items, delta), queuedAt: new Date() };
      }
      order.items = patch.items;
      itemsOrDiscountChanged = true;
    }

    if (patch.discount !== undefined) {
      order.discount = patch.discount;
      itemsOrDiscountChanged = true;
    }

    if (itemsOrDiscountChanged) {
      const totals = recalculateTotals(order.items, order.discount);
      order.subtotal = totals.subtotal;
      order.tax = totals.tax;
      order.total = totals.total;
      order.discount = buildDiscountRecord(order.discount, totals.discountAmount);
      order.remainingAmount = Math.max(order.total - (order.paidAmount || 0), 0);
    }

    // A customer can have more than one order open at once now (see
    // createOrder - the old "one pending order at a time" block was
    // removed), so completing one of their bills can also be the moment
    // that settles their other outstanding bill(s) at the same time,
    // instead of those older orders staying "pending" forever even though
    // the money for them was just collected together with this one. The
    // Sales page's Complete Payment panel sends the FULL amount actually
    // collected (this order's own total plus whatever of the customer's
    // other dues the cashier chose to also collect) as `paidAmount`, and
    // this distributes it oldest-debt-first: the older lump-sum
    // previousDues, then other pending/unpaid orders by creation date,
    // and only what's left over after that goes toward this order itself.
    if (patch.action === "completeAndSettle") {
      if (patch.customer) order.customer = patch.customer;
      const customerPhone = order.customer?.phone;
      let paidTotal = Math.max(Number(patch.paidAmount) || 0, 0);

      if (customerPhone && customerPhone !== "03000000000") {
        const customerDoc = await Customer.findOne({ phone: customerPhone, ...buildShopScope(req) });
        let previousDues = Number(customerDoc?.previousDues || 0);

        if (previousDues > 0 && paidTotal > 0) {
          const applied = Math.min(previousDues, paidTotal);
          previousDues -= applied;
          paidTotal -= applied;
        }

        if (paidTotal > 0) {
          const otherOrders = await Order.find({
            ...buildShopScope(req),
            "customer.phone": customerPhone,
            _id: { $ne: order._id },
            status: { $ne: "cancelled" },
          }).sort({ createdAt: 1 });

          for (const other of otherOrders) {
            if (paidTotal <= 0) break;
            const due = typeof other.remainingAmount === "number"
              ? other.remainingAmount
              : Math.max((other.total || 0) - (other.paidAmount || 0), 0);
            if (due <= 0) continue;

            const applied = Math.min(due, paidTotal);
            other.paidAmount = Number(other.paidAmount || 0) + applied;
            other.remainingAmount = Math.max(due - applied, 0);
            if (other.remainingAmount === 0) other.status = "completed";
            other.version = Number(other.version || 0) + 1;
            await other.save();
            paidTotal -= applied;
          }
        }

        if (customerDoc) {
          customerDoc.previousDues = previousDues;
          await customerDoc.save();
        }
      }

      const thisOrderDue = order.total;
      const appliedToThis = Math.min(thisOrderDue, paidTotal);
      order.paidAmount = appliedToThis;
      order.remainingAmount = Math.max(thisOrderDue - appliedToThis, 0);
      order.status = "completed";
      if (typeof patch.paymentMethod === "string") order.paymentMethod = patch.paymentMethod;
      if (typeof patch.note === "string") order.note = patch.note;
      order.version = Number(order.version || 0) + 1;
      await order.save();
      return order;
    }

    // "cancelled" is deliberately excluded here - cancelling an order is
    // only ever allowed through exports.cancelOrder below, which requires
    // the shop's Cancel Order Key. Without this check, this generic PATCH
    // would let anyone with a login cancel any order for free, which
    // defeats the whole point of gating cancellation behind the key. This
    // is also why offline Cancel was never implemented - the key is never
    // shipped to the till in the first place, so there's nothing for an
    // offline path to check it against.
    if (patch.status === "cancelled") {
      throw Object.assign(
        new Error("Cancelling an order requires the shop's Cancel Order Key. Use the Cancel Order action instead."),
        { status: 400, reason: "cancel_requires_key" }
      );
    }

    ["note", "waiter", "table", "address", "status", "paymentMethod"].forEach((field) => {
      if (patch[field] !== undefined) {
        order[field] = patch[field];
      }
    });

    if (patch.customer) order.customer = patch.customer;
    if (typeof patch.paidAmount === "number") order.paidAmount = patch.paidAmount;
    // Explicit remainingAmount from the caller (e.g. completeOrder in
    // SalesPage.tsx setting paidAmount + remainingAmount together) always
    // wins over whatever was just recalculated above.
    if (typeof patch.remainingAmount === "number") order.remainingAmount = patch.remainingAmount;
    order.version = Number(order.version || 0) + 1;

    await order.save();
    return order;
}

exports.updateOrder = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await Order.findOne({ _id: req.params.id, ...buildShopScope(req) });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const updated = await applyOrderPatch(order, req.body, req);
    res.json({ ...updated.toObject(), id: String(updated._id) });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message, reason: error.reason });
    }
    res.status(500).json({ error: error.message });
  }
};

// POST /api/orders/import-offline-updates
// body: { updates: [{ localEditId, orderId, payload }] }
// The edit-side counterpart to importOfflineOrders above - replays edits
// a till queued while offline (see backend/localHub/localOrders.js's edit
// queue + src/lib/offline-sync.ts) against already-synced cloud orders,
// through the exact same applyOrderPatch the online PATCH handler uses
// above, so a completeAndSettle made offline still gets the real dues
// cascade, item totals, etc. - no separate, easier-to-drift copy of that
// logic. Orders that were BOTH created and edited entirely offline never
// reach here: they have no real _id yet to target, so the till instead
// mutates its own not-yet-synced create record directly (see
// localOrders.js's updateQueuedOrder) and this only ever sees their
// already-final state, once, via importOfflineOrders.
exports.importOfflineOrderUpdates = async (req, res) => {
  try {
    const shopScopeQuery = buildShopScope(req);
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];

    // Oldest-queued-first - if the same order was edited more than once
    // offline before syncing (e.g. items added, then paid), replaying them
    // out of order could apply a later edit's totals before an earlier
    // one's item changes, silently producing the wrong final state.
    const ordered = [...updates].sort((a, b) => {
      const aTime = new Date(a?.offlineUpdatedAt || 0).getTime();
      const bTime = new Date(b?.offlineUpdatedAt || 0).getTime();
      return aTime - bTime;
    });

    const applied = [];
    const skipped = [];
    const failed = [];

    for (const entry of ordered) {
      const { localEditId, orderId, payload } = entry || {};
      try {
        if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
          skipped.push({ localEditId, reason: "invalid_order_id" });
          continue;
        }
        const order = await Order.findOne({ _id: orderId, ...shopScopeQuery });
        if (!order) {
          skipped.push({ localEditId, orderId, reason: "order_not_found" });
          continue;
        }
        await applyOrderPatch(order, payload || {}, req);
        applied.push({ localEditId, orderId });
      } catch (entryError) {
        console.error("Failed to import one offline order edit:", entryError);
        failed.push({ localEditId, orderId, error: entryError.message });
      }
    }

    res.json({ applied, skipped, failed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /api/orders/:id/cancel  body: { key, reason? }
// The only way an order's status can ever become "cancelled" (see the
// block in updateOrder above). `key` is checked against the shop's
// cancelOrderKeyHash (set by the Super Admin - see
// superAdminController.exports.createShop / resetCancelOrderKey) with
// bcrypt.compare, exactly like a login password check. Never hardcoded,
// never compared as plaintext, and scoped to this shop only.
exports.cancelOrder = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await Order.findOne({ _id: req.params.id, ...buildShopScope(req) });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (order.status === "cancelled") {
      return res.status(400).json({ error: "This order is already cancelled." });
    }

    const { key, reason } = req.body;
    if (!key) {
      return res.status(400).json({ error: "The shop's Cancel Order Key is required." });
    }

    const shop = await Shop.findById(req.user.shopId).select("cancelOrderKeyHash").lean();
    if (!shop || !shop.cancelOrderKeyHash) {
      return res.status(409).json({ error: "No Cancel Order Key has been set up for this shop yet. Ask your software provider (Super Admin) to set one." });
    }

    const matches = await bcrypt.compare(String(key), shop.cancelOrderKeyHash);
    if (!matches) {
      return res.status(401).json({ error: "Incorrect Cancel Order Key." });
    }

    const user = req.user?.id ? await User.findById(req.user.id).select("name username").lean() : null;

    order.status = "cancelled";
    order.cancelledAt = new Date();
    order.cancelledBy = user?.name || user?.username || "";
    order.cancelReason = reason || "No reason provided";
    order.version = Number(order.version || 0) + 1;
    await order.save();

    res.json({ ...order.toObject(), id: String(order._id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
