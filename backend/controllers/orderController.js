const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const Customer = require("../models/Customer");
const Order = require("../models/Order");
const ShopSession = require("../models/ShopSession");
const Shop = require("../models/Shop");
const User = require("../models/User");
const { shopScope } = require("../middleware/attachShopScope");
const { notifyRiderForDelivery, notifyAssignedRider } = require("../services/riderNotificationService");
const { notifyCustomerConfirmed, notifyCustomerCompleted } = require("../services/customerNotificationService");
const { deductStockForItems, restoreStockForOrder, restoreStockForItems } = require("../services/stockService");

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
// deliveryFee (Quick Delivery Charges preset - POSPage.tsx's Free/30/50/
// Custom row) is added back AFTER the discount, never discounted itself -
// a % discount off the food subtotal shouldn't also silently shave money
// off a flat delivery charge.
function recalculateTotals(items, discount, deliveryFee) {
  const subtotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  const tax = 0;
  const discountAmount = computeDiscountAmount(discount, subtotal);
  const deliveryFeeAmount = Math.max(Number(deliveryFee) || 0, 0);
  const total = Math.max(subtotal + tax - discountAmount, 0) + deliveryFeeAmount;
  return { subtotal, tax, total, discountAmount, deliveryFee: deliveryFeeAmount };
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

// Delivery Field Validation (Task: Strict Delivery Field Validation): the
// UI already forces this (POSPage.tsx's handleSaveOrder focuses the exact
// missing input before it ever calls the API), but a saved order is
// permanent and this same createOrder path is also hit directly by
// importOfflineOrders and the public/offline sync flows - so the name/
// phone/address requirement is re-checked here too rather than trusted
// from the client, same reasoning as recalculateTotals never trusting the
// client's own total. Only ever applies to orderType "Delivery" - DineIn/
// TakeAway keep these fields optional exactly as before.
function validateDeliveryFields(payload) {
  if (payload.orderType !== "Delivery") return null;
  const name = (payload.customer?.name || "").trim();
  const phone = (payload.customer?.phone || "").trim();
  const address = (payload.customer?.address || payload.address || "").trim();
  if (!name) return { field: "name", error: "Customer name is required for Delivery orders." };
  if (!phone) return { field: "phone", error: "Phone number is required for Delivery orders." };
  if (!address) return { field: "address", error: "Delivery address is required for Delivery orders." };
  return null;
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

// The stock-refund counterpart to computeKitchenIncreaseDelta above: what
// an order edit (addItems/replaceItems) reduced, per name+variation - a
// line's quantity going down, or a line disappearing from the new item
// list entirely (its new quantity is implicitly 0, same as
// sumQuantitiesByKey/newQuantities.get returning undefined -> 0 for it).
// Kept as its own small function, mirroring computeKitchenIncreaseDelta's
// own shape/meta-lookup exactly, rather than folding both directions into
// one function - the two are used for genuinely different purposes
// (kitchen ticket vs stock ledger) at different points in applyOrderPatch,
// and keeping them separate keeps each one's job obvious at a glance. Note
// the meta lookup here has to fall back to the item's OWN name/variation
// when a key exists only in oldItems (e.g. a line removed entirely, so it
// never appears in newItems' meta map) - handled by also indexing oldItems
// into the same meta map before reading back out of it.
function computeQuantityDecreaseDelta(oldItems, newItems) {
  const oldQuantities = sumQuantitiesByKey(oldItems);
  const newQuantities = sumQuantitiesByKey(newItems);
  const meta = new Map();
  (oldItems || []).forEach((item) => {
    const key = kitchenItemKey(item);
    if (!meta.has(key)) meta.set(key, { name: item.name, price: item.price, variation: item.variation || "" });
  });
  (newItems || []).forEach((item) => {
    const key = kitchenItemKey(item);
    if (!meta.has(key)) meta.set(key, { name: item.name, price: item.price, variation: item.variation || "" });
  });

  const delta = [];
  oldQuantities.forEach((oldQty, key) => {
    const newQty = newQuantities.get(key) || 0;
    const diff = oldQty - newQty;
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

// Order-edit stock sync (see stockService.js's resolveIngredientQuantities/
// restoreStockForItems for the full reasoning): keeps order.stockDeductions
// an accurate LIVE snapshot of what THIS order currently has actually
// deducted from ingredient stock, so that a later full cancellation
// (cancelOrderCore -> restoreStockForOrder, which blindly adds every
// stockDeductions entry back) always restores exactly the right remaining
// amount - never double-restoring quantity an earlier edit already handed
// back, and never under-restoring quantity an earlier edit added.
// mergeKitchenDelta above solves the identical "fold new entries into an
// existing list, summing by key" problem for the kitchen ticket - these
// two mirror that, just keyed by ingredientId (string) and floored
// differently for the add/subtract directions.
function mergeStockDeductionsAdd(existingDeductions, additions) {
  const map = new Map();
  (existingDeductions || []).forEach((entry) => {
    map.set(String(entry.ingredientId), { ingredientId: entry.ingredientId, quantity: Number(entry.quantity) || 0 });
  });
  (additions || []).forEach((entry) => {
    const key = String(entry.ingredientId);
    const existing = map.get(key);
    if (existing) {
      existing.quantity += entry.quantity;
    } else {
      map.set(key, { ingredientId: entry.ingredientId, quantity: entry.quantity });
    }
  });
  return Array.from(map.values());
}

// Subtracts each restored quantity from the matching stockDeductions entry,
// floored at 0 - an edit can never claim to have "un-deducted" more than
// this order originally took, even if a rounding/unit-drift quirk in the
// resolver produced a slightly different number on the way back out.
// Entries that land at (or start at) 0 are dropped entirely, not kept as
// zero-quantity rows, so a later cancel/restore pass never iterates a
// no-op entry.
function mergeStockDeductionsSubtract(existingDeductions, restorations) {
  const map = new Map();
  (existingDeductions || []).forEach((entry) => {
    map.set(String(entry.ingredientId), { ingredientId: entry.ingredientId, quantity: Number(entry.quantity) || 0 });
  });
  (restorations || []).forEach((entry) => {
    const key = String(entry.ingredientId);
    const existing = map.get(key);
    if (existing) {
      existing.quantity = Math.max(existing.quantity - entry.quantity, 0);
    }
  });
  return Array.from(map.values()).filter((entry) => entry.quantity > 0);
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

// Same expiry math as src/lib/table-timer.ts's isTableTimerExpired, kept in
// sync manually since this is the one place it also needs to run
// server-side (see the two occupancy checks below). There is no more
// staff-facing "Clear Table" decision anywhere in the app - a table's
// turnover window (plus any past extension) elapsing is now, by itself,
// enough to treat the table as free, checked live at the exact moment
// something needs to know.
function isOccupyingOrderExpired(order, turnoverMinutes) {
  const effectiveMinutes = Number(turnoverMinutes || 45) + Number(order.timerExtendedMinutes || 0);
  const elapsedMs = Date.now() - new Date(order.createdAt).getTime();
  return elapsedMs >= effectiveMinutes * 60 * 1000;
}

// Shared by both occupancy checks below: given an order that's blocking a
// table, decide whether its turnover window has actually elapsed and, if
// so, auto-clear it right here (persisting tableTimerCleared=true) instead
// of blocking the new order/table-move. Returns true if the table is now
// free to use.
async function autoFreeExpiredTable(occupyingOrder, req) {
  const shop = await Shop.findById(req.user.shopId).select("tableTurnoverMinutes").lean();
  const turnoverMinutes = shop?.tableTurnoverMinutes ?? 45;
  if (!isOccupyingOrderExpired(occupyingOrder, turnoverMinutes)) return false;
  await Order.updateOne({ _id: occupyingOrder._id }, { $set: { tableTimerCleared: true } });
  return true;
}

exports.getOrders = async (req, res) => {
  try {
    const query = buildShopScope(req);
    // Optional status filter, most importantly `status=pending` combined
    // with NO date/since - a still-pending order (an unpaid DineIn table,
    // a Delivery that never got closed out) needs to stay findable no
    // matter how old it is, same reasoning as getOccupiedDineInTables
    // below: the result is bounded by how many orders are actually still
    // open at once (small), not by the shop's total order history, so
    // leaving it unbounded here is safe. Callers that also want a to
    // date/since bound (e.g. "completed orders from the last 14 days")
    // can still combine both params.
    if (req.query.status) {
      query.status = req.query.status;
    }
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
    // Used by the Dine-In table availability timer (POSPage.tsx polls
    // GET /api/orders?status=pending&orderType=DineIn to know which tables
    // currently have an open order and when each one was placed).
    if (req.query.orderType) query.orderType = req.query.orderType;

    // .lean() skips hydrating every result into a full Mongoose Document
    // (getters/setters/virtuals, change-tracking machinery) - for a list
    // endpoint like this that's read-only and just gets serialized straight
    // back out as JSON, that hydration is pure overhead, and it was the
    // second half (alongside requireLicenseValid's own DB round trips - see
    // that middleware's own comment) of what was pushing this past the
    // frontend's 8-second timeout for busier shops: this route is called
    // unbounded (no since/date/status filter at all) by RecordPage.tsx's
    // initial load, so "busier shop" here can mean this shop's ENTIRE
    // lifetime order history, not just the 14-day window Dashboard/Sales/
    // Kitchen bound themselves to. .lean() gives back plain JS objects
    // directly - same fields, same shape, just without the per-document
    // .toObject() call this used to need (and without n .toObject() calls'
    // own overhead, which was doing the exact same hydration work a second
    // time on top of what .find() had already done).
    //
    // ?summary=true - debug timing on a real shop with ~1,000 orders in its
    // 14-day window showed the bottleneck isn't Node-side hydration (that
    // was already fixed above) but raw data volume: fetching every full
    // order document (complete items array, full customer object, etc.) x
    // ~1000, every 45 seconds for Dashboard's own poll, over a slow link to
    // Atlas. DashboardPageClient.tsx only ever reads status/total/
    // createdAt/customer.phone/waiter from each order for its stats and
    // chart - so when this flag is set, project down to just those fields
    // instead of transferring everything. Sales/Kitchen/Record still call
    // this same route with no flag and get full documents, unchanged - this
    // is additive, not a behavior change for any existing caller.
    //
    // ?list=true - SalesPage/RecordPage's card-list views need almost every
    // top-level field (status, totals, customer, table, waiter, discount,
    // print-claim flags, etc.) to render the list and re-derive things like
    // "this shift's orders" client-side - unlike summary=true above, they
    // can't drop down to 5 fields. What they DON'T need until the cashier
    // actually opens one specific order is that order's full `items` array,
    // which - same data-volume finding as summary=true's comment above - is
    // most of each document's bytes on the wire once a shop has real order
    // history. This mode keeps every field except items, replacing it with
    // a cheap itemCount (still computed server-side via $size so the list
    // card can show "3 items" without ever transferring the items
    // themselves). The frontend is responsible for re-fetching a single
    // order's full detail (GET /api/orders/:id, unaffected by collection
    // size) before it lets the cashier act on it - see SalesPage.tsx's
    // selectOrder/refreshOne and the itemCount-gated "still loading" state
    // on its action buttons, which exist specifically so a save can never
    // go out with a stale/empty items array.
    if (req.query.list === "true") {
      const matchQuery = { ...query };
      // Aggregation's $match does NOT get Mongoose's usual auto-casting -
      // shopId comes from the JWT as a plain string (see tokenService.js),
      // but the schema field is an ObjectId, so left uncast this would
      // silently match zero documents instead of erroring loudly. .find()
      // above never had this problem because Mongoose casts query values
      // against the schema for you there; aggregate() does not.
      if (matchQuery.shopId) {
        matchQuery.shopId = new mongoose.Types.ObjectId(String(matchQuery.shopId));
      }
      const orders = await Order.aggregate([
        { $match: matchQuery },
        { $sort: { createdAt: -1 } },
        {
          $project: {
            shopId: 1,
            userId: 1,
            clientSyncId: 1,
            dailyOrderNumber: 1,
            shopSequenceNumber: 1,
            subtotal: 1,
            tax: 1,
            total: 1,
            orderType: 1,
            customer: 1,
            address: 1,
            note: 1,
            waiter: 1,
            table: 1,
            status: 1,
            paymentMethod: 1,
            paidAmount: 1,
            remainingAmount: 1,
            cancelledAt: 1,
            cancelledBy: 1,
            cancelReason: 1,
            discount: 1,
            version: 1,
            kitchenPrintedAt: 1,
            customerReceiptPrintedAt: 1,
            pendingKitchenUpdate: 1,
            createdOffline: 1,
            offlineOrderNumber: 1,
            offlineCreatedAt: 1,
            createdAt: 1,
            updatedAt: 1,
            // The whole customer-qr/online-ordering feature set - source is
            // what SalesPage.tsx checks to even show OnlineOrderControls at
            // all (the "Online - Waiting Acceptance" badge, the accept/
            // decline buttons, the rider picker, the change-request
            // approval UI). Missing here meant every one of those silently
            // vanished from a card the moment this shop's 45-second lean
            // poll (see SalesPage.tsx's refresh(true)) replaced the `orders`
            // array with this projection - self-healing only for whichever
            // ONE order happened to be currently selected (selectOrder's
            // background refreshOne re-hydrates it), never for the rest of
            // the grid. This is the actual root cause of "assign rider
            // option was not showing" - it was never actually broken, the
            // data just weren't in the list response at all.
            source: 1,
            trackingStatus: 1,
            paymentStatus: 1,
            deliveryLocation: 1,
            assignedRider: 1,
            customerChangeRequest: 1,
            itemCount: { $size: { $ifNull: ["$items", []] } },
          },
        },
      ]);
      const result = orders.map((order) => ({ ...order, id: String(order._id), items: [] }));
      return res.json(result);
    }

    const projection = req.query.summary === "true"
      ? "status total createdAt customer.phone waiter"
      : null;

    let ordersQuery = Order.find(query).sort({ createdAt: -1 });
    if (projection) ordersQuery = ordersQuery.select(projection);
    const orders = await ordersQuery.lean();
    const result = orders.map((order) => ({ ...order, id: String(order._id) }));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getOrder = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = await Order.findOne({ _id: req.params.id, ...buildShopScope(req) }).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json({ ...order, id: String(order._id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createOrder = async (req, res) => {
  try {
    // The shop must be explicitly "opened" (see shopSessionController) for
    // new orders to be rung up at all - enforced here, not just hidden in
    // the UI, so a stale POS tab or a direct API call can't slip an order
    // in while the shop is marked closed.
    const payload = req.body;

    // The desktop till's own Local Hub is the one true source of order
    // numbering for that till, online or offline (see
    // backend/localHub/localOrders.js) - POSPage.tsx reserves a number from
    // it BEFORE ever calling here, even when placing an order straight
    // online, specifically so a shop's numbering never depends on whether
    // this particular request happened to go through while connected. When
    // present, requestedDailyOrderNumber is honored via $max (mirroring
    // importOfflineOrders' same reasoning) instead of the old blind $inc -
    // this can never burn an unused number the way $inc would, and the
    // collision check below means it can never step on a number some
    // other order in this session already has. Only a request with no
    // Local Hub behind it at all (a plain browser tab, or pos-mobile
    // placing its own order directly) falls back to the original
    // findOneAndUpdate + $inc allocation - still a single atomic Mongo
    // operation, so two such requests at the exact same instant still can
    // never read/get the same number the way a separate
    // "countDocuments() then +1" step could.
    const requestedNumber = Number(payload.requestedDailyOrderNumber) || 0;
    let openSession;
    let dailyOrderNumber;

    if (requestedNumber > 0) {
      const openSessionBefore = await ShopSession.findOne(
        { ...buildShopScope(req), status: "open" }
      ).sort({ openedAt: 1 }).lean();
      if (!openSessionBefore) {
        return res.status(409).json({ error: "The shop is closed. Open the shop before taking new orders.", reason: "shop_closed" });
      }
      const collision = await Order.findOne({
        ...buildShopScope(req),
        dailyOrderNumber: requestedNumber,
        createdAt: { $gte: openSessionBefore.openedAt },
      }).lean();
      if (!collision) {
        openSession = await ShopSession.findOneAndUpdate(
          { _id: openSessionBefore._id },
          { $max: { orderCounter: requestedNumber } },
          { new: true }
        );
        dailyOrderNumber = requestedNumber;
      }
    }

    if (dailyOrderNumber === undefined) {
      // Defense-in-depth: ShopSession now has a partial unique index that
      // makes more than one "open" session per shop impossible going
      // forward (see models/ShopSession.js), but this `sort` guarantees
      // that if any legacy duplicate ever slips through some other way,
      // the oldest (the one actually carrying the real running count)
      // always wins rather than a non-deterministic match landing on a
      // fresher duplicate whose orderCounter defaults to 0.
      openSession = await ShopSession.findOneAndUpdate(
        { ...buildShopScope(req), status: "open" },
        { $inc: { orderCounter: 1 } },
        { new: true, sort: { openedAt: 1 } }
      );
      if (!openSession) {
        return res.status(409).json({ error: "The shop is closed. Open the shop before taking new orders.", reason: "shop_closed" });
      }
      dailyOrderNumber = openSession.orderCounter;
    }

    // Tr# (see models/Order.js's shopSequenceNumber) - a completely
    // separate, never-resetting counter from dailyOrderNumber above. Same
    // requested-number-first-else-$inc pattern and the same reason: the
    // till's Local Hub reserves this number before ever getting here too
    // (see POSPage.tsx), so a number it already printed offline must
    // become permanent rather than silently reassigned. The collision
    // check is shop-wide (no session/date bound), matching the fact that
    // this counter itself never resets.
    const requestedSequenceNumber = Number(payload.requestedShopSequenceNumber) || 0;
    let shopSequenceNumber;

    if (requestedSequenceNumber > 0) {
      const sequenceCollision = await Order.findOne({
        ...buildShopScope(req),
        shopSequenceNumber: requestedSequenceNumber,
      }).lean();
      if (!sequenceCollision) {
        await Shop.findOneAndUpdate(
          { _id: req.user.shopId },
          { $max: { orderSequenceCounter: requestedSequenceNumber } }
        );
        shopSequenceNumber = requestedSequenceNumber;
      }
    }

    if (shopSequenceNumber === undefined) {
      const updatedShop = await Shop.findOneAndUpdate(
        { _id: req.user.shopId },
        { $inc: { orderSequenceCounter: 1 } },
        { new: true }
      );
      shopSequenceNumber = updatedShop ? updatedShop.orderSequenceCounter : 1;
    }

    // Idempotency guard: the desktop till races this call against a short
    // timeout and falls back to queuing the order in its offline Local Hub
    // if it doesn't hear back in time (see POSPage.tsx's handleSaveOrder) -
    // meaning this exact request can still be sitting here, about to
    // finish, at the same moment the Local Hub's own copy of the same
    // order (same clientSyncId) gets synced up separately via
    // importOfflineOrders below. Whichever one actually lands first wins;
    // this makes the other one a no-op instead of a duplicate order - the
    // orderCounter increment above is a small, accepted gap in that case,
    // the same trade-off already made for a plain dropped request.
    const requestClientSyncId = payload.clientSyncId || payload.orderId || "";
    if (requestClientSyncId) {
      const existing = await Order.findOne({ clientSyncId: requestClientSyncId, ...buildShopScope(req) }).lean();
      if (existing) {
        return res.json({ ...existing, id: String(existing._id) });
      }
    }

    // Technical Requirement #1: a table with an active, un-expired order
    // must stay un-selectable for a new order - enforced here too (not just
    // hidden in POSPage.tsx's table grid) so a stale tab or a direct API
    // call can't double-book a table. "Active" means a pending DineIn order
    // placed on the same table within the shop's tableTurnoverMinutes
    // window (Requirement #4: once that window elapses the table re-opens
    // automatically even if the earlier order still hasn't been paid, so
    // this check must use the same time-based definition, not just
    // "status === pending"). No staff decision involved any more - once
    // that window has genuinely elapsed, autoFreeExpiredTable clears it
    // right here, in this same request, instead of blocking the new order.
    if (payload.orderType === "DineIn" && payload.table) {
      const occupyingOrder = await Order.findOne({
        ...buildShopScope(req),
        orderType: "DineIn",
        table: payload.table,
        status: "pending",
        tableTimerCleared: { $ne: true },
      });

      if (occupyingOrder && !(await autoFreeExpiredTable(occupyingOrder, req))) {
        return res.status(409).json({
          error: `Table ${payload.table} already has an active order. Complete or pay it to free up this table.`,
          reason: "table_occupied",
        });
      }
    }

    const deliveryFieldError = validateDeliveryFields(payload);
    if (deliveryFieldError) {
      return res.status(400).json({ error: deliveryFieldError.error, reason: "delivery_field_required", field: deliveryFieldError.field });
    }

    const totals = recalculateTotals(payload.items || [], payload.discount, payload.deliveryFee);

    // Task 3 (Recipe/Stock Management): deduct raw-ingredient stock the
    // moment this order is placed - that's when the kitchen actually starts
    // cooking it, same moment the kitchen ticket itself fires. Computed
    // BEFORE Order.create so the exact amounts taken off the shelf can be
    // saved directly onto the new order's own stockDeductions field -
    // that's what a later cancellation reverses (see cancelOrderCore).
    // Never blocks the sale - see deductStockForItems' own comment.
    const stockResult = await deductStockForItems(payload.items || [], req.user.shopId);

    const order = await Order.create({
      ...payload,
      ...buildShopScope(req),
      userId: req.user?.id ? String(req.user.id) : payload.userId,
      subtotal: totals.subtotal,
      tax: totals.tax,
      total: totals.total,
      deliveryFee: totals.deliveryFee,
      discount: buildDiscountRecord(payload.discount, totals.discountAmount),
      dailyOrderNumber,
      shopSequenceNumber,
      clientSyncId: payload.clientSyncId || payload.orderId || "",
      paidAmount: payload.paidAmount || 0,
      remainingAmount: typeof payload.remainingAmount === "number" ? payload.remainingAmount : totals.total,
      stockDeductions: stockResult.deductions,
      costPrice: stockResult.costPrice,
      grossProfit: Math.round((totals.total - stockResult.costPrice) * 100) / 100,
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

      // Khata (Customer Dues ledger) should only ever exist for a
      // customer who actually has/had credit with the shop - a cash
      // customer who pays in full shouldn't get a khata profile just
      // because they gave a phone number. `order.remainingAmount` (set
      // just above from Order.create) is the source of truth for "does
      // this order leave a due" - > 0 means a real credit component.
      //
      // So: a customer who ALREADY exists (from a past credit purchase,
      // or a previous order that left a due) still gets their contact
      // info refreshed on every order, cash or credit alike, since they
      // already have a khata and their name/address may have changed. A
      // customer who does NOT exist yet only gets a brand-new Customer
      // document created when THIS order actually leaves a due - a
      // fully-paid cash sale from a brand-new phone number leaves no
      // Customer record at all (receipts/WhatsApp/delivery all read off
      // Order.customer directly, never Customer, so nothing else here
      // needs one to exist).
      //
      // Best-effort contact-info sync either way - never allowed to fail
      // the order itself, which is already safely saved above by this
      // point. Two orders for a phone number that has never placed an
      // order before, submitted within the same instant, can both pass
      // the "not found" check below and then race on the actual insert -
      // MongoDB's unique index on `phone` then rejects the loser with an
      // E11000 duplicate-key error. Retry as a plain update in that case,
      // since the document now certainly exists.
      try {
        const existingCustomer = await Customer.findOne({ phone: payload.customer.phone, ...buildShopScope(req) });
        if (existingCustomer) {
          await Customer.findOneAndUpdate(
            { phone: payload.customer.phone, ...buildShopScope(req) },
            customerUpdate
          );
        } else if (order.remainingAmount > 0) {
          try {
            await Customer.create({ ...customerUpdate, ...buildShopScope(req) });
          } catch (customerError) {
            if (customerError?.code === 11000) {
              // Lost the create race to a concurrent order for the same
              // new phone number - the document exists now, just update it.
              await Customer.findOneAndUpdate(
                { phone: payload.customer.phone, ...buildShopScope(req) },
                customerUpdate
              );
            } else {
              throw customerError;
            }
          }
        }
        // else: brand-new phone, fully paid order - no khata needed, no
        // Customer document created.
      } catch (customerError) {
        console.error("Non-fatal: failed to sync customer contact info during createOrder", customerError);
        customerSyncWarning = "The order was saved, but this customer's info could not be saved to Customers/Ledger. Ask your admin to check the backend logs.";
      }
    }

    res.status(201).json({ ...order.toObject(), id: String(order._id), customerSyncWarning, stockWarning: stockResult.warning });
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
          const existing = await Order.findOne({ clientSyncId, ...buildShopScope(req) }).lean();
          if (existing) {
            skipped.push({ localOrderId: entry.localOrderId, orderId: String(existing._id), dailyOrderNumber: existing.dailyOrderNumber });
            continue;
          }
        }

        // The shop must still be "open" right now for these to import; if
        // it's been closed since the offline orders were queued, importing
        // stops and reports what's left as failed so a human can decide
        // (re-open the shop, or handle these manually) rather than
        // silently dropping them. Read-only lookup first (not the atomic
        // update itself) because the number-preservation logic just below
        // needs openedAt before deciding how to allocate dailyOrderNumber.
        const openSessionBefore = await ShopSession.findOne(
          { ...buildShopScope(req), status: "open" }
        ).sort({ openedAt: 1 }).lean();
        if (!openSessionBefore) {
          failed.push({ localOrderId: entry.localOrderId, error: "Shop is closed - open the shop to import queued offline orders." });
          continue;
        }

        // Whoever placed this order offline already saw (and, for a
        // kitchen ticket, already printed and handed to staff) a real
        // ticket number the instant it was queued - see
        // backend/localHub/localOrders.js's nextLocalOrderNumber. That
        // number must become this order's permanent dailyOrderNumber
        // whenever it safely can, instead of the cloud silently handing
        // out a DIFFERENT number here (e.g. a printed "Order #25" ticket
        // that the system then shows as "Order #5" forever after sync -
        // confusing at best, and actively wrong if that ticket already
        // went to the kitchen or the customer). $max only ever moves the
        // counter forward, never backward, so honoring it can never make
        // a later order (online or another offline import in this same
        // batch) collide with it.
        //
        // The one case this can't be trusted: the requested number is
        // already used by a real order from THIS session (some other,
        // unrelated bug, or a very old queued order predating this
        // logic) - fall back to the old behavior (a fresh sequential
        // number) rather than ever create two orders sharing one ticket
        // number.
        const requestedNumber = Number(entry.localOrderNumber) || 0;
        let dailyOrderNumber;
        let openSession;

        if (requestedNumber > 0) {
          const collision = await Order.findOne({
            ...buildShopScope(req),
            dailyOrderNumber: requestedNumber,
            createdAt: { $gte: openSessionBefore.openedAt },
          }).lean();
          if (!collision) {
            openSession = await ShopSession.findOneAndUpdate(
              { _id: openSessionBefore._id },
              { $max: { orderCounter: requestedNumber } },
              { new: true }
            );
            dailyOrderNumber = requestedNumber;
          }
        }

        if (dailyOrderNumber === undefined) {
          // Same atomic-counter allocation createOrder uses - see its
          // comment above for why this has to be a single $inc, not a
          // separate read-then-write.
          openSession = await ShopSession.findOneAndUpdate(
            { _id: openSessionBefore._id },
            { $inc: { orderCounter: 1 } },
            { new: true }
          );
          dailyOrderNumber = openSession.orderCounter;
        }

        // Tr# (see createOrder's own comment above and models/Order.js's
        // shopSequenceNumber) - same requested-first-else-$inc pattern,
        // honoring the number the till already reserved and potentially
        // printed offline via entry.localSequenceNumber. Shop-wide
        // collision check since this counter never resets per session.
        const requestedSequenceNumber = Number(entry.localSequenceNumber) || 0;
        let shopSequenceNumber;

        if (requestedSequenceNumber > 0) {
          const sequenceCollision = await Order.findOne({
            ...buildShopScope(req),
            shopSequenceNumber: requestedSequenceNumber,
          }).lean();
          if (!sequenceCollision) {
            await Shop.findOneAndUpdate(
              { _id: req.user.shopId },
              { $max: { orderSequenceCounter: requestedSequenceNumber } }
            );
            shopSequenceNumber = requestedSequenceNumber;
          }
        }

        if (shopSequenceNumber === undefined) {
          const updatedShop = await Shop.findOneAndUpdate(
            { _id: req.user.shopId },
            { $inc: { orderSequenceCounter: 1 } },
            { new: true }
          );
          shopSequenceNumber = updatedShop ? updatedShop.orderSequenceCounter : 1;
        }

        // Conflict resolution: two offline nodes (a second till, or a till
        // and a paired phone with its own separate outage) can each place a
        // brand-new DineIn order for the same table while both are
        // unaware of the other - the online createOrder path already
        // rejects this live (see its own "Technical Requirement #1"
        // comment above), but until now importOfflineOrders had NO
        // equivalent check at all, so both orders silently landed in the
        // cloud, double-booking the table. Same rule here: re-checked
        // against the DB fresh for EVERY entry in this loop (not just
        // once for the whole batch), so if an earlier entry in this same
        // batch just occupied this table, a later conflicting entry still
        // gets caught. Recommended-and-chosen resolution is "reject +
        // flag for staff" (not last-write-wins) - the loser stays queued
        // in the Local Hub as a `failed` entry (reason: 'table_conflict')
        // rather than being silently created or discarded; staff can
        // still edit its table via the normal offline "Change Table"
        // action (it's still only a local-<uuid> record, not yet
        // created here) and it'll import cleanly on the next sync tick.
        if (payload.orderType === "DineIn" && payload.table) {
          const occupyingOrder = await Order.findOne({
            ...buildShopScope(req),
            orderType: "DineIn",
            table: payload.table,
            status: "pending",
            tableTimerCleared: { $ne: true },
          });

          if (occupyingOrder && !(await autoFreeExpiredTable(occupyingOrder, req))) {
            failed.push({
              localOrderId: entry.localOrderId,
              error: `Table ${payload.table} already has an active order from another device. Change this order's table and it will sync automatically.`,
              reason: "table_conflict",
            });
            continue;
          }
        }

        const deliveryFieldError = validateDeliveryFields(payload);
        if (deliveryFieldError) {
          failed.push({
            localOrderId: entry.localOrderId,
            error: deliveryFieldError.error,
            reason: "delivery_field_required",
            field: deliveryFieldError.field,
          });
          continue;
        }

        const totals = recalculateTotals(payload.items || [], payload.discount, payload.deliveryFee);

        // Same real-time deduction as the online createOrder path above -
        // an offline order was already cooked/served on the till in the
        // moment, so its ingredients must come off the shelf now, at import
        // time, exactly as if it had been placed online to begin with.
        const stockResult = await deductStockForItems(payload.items || [], req.user.shopId);
        if (stockResult.warning) {
          console.warn(`Stock shortage importing offline order ${entry.localOrderId}:`, stockResult.warning);
        }

        const order = await Order.create({
          ...payload,
          ...buildShopScope(req),
          userId: payload.userId || (req.user?.id ? String(req.user.id) : ""),
          subtotal: totals.subtotal,
          tax: totals.tax,
          total: totals.total,
          deliveryFee: totals.deliveryFee,
          discount: buildDiscountRecord(payload.discount, totals.discountAmount),
          dailyOrderNumber,
          shopSequenceNumber,
          clientSyncId,
          paidAmount: payload.paidAmount || 0,
          remainingAmount: typeof payload.remainingAmount === "number" ? payload.remainingAmount : totals.total,
          stockDeductions: stockResult.deductions,
          costPrice: stockResult.costPrice,
          grossProfit: Math.round((totals.total - stockResult.costPrice) * 100) / 100,
          createdOffline: true,
          offlineOrderNumber: entry.localOrderNumber || null,
          offlineCreatedAt: entry.offlineCreatedAt ? new Date(entry.offlineCreatedAt) : null,
          // The till already attempted these prints the instant the order
          // was queued offline (see localOrders.js's queueOrder / POSPage.tsx
          // - no cloud record existed yet to claim first, since nothing else
          // could possibly be racing to print it while it only lived here).
          // Marking them printed now, at creation, is what stops
          // DashboardShell.tsx's background KitchenPrintWatcher/
          // ReceiptPrintWatcher from printing this same order again the
          // moment it shows up in their "unprinted" query for the first
          // time. Left null (the default) when no printer was configured
          // on this till, exactly like a real print never having happened -
          // some OTHER till (or this one, once configured) can still catch
          // and print it later.
          kitchenPrintedAt: entry.kitchenPrinted ? new Date() : null,
          customerReceiptPrintedAt: entry.receiptPrinted ? new Date() : null,
        });

        if (payload.customer?.phone && payload.customer.phone !== "03000000000") {
          // Same "only create a khata for a customer who actually has a
          // due" rule as the online createOrder path above - see that
          // block's own comment for the full reasoning. Kept consistent
          // between the two so a cash sale never gets a Customer record
          // regardless of which path (online vs. offline-then-synced) it
          // came in through.
          const customerUpdate = {
            name: payload.customer.name,
            phone: payload.customer.phone,
            address: payload.customer.address || payload.address || "",
            shopId: req.user.shopId,
          };
          try {
            const existingCustomer = await Customer.findOne({ phone: payload.customer.phone, ...buildShopScope(req) });
            if (existingCustomer) {
              await Customer.findOneAndUpdate(
                { phone: payload.customer.phone, ...buildShopScope(req) },
                customerUpdate
              );
            } else if (order.remainingAmount > 0) {
              try {
                await Customer.create({ ...customerUpdate, ...buildShopScope(req) });
              } catch (customerError) {
                if (customerError?.code === 11000) {
                  await Customer.findOneAndUpdate(
                    { phone: payload.customer.phone, ...buildShopScope(req) },
                    customerUpdate
                  );
                } else {
                  throw customerError;
                }
              }
            }
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
    // .lean() + no per-document .toObject() below - this is read-only
    // (nothing here ever mutates/saves what it fetches), and it's polled
    // by every till's Kitchen page every 10 seconds all day, so the double
    // hydration (.find() building real Documents, then .toObject() on each
    // one converting them right back to plain objects) that was already
    // found and fixed on getOrders was quietly happening here too, just
    // more often. Same fix, same reasoning - see getOrders' own comment.
    const orders = await Order.find({
      ...buildShopScope(req),
      kitchenPrintedAt: null,
      status: { $ne: "cancelled" },
      // A customer-qr order shouldn't hit the kitchen printer the instant
      // it's placed - staff (or a verified online-payment webhook, see
      // publicOrderController.js's jazzCashCallback/easyPaisaCallback)
      // still has to accept it first (trackingStatus leaving
      // "awaiting_confirmation" - see updateTrackingStatus). A staff-
      // placed order is unaffected: trackingStatus defaults to
      // "awaiting_confirmation" for those too (it's simply never used for
      // anything on a staff order - see Order.js's own comment), so this
      // has to key off `source`, not trackingStatus alone, or every normal
      // till order would stop printing.
      $or: [{ source: { $ne: "customer-qr" } }, { trackingStatus: { $ne: "awaiting_confirmation" } }],
    }).sort({ createdAt: 1 }).lean();
    res.json(orders.map((order) => ({ ...order, id: String(order._id) })));
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
// TakeAway only, and only once "completed" - the customer is right there
// collecting their order at that point, so auto-printing makes sense; a
// completed DineIn/Delivery order never auto-prints its receipt, here or
// anywhere else (see SalesPage.tsx/RecordPage.tsx's completion flows) -
// it's available on demand only, via the printer icon on the order detail
// card. This is what makes completing a TakeAway order from the mobile app
// (which has no printer of its own) result in the same receipt printing on
// this till that completing it here directly would. SalesPage.tsx's own
// completion flow claims the receipt itself the instant it completes a
// TakeAway order on this till, so a normal desktop completion never
// lingers here long enough to double-print.
exports.getUnprintedReceiptOrders = async (req, res) => {
  try {
    // Same .lean() fix as getUnprintedKitchenOrders above, same reasoning
    // - this is also a background poll, read-only, never mutates what it
    // fetches.
    const orders = await Order.find({
      ...buildShopScope(req),
      customerReceiptPrintedAt: null,
      status: "completed",
      orderType: "TakeAway",
    }).sort({ createdAt: 1 }).lean();
    res.json(orders.map((order) => ({ ...order, id: String(order._id) })));
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
    // Same .lean() fix as getUnprintedKitchenOrders above, same reasoning
    // - this is also a background poll, read-only, never mutates what it
    // fetches.
    const orders = await Order.find({
      ...buildShopScope(req),
      pendingKitchenUpdate: { $ne: null },
      status: { $ne: "cancelled" },
    }).sort({ "pendingKitchenUpdate.queuedAt": 1 }).lean();
    res.json(orders.map((order) => ({ ...order, id: String(order._id) })));
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
async function applyOrderPatch(order, patch, req, options) {
    // Items changing (addItems/replaceItems) or the discount itself
    // changing both require the subtotal/tax/total/remainingAmount to be
    // recomputed from scratch, rather than trusting whatever the client
    // sends for those - see recalculateTotals above.
    let itemsOrDiscountChanged = false;

    // Set by importOfflineOrderUpdates when the till already printed this
    // exact delta to the kitchen itself, offline, the instant the edit was
    // made (see SalesPage.tsx's saveUpdate) - there's no cloud record to
    // claim/queue against yet at that moment, same reasoning as an offline
    // order's original ticket (orderController.js's importOfflineOrders).
    // Skipping pendingKitchenUpdate here is what stops
    // DashboardShell.tsx's KitchenUpdateWatcher printing that same delta a
    // second time once this edit syncs. The online PATCH path (updateOrder
    // below) never passes this - a live edit always needs the normal
    // claim-and-print (or watcher) flow.
    const suppressKitchenUpdate = !!(options && options.suppressKitchenUpdate);
    // Set by importOfflineOrderUpdates when the till already printed the
    // customer/cashier receipt for this exact completeAndSettle, offline,
    // the instant the order was completed (DineIn/Delivery print their
    // receipt at completion, not placement - see SalesPage.tsx's
    // saveUpdate). Marks the order as already-printed so
    // DashboardShell.tsx's ReceiptPrintWatcher never prints it a second
    // time once this edit syncs - same reasoning as suppressKitchenUpdate
    // above, just for the receipt claim instead of pendingKitchenUpdate.
    const receiptPrinted = !!(options && options.receiptPrinted);

    if (patch.action === "addItems" && Array.isArray(patch.items)) {
      // Every item in an addItems payload IS the delta by definition - the
      // whole point of this action is appending brand new lines.
      const delta = patch.items
        .map((item) => ({ name: item.name, price: item.price, variation: item.variation || "", quantity: Number(item.quantity) || 0 }))
        .filter((item) => item.quantity > 0);
      if (delta.length > 0 && !suppressKitchenUpdate) {
        order.pendingKitchenUpdate = { items: mergeKitchenDelta(order.pendingKitchenUpdate?.items, delta), queuedAt: new Date() };
      }
      order.items = [...order.items, ...patch.items];
      itemsOrDiscountChanged = true;

      // Stock sync (Full/Partial Order Editing requirement): addItems only
      // ever ADDS quantity (new lines appended - see the comment above), so
      // this is purely a deduction, same as the very first deduction a new
      // order gets at creation time (createOrder's own deductStockForItems
      // call) - just for this delta instead of the whole order. Merged into
      // order.stockDeductions/costPrice (not overwritten) so a later full
      // cancellation still restores everything this order has ever really
      // taken off the shelf, across every edit, not just its original items.
      if (delta.length > 0) {
        const stockResult = await deductStockForItems(delta, order.shopId);
        order.stockDeductions = mergeStockDeductionsAdd(order.stockDeductions, stockResult.deductions);
        order.costPrice = Math.max(Number(order.costPrice || 0) + stockResult.costPrice, 0);
      }
    }

    if (patch.action === "replaceItems" && Array.isArray(patch.items)) {
      const delta = computeKitchenIncreaseDelta(order.items, patch.items);
      if (delta.length > 0 && !suppressKitchenUpdate) {
        order.pendingKitchenUpdate = { items: mergeKitchenDelta(order.pendingKitchenUpdate?.items, delta), queuedAt: new Date() };
      }

      // Stock sync (Full/Partial Order Editing requirement): unlike
      // addItems, replaceItems hands in a whole NEW item list that can
      // both raise some lines' quantities and lower/remove others in the
      // same request (e.g. Edit Order's quantity stepper, or removing one
      // cart line) - so both directions have to be resolved against the
      // OLD item list (order.items, still the pre-edit value here) before
      // it's overwritten below. `delta` above is already exactly the
      // increase half (reused, not recomputed, so the kitchen ticket and
      // the stock ledger can never disagree about what went up); the
      // decrease half mirrors it via computeQuantityDecreaseDelta.
      const decreaseDelta = computeQuantityDecreaseDelta(order.items, patch.items);
      if (decreaseDelta.length > 0) {
        // Give ingredients back FIRST, then take the increases off - order
        // doesn't actually matter for correctness (they touch the same
        // Ingredient docs additively/subtractively either way), but doing
        // the refund first means a shopper who swaps one large-quantity
        // item for another sees the freed-up stock accounted for before
        // the new deduction's own shortage check runs.
        const restoreResult = await restoreStockForItems(decreaseDelta, order.shopId);
        order.stockDeductions = mergeStockDeductionsSubtract(order.stockDeductions, restoreResult.restorations);
        order.costPrice = Math.max(Number(order.costPrice || 0) - restoreResult.creditValue, 0);
      }
      if (delta.length > 0) {
        const stockResult = await deductStockForItems(delta, order.shopId);
        order.stockDeductions = mergeStockDeductionsAdd(order.stockDeductions, stockResult.deductions);
        order.costPrice = Math.max(Number(order.costPrice || 0) + stockResult.costPrice, 0);
      }

      order.items = patch.items;
      itemsOrDiscountChanged = true;
    }

    if (patch.discount !== undefined) {
      order.discount = patch.discount;
      itemsOrDiscountChanged = true;
    }

    if (itemsOrDiscountChanged) {
      const totals = recalculateTotals(order.items, order.discount, order.deliveryFee);
      order.subtotal = totals.subtotal;
      order.tax = totals.tax;
      order.total = totals.total;
      order.discount = buildDiscountRecord(order.discount, totals.discountAmount);
      order.remainingAmount = Math.max(order.total - (order.paidAmount || 0), 0);
    }

    // Recompute grossProfit whenever an item edit may have moved costPrice
    // (addItems/replaceItems above) - deliberately placed AFTER the
    // itemsOrDiscountChanged block so order.total already reflects the
    // NEW item list/discount, not the pre-edit total. Mirrors exactly how
    // createOrder/importOfflineOrders compute grossProfit at creation time
    // (`total - costPrice`, stored rather than derived on read - see
    // Order.js's own comment on costPrice/grossProfit).
    if (patch.action === "addItems" || patch.action === "replaceItems") {
      order.grossProfit = Math.round(((order.total || 0) - (order.costPrice || 0)) * 100) / 100;
    }

    // A customer can have more than one order open at once now (see
    // createOrder - the old "one pending order at a time" block was
    // removed), so completing one of their bills can also be the moment
    // that settles their other outstanding bill(s) at the same time,
    // instead of those older orders staying "pending" forever even though
    // the money for them was just collected together with this one. The
    // Sales page's Complete Payment panel sends the FULL amount actually
    // collected (this order's own total plus whatever of the customer's
    // other dues the cashier chose to also collect) as `paidAmount`.
    //
    // Bug fix: this used to distribute that amount oldest-debt-first - the
    // older previousDues lump-sum, then other orders, and only whatever was
    // left over went toward THIS order. That let a stale/underestimated
    // "Previous Dues" figure (or another order's due changing between the
    // Complete Payment panel opening and this request landing) siphon the
    // payment away from the bill actually being completed right now, and
    // could leave IT showing a due even though the cashier explicitly chose
    // "Full Payment"/"Pay Full" for it. `Due Amount = Total Bill - Paid
    // Amount` must always hold for THIS order specifically, and a Full
    // Payment must always leave it at strictly 0 - so this order is now
    // settled FIRST out of whatever was collected, and only the leftover
    // (if the cashier chose to also collect other dues alongside it) spills
    // into previousDues, then this customer's other pending/unpaid orders,
    // oldest first.
    if (patch.action === "completeAndSettle") {
      if (patch.customer) order.customer = patch.customer;
      const customerPhone = order.customer?.phone;
      let paidTotal = Math.max(Number(patch.paidAmount) || 0, 0);

      // This order's own remaining balance (not order.total on its own -
      // that ignores anything already paid toward it) is settled before
      // anything else touches `paidTotal`. Same due-then-increment pattern
      // as the otherOrders loop below and customerController.js's
      // settleCustomerDues - this order is never any different from those.
      const thisOrderDue = typeof order.remainingAmount === "number"
        ? order.remainingAmount
        : Math.max((order.total || 0) - (order.paidAmount || 0), 0);
      const appliedToThis = Math.min(thisOrderDue, paidTotal);
      order.paidAmount = Number(order.paidAmount || 0) + appliedToThis;
      order.remainingAmount = Math.max(thisOrderDue - appliedToThis, 0);
      order.status = "completed";
      paidTotal -= appliedToThis;

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

      if (typeof patch.paymentMethod === "string") order.paymentMethod = patch.paymentMethod;
      if (typeof patch.note === "string") order.note = patch.note;
      // Change-Return Calculation: recorded purely for the receipt/display
      // (see Order.js's own comment on this field) - never touches the
      // dues cascade above, which only ever works off paidAmount/paidTotal.
      if (typeof patch.cashReceived === "number") order.cashReceived = Math.max(0, patch.cashReceived);
      if (receiptPrinted) order.customerReceiptPrintedAt = new Date();
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

    // Same "Technical Requirement #1" rule as createOrder above, applied to
    // moving an EXISTING pending order onto a different table (SalesPage.tsx's
    // Change Table modal) - without this, that modal's client-side filtering
    // of occupied tables is only a UI courtesy, and a stale tab or a direct
    // API call could still double-book a table that's already got another
    // active order on it. Only fires when the table is actually changing -
    // re-saving an order onto its own current table (a no-op) must never
    // trip over itself here, hence the `_id: { $ne: order._id }` exclusion.
    if (patch.table !== undefined && patch.table && patch.table !== order.table) {
      const effectiveOrderType = patch.orderType || order.orderType;
      if (effectiveOrderType === "DineIn") {
        const occupyingOrder = await Order.findOne({
          ...buildShopScope(req),
          orderType: "DineIn",
          table: patch.table,
          status: "pending",
          tableTimerCleared: { $ne: true },
          _id: { $ne: order._id },
        });

        // Same auto-free-if-expired rule as createOrder above - no staff
        // decision required, the window elapsing is enough on its own.
        if (occupyingOrder && !(await autoFreeExpiredTable(occupyingOrder, req))) {
          throw Object.assign(
            new Error(`Table ${patch.table} already has an active order. Complete or pay it to free up this table.`),
            { status: 409, reason: "table_occupied" }
          );
        }
      }
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
    if (typeof patch.cashReceived === "number") order.cashReceived = Math.max(0, patch.cashReceived);
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

    // "Order Completed" WhatsApp goes out only for a customer-qr order
    // actually being settled here (not the live HTTP path's offline-sync
    // replay counterpart, and not the other-orders-swept-into-completed
    // side effect inside applyOrderPatch's dues-settlement loop) - a
    // walk-in/staff order already gets its own separate PDF-receipt
    // WhatsApp flow client-side, so this would double-message that
    // customer if it fired for every order.
    if (req.body?.action === "completeAndSettle" && updated.source === "customer-qr") {
      const shop = await Shop.findById(updated.shopId).select("name phone address").lean();
      void notifyCustomerCompleted(updated, shop);
    }

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

    // Conflict resolution: expectedVersion is the order.version this edit
    // was originally built against (captured client-side the moment the
    // edit was queued - see offline-order-helpers.ts's saveOrderEditOffline
    // and Order.js's own `version` field, bumped on every write). Two
    // SEPARATE offline nodes (two different tills, each with their own
    // Local Hub - a single till and its paired phones already share one
    // queue and sync together) can each queue edits against the same
    // already-synced order while both are offline and unaware of the
    // other's change; applying both blindly here would be silent
    // last-write-wins data loss for whichever one landed first. Recommended-
    // and-chosen resolution is "reject + flag for staff", not last-write-
    // wins - so the FIRST edit against a given orderId in this batch is
    // checked against the order's real current version; if it doesn't
    // match what this till last knew, every edit this till queued against
    // that order is stale (built on outdated assumptions) and rejected as a
    // conflict rather than applied.
    //
    // Only checked ONCE per orderId per batch (via claimedOrderIds below),
    // not on every entry - a single till can queue several sequential
    // edits against the SAME order while offline (item added, then paid),
    // and every one of them still carries the SAME expectedVersion (its
    // local order snapshot only ever reflects the version last pulled from
    // the cloud, never bumped by its own not-yet-synced queued edits). Ordered
    // is a chain within a batch, from the SAME source, and must apply in full
    // once the first check passes - re-checking entry 2 against the version
    // entry 1 just bumped would falsely flag this till's own coherent,
    // already-ordered edit history as a conflict with itself.
    const claimedOrderIds = new Set();

    for (const entry of ordered) {
      const { localEditId, orderId, payload, kitchenPrinted, receiptPrinted, expectedVersion } = entry || {};
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

        if (typeof expectedVersion === "number" && !claimedOrderIds.has(orderId)) {
          if ((order.version || 1) !== expectedVersion) {
            failed.push({
              localEditId,
              orderId,
              error: `This order was changed elsewhere since this device last saw it (now v${order.version || 1}, expected v${expectedVersion}). Refresh and redo this edit.`,
              reason: "version_conflict",
            });
            continue;
          }
        }
        claimedOrderIds.add(orderId);

        await applyOrderPatch(order, payload || {}, req, { suppressKitchenUpdate: !!kitchenPrinted, receiptPrinted: !!receiptPrinted });
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

// Shared by the online POST /orders/:id/cancel handler below and the
// offline bulk replay path (exports.importOfflineCancellations) - the
// exact same "one real implementation, never a second copy that could
// quietly drift" reasoning as applyOrderPatch above. `key` is checked
// against the shop's cancelOrderKeyHash (set by the Super Admin - see
// superAdminController.exports.createShop / resetCancelOrderKey) with
// bcrypt.compare, exactly like a login password check. Never hardcoded,
// never compared as plaintext, and scoped to this shop only. Throws an
// Error with `.status` (and optional `.reason`) attached, same convention
// as applyOrderPatch, so callers can distinguish e.g. "already cancelled"
// from a genuine failure.
async function cancelOrderCore(orderId, key, reason, req) {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw Object.assign(new Error("Order not found"), { status: 404 });
  }

  const order = await Order.findOne({ _id: orderId, ...buildShopScope(req) });
  if (!order) {
    throw Object.assign(new Error("Order not found"), { status: 404 });
  }
  if (order.status === "cancelled") {
    throw Object.assign(new Error("This order is already cancelled."), { status: 400, reason: "already_cancelled" });
  }
  if (!key) {
    throw Object.assign(new Error("The shop's Cancel Order Key is required."), { status: 400 });
  }

  const shop = await Shop.findById(req.user.shopId).select("cancelOrderKeyHash").lean();
  if (!shop || !shop.cancelOrderKeyHash) {
    throw Object.assign(
      new Error("No Cancel Order Key has been set up for this shop yet. Ask your software provider (Super Admin) to set one."),
      { status: 409 }
    );
  }

  const matches = await bcrypt.compare(String(key), shop.cancelOrderKeyHash);
  if (!matches) {
    throw Object.assign(new Error("Incorrect Cancel Order Key."), { status: 401, reason: "wrong_key" });
  }

  const user = req.user?.id ? await User.findById(req.user.id).select("name username").lean() : null;

  order.status = "cancelled";
  order.cancelledAt = new Date();
  order.cancelledBy = user?.name || user?.username || "";
  order.cancelReason = reason || "No reason provided";
  order.version = Number(order.version || 0) + 1;
  await order.save();
  // Reverses exactly what deductStockForItems took off the shelf for this
  // order at creation time (see stockDeductions' own comment on Order.js) -
  // the ingredients were never actually cooked/served after all. Best-effort
  // and non-fatal, same as the deduction side - never blocks a cancellation
  // the Cancel Order Key already authorized.
  await restoreStockForOrder(order);
  return order;
}

// POST /api/orders/:id/cancel  body: { key, reason? }
// The only way an order's status can ever become "cancelled" - see
// cancelOrderCore above for the actual gate.
exports.cancelOrder = async (req, res) => {
  try {
    const order = await cancelOrderCore(req.params.id, req.body?.key, req.body?.reason, req);
    res.json({ ...order.toObject(), id: String(order._id) });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message, reason: error.reason });
    }
    res.status(500).json({ error: error.message });
  }
};

// POST /api/orders/import-offline-cancellations
// body: { cancellations: [{ localCancellationId, orderId, key, reason }] }
// The Cancel-specific counterpart to importOfflineOrderUpdates above -
// replays a Cancel Order made while offline (see CancelOrderModal.tsx +
// backend/localHub/localOrders.js's queueOrderCancellation) against the
// REAL, bcrypt-gated cancelOrderCore - deliberately never applyOrderPatch,
// which rejects status:"cancelled" outright (see its own comment on why).
// A wrong key comes back in `failed`, not `applied`: the till already
// showed this order as cancelled the moment it was entered offline (see
// CancelOrderModal.tsx), but that was only ever an optimistic guess, never
// authoritative - the next fresh orders-cache pull corrects the display
// back to whatever the cloud actually has once this fails.
exports.importOfflineCancellations = async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.cancellations) ? req.body.cancellations : [];
    const applied = [];
    const failed = [];

    for (const entry of entries) {
      const { localCancellationId, orderId, key, reason } = entry || {};
      try {
        const order = await cancelOrderCore(orderId, key, reason, req);
        applied.push({ localCancellationId, orderId, id: String(order._id) });
      } catch (entryError) {
        if (entryError.reason === "already_cancelled") {
          // Already in the state we wanted - most likely this exact
          // cancellation already synced on an earlier attempt and this
          // till just never got to ack it. Applied, not a failure to
          // surface/retry.
          applied.push({ localCancellationId, orderId });
          continue;
        }
        console.error("Failed to import one offline order cancellation:", entryError);
        failed.push({ localCancellationId, orderId, error: entryError.message, reason: entryError.reason });
      }
    }

    res.json({ applied, failed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const TRACKING_STATUSES = ["awaiting_confirmation", "confirmed", "preparing", "ready", "cancelled"];

// PATCH /api/orders/:id/tracking-status  body: { trackingStatus, reason? }
// Staff/admin-only control for the customer-tracking lifecycle of a
// customer-qr order (see models/Order.js's trackingStatus field comment -
// deliberately separate from the real `status` field used everywhere
// else). This is what CustomerOrderPage.tsx's status-polling screen
// reflects back to the customer, and what fires the rider WhatsApp
// notification the moment a Delivery order is accepted.
exports.updateTrackingStatus = async (req, res) => {
  try {
    const { trackingStatus, reason } = req.body || {};
    if (!TRACKING_STATUSES.includes(trackingStatus)) {
      return res.status(400).json({ message: "Invalid tracking status." });
    }

    const query = { _id: req.params.id, ...buildShopScope(req) };
    const order = await Order.findOne(query);
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (order.source !== "customer-qr") {
      return res.status(400).json({ message: "This isn't a customer-placed order." });
    }
    if (order.trackingStatus === "cancelled") {
      return res.status(400).json({ message: "This order was already cancelled." });
    }

    order.trackingStatus = trackingStatus;
    if (trackingStatus === "cancelled") {
      // Same terminal fields the real cancel flow sets (see
      // cancelOrderCore above) so a cancelled customer-qr order disappears
      // from active order lists the same way any other cancelled order
      // does - deliberately WITHOUT the bcrypt Cancel Order Key gate that
      // guards staff cancelling an already-rung-up order, since this is
      // declining/voiding an order that hasn't been accepted into the
      // kitchen queue yet (or, if it has, is still this shop's own call to
      // make on their own incoming online order - no cash-drawer
      // accounting depends on it the way a staff-placed order's does).
      const user = req.user?.id ? await User.findById(req.user.id).select("name username").lean() : null;
      order.status = "cancelled";
      order.cancelledAt = new Date();
      order.cancelledBy = user?.name || user?.username || "";
      order.cancelReason = reason || "Declined by shop";
    } else if (trackingStatus === "confirmed") {
      // Both notifications reuse this one Shop lookup - name/phone/address
      // feed the customer's WhatsApp template (customerNotificationService),
      // riderPhones feeds the existing delivery-rider broadcast.
      const shop = await Shop.findById(order.shopId).select("name phone address riderPhones").lean();
      void notifyCustomerConfirmed(order, shop);
      if (order.orderType === "Delivery") {
        void notifyRiderForDelivery(order, shop);
      }
    }

    order.version = Number(order.version || 0) + 1;
    await order.save();
    res.json({ ...order.toObject(), id: String(order._id) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PATCH /api/orders/:id/assign-rider  body: { riderId, riderName, riderPhone }
// Hands a Delivery order to one specific staff member (picked from
// waiterController.getRiders' "Delivery Rider" list on
// SalesPage.tsx's OnlineOrderControls) and sends THAT rider - not the
// whole Shop.riderPhones broadcast list - the customer's details and a
// Maps link over WhatsApp. Deliberately allowed for any Delivery
// customer-qr order regardless of trackingStatus (staff might reassign a
// delivery mid-flow, e.g. the first rider called in sick) - the response
// reports whether the WhatsApp message actually sent so a staff member
// isn't left thinking someone's on it when nobody was actually notified.
exports.assignRider = async (req, res) => {
  try {
    const { riderId, riderName, riderPhone } = req.body || {};
    const phone = String(riderPhone || "").trim();
    if (!phone) {
      return res.status(400).json({ message: "Choose a rider with a phone number on file." });
    }

    const query = { _id: req.params.id, ...buildShopScope(req) };
    const order = await Order.findOne(query);
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (order.orderType !== "Delivery") {
      return res.status(400).json({ message: "Only Delivery orders can be assigned to a rider." });
    }

    order.assignedRider = { id: String(riderId || ""), name: String(riderName || ""), phone, assignedAt: new Date() };
    order.version = Number(order.version || 0) + 1;
    await order.save();

    const shop = await Shop.findById(order.shopId).select("name").lean();
    const notified = await notifyAssignedRider(order, shop, phone);

    res.json({ ...order.toObject(), id: String(order._id), riderNotified: notified });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PATCH /orders/:id/change-request  body: { action: "approve" | "reject", reason? }
// A customer-qr order's own request to add/remove items (see
// publicOrderController.requestOrderChange) sits on the order as
// customerChangeRequest until staff/shop owner responds here. Approving
// applies the requested add/remove against the real order.items and
// recalculates totals the same way applyOrderPatch's own addItems/
// replaceItems branches do - including queueing the addition onto
// pendingKitchenUpdate, since the kitchen genuinely does need to know
// about more food to cook. Rejecting just marks it declined; the order's
// items are left untouched either way if rejected.
//
// NOT COVERED: unlike applyOrderPatch's addItems/replaceItems, this path
// does NOT run the stockService deduct/restore sync for its own item-list
// surgery below - a customer-qr change request is a narrower, less-used
// flow, and doing this correctly deserves its own careful pass rather than
// a rushed copy-paste here. A future change here should mirror
// applyOrderPatch's replaceItems handling (computeKitchenIncreaseDelta +
// computeQuantityDecreaseDelta against the pre-change order.items, then
// deductStockForItems/restoreStockForItems merged into
// stockDeductions/costPrice) before it touches ingredient stock.
exports.respondToChangeRequest = async (req, res) => {
  try {
    const { action, reason } = req.body || {};
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ message: "Invalid action." });
    }

    const order = await Order.findOne({ _id: req.params.id, ...buildShopScope(req) });
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (!order.customerChangeRequest || order.customerChangeRequest.status !== "pending") {
      return res.status(400).json({ message: "There's no change request waiting on this order." });
    }

    const user = req.user?.id ? await User.findById(req.user.id).select("name username").lean() : null;
    const respondedBy = user?.name || user?.username || "";

    if (action === "reject") {
      order.customerChangeRequest.status = "rejected";
      order.customerChangeRequest.respondedAt = new Date();
      order.customerChangeRequest.respondedBy = respondedBy;
      if (reason) {
        order.customerChangeRequest.note = order.customerChangeRequest.note
          ? `${order.customerChangeRequest.note} — Declined: ${reason}`
          : `Declined: ${reason}`;
      }
      order.version = Number(order.version || 0) + 1;
      await order.save();
      return res.json({ ...order.toObject(), id: String(order._id) });
    }

    // Approve - fold removeItems out of and addItems into the real order,
    // same shape applyOrderPatch's addItems/replaceItems branches leave
    // order.items in.
    const { addItems, removeItems } = order.customerChangeRequest;
    let items = order.items.map((item) => ({
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      variation: item.variation || "",
    }));

    if (removeItems && removeItems.length > 0) {
      removeItems.forEach((toRemove) => {
        let remaining = toRemove.quantity;
        items = items
          .map((item) => {
            if (remaining <= 0 || item.name !== toRemove.name || (item.variation || "") !== (toRemove.variation || "")) {
              return item;
            }
            const take = Math.min(item.quantity, remaining);
            remaining -= take;
            return { ...item, quantity: item.quantity - take };
          })
          .filter((item) => item.quantity > 0);
      });
    }

    if (addItems && addItems.length > 0) {
      const delta = addItems.map((item) => ({ name: item.name, price: item.price, variation: item.variation || "", quantity: item.quantity }));
      order.pendingKitchenUpdate = { items: mergeKitchenDelta(order.pendingKitchenUpdate?.items, delta), queuedAt: new Date() };
      items = [...items, ...addItems];
    }

    order.items = items;
    const totals = recalculateTotals(order.items, order.discount);
    order.subtotal = totals.subtotal;
    order.tax = totals.tax;
    order.total = totals.total;
    order.discount = buildDiscountRecord(order.discount, totals.discountAmount);
    order.remainingAmount = Math.max(order.total - (order.paidAmount || 0), 0);

    order.customerChangeRequest.status = "approved";
    order.customerChangeRequest.respondedAt = new Date();
    order.customerChangeRequest.respondedBy = respondedBy;
    order.version = Number(order.version || 0) + 1;
    await order.save();

    res.json({ ...order.toObject(), id: String(order._id) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
