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
    const openSession = await ShopSession.findOneAndUpdate(
      { ...buildShopScope(req), status: "open" },
      { $inc: { orderCounter: 1 } },
      { new: true }
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

exports.checkPendingOrder = async (req, res) => {
  try {
    const exists = await Order.exists({ ...buildShopScope(req), "customer.phone": req.params.phone, status: "pending" });
    res.json({ exists: Boolean(exists) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateOrder = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await Order.findOne({ _id: req.params.id, ...buildShopScope(req) });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const patch = req.body;

    // Items changing (addItems/replaceItems) or the discount itself
    // changing both require the subtotal/tax/total/remainingAmount to be
    // recomputed from scratch, rather than trusting whatever the client
    // sends for those - see recalculateTotals above.
    let itemsOrDiscountChanged = false;

    if (patch.action === "addItems" && Array.isArray(patch.items)) {
      order.items = [...order.items, ...patch.items];
      itemsOrDiscountChanged = true;
    }

    if (patch.action === "replaceItems" && Array.isArray(patch.items)) {
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
      return res.json({ ...order.toObject(), id: String(order._id) });
    }

    // "cancelled" is deliberately excluded here - cancelling an order is
    // only ever allowed through exports.cancelOrder below, which requires
    // the shop's Cancel Order Key. Without this check, this generic PATCH
    // would let anyone with a login cancel any order for free, which
    // defeats the whole point of gating cancellation behind the key.
    if (patch.status === "cancelled") {
      return res.status(400).json({ error: "Cancelling an order requires the shop's Cancel Order Key. Use the Cancel Order action instead.", reason: "cancel_requires_key" });
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
    res.json({ ...order.toObject(), id: String(order._id) });
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
