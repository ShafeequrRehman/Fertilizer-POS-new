const User = require("../models/User");
const Order = require("../models/Order");
const ShopSession = require("../models/ShopSession");
const Shop = require("../models/Shop");
const { shopScope } = require("../middleware/attachShopScope");

// Orders that shouldn't be silently swept into a closed shift without the
// person closing the shop seeing them first: still "pending" (not yet
// completed/paid at the till), or completed but with money still owed.
// Cancelled orders are never "unresolved" - they're excluded from sales
// totals entirely, closed or not.
function buildUnresolvedQuery(shopId, openedAt) {
  return {
    shopId,
    createdAt: { $gte: openedAt },
    status: { $ne: "cancelled" },
    $or: [{ status: "pending" }, { remainingAmount: { $gt: 0 } }],
  };
}

function summarizeOrders(orders) {
  const nonCancelled = orders.filter((o) => o.status !== "cancelled");
  const cancelledCount = orders.length - nonCancelled.length;
  const paymentBreakdown = { Cash: 0, Card: 0, "E-Wallet": 0 };
  let totalSales = 0;
  let totalPaid = 0;
  let totalDue = 0;
  let totalDiscount = 0;

  for (const order of nonCancelled) {
    totalSales += Number(order.total || 0);
    totalPaid += Number(order.paidAmount || 0);
    totalDue += Number(order.remainingAmount || 0);
    totalDiscount += Number(order.discount?.amount || 0);
    const method = order.paymentMethod || "Cash";
    paymentBreakdown[method] = (paymentBreakdown[method] || 0) + Number(order.paidAmount || 0);
  }

  return {
    orderCount: nonCancelled.length,
    cancelledCount,
    totalSales,
    totalPaid,
    totalDue,
    totalDiscount,
    paymentBreakdown,
  };
}

// GET /api/shop-session/current
exports.getCurrent = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const session = await ShopSession.findOne({ shopId, status: "open" }).sort({ openedAt: -1 }).lean();

    // Tr# (see models/Order.js's shopSequenceNumber) - the shop's
    // permanent, never-resetting order count, unlike session.orderCounter
    // below which resets every shift. Read regardless of whether the shop
    // is currently open, same as orderCounter, so the till's Local Hub can
    // reconcile its own reserved numbers (see local-hub-api.ts's
    // syncLifetimeCounter) even right after a fresh shop open.
    const shop = await Shop.findById(shopId).select("orderSequenceCounter").lean();
    const shopSequenceCounter = shop?.orderSequenceCounter ?? 0;

    if (!session) {
      return res.json({ isOpen: false, session: null, shopSequenceCounter });
    }

    // Live counts so the header badge / POS lock screen can show progress
    // without waiting for close - computed on demand rather than kept in
    // sync on every order write, since this endpoint is only hit on page
    // load and after open/close actions, not polled.
    const liveOrders = await Order.find({ shopId, createdAt: { $gte: session.openedAt } })
      .select("total paymentMethod paidAmount remainingAmount status discount")
      .lean();
    const liveSummary = summarizeOrders(liveOrders);

    res.json({
      isOpen: true,
      session: { ...session, id: String(session._id), liveSummary },
      shopSequenceCounter,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /api/shop-session/open
exports.openSession = async (req, res) => {
  try {
    const { shopId } = shopScope(req);

    const existing = await ShopSession.findOne({ shopId, status: "open" }).lean();
    if (existing) {
      return res.status(409).json({ error: "The shop is already open." });
    }

    const user = req.user?.id ? await User.findById(req.user.id).select("name username").lean() : null;
    const openedByName = user?.name || user?.username || "";

    let session;
    try {
      session = await ShopSession.create({
        shopId,
        status: "open",
        openedAt: new Date(),
        openedBy: req.user?.id ? String(req.user.id) : "",
        openedByName,
      });
    } catch (createError) {
      // The findOne check above is a friendly fast-path, not the real
      // guarantee - the partial unique index on ShopSession (shopId,
      // status: "open") is what actually prevents two concurrent opens
      // (double-click, two tabs/devices) from both succeeding. If that
      // race happens, this is the same "already open" response the normal
      // path gives, just reached via the database's own duplicate-key
      // rejection instead of the earlier find.
      if (createError?.code === 11000) {
        return res.status(409).json({ error: "The shop is already open." });
      }
      throw createError;
    }

    res.status(201).json({ ...session.toObject(), id: String(session._id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /api/shop-session/close
// Body: { force?: boolean } - if there are unresolved (pending/unpaid)
// orders and force is not true, responds 409 with the list of them instead
// of closing, so the frontend can show a confirmation before proceeding.
exports.closeSession = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const force = Boolean(req.body?.force);

    const session = await ShopSession.findOne({ shopId, status: "open" });
    if (!session) {
      return res.status(409).json({ error: "The shop is not currently open." });
    }

    const unresolvedOrders = await Order.find(buildUnresolvedQuery(shopId, session.openedAt))
      .select("dailyOrderNumber total remainingAmount status orderType customer createdAt")
      .sort({ createdAt: -1 })
      .lean();

    if (unresolvedOrders.length > 0 && !force) {
      return res.status(409).json({
        needsConfirmation: true,
        unresolvedOrders: unresolvedOrders.map((o) => ({
          id: String(o._id),
          dailyOrderNumber: o.dailyOrderNumber,
          total: o.total,
          remainingAmount: o.remainingAmount,
          status: o.status,
          orderType: o.orderType,
          customerName: o.customer?.name || "",
          createdAt: o.createdAt,
        })),
      });
    }

    const closedAt = new Date();
    const allOrders = await Order.find({ shopId, createdAt: { $gte: session.openedAt, $lte: closedAt } })
      .select("total paymentMethod paidAmount remainingAmount status discount")
      .lean();
    const summary = summarizeOrders(allOrders);

    const user = req.user?.id ? await User.findById(req.user.id).select("name username").lean() : null;
    const closedByName = user?.name || user?.username || "";

    session.status = "closed";
    session.closedAt = closedAt;
    session.closedBy = req.user?.id ? String(req.user.id) : "";
    session.closedByName = closedByName;
    session.closedWithUnpaidOrders = unresolvedOrders.length > 0;
    session.summary = summary;
    await session.save();

    res.json({ ...session.toObject(), id: String(session._id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/shop-session/history - most recent shifts first, newest 60.
exports.getHistory = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const sessions = await ShopSession.find({ shopId }).sort({ openedAt: -1 }).limit(60).lean();
    res.json(sessions.map((s) => ({ ...s, id: String(s._id) })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
