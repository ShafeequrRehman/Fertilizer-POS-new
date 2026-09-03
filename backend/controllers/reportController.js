const mongoose = require("mongoose");
const Order = require("../models/Order");
const Expense = require("../models/Expense");
const IngredientPurchase = require("../models/IngredientPurchase");
const { shopScope } = require("../middleware/attachShopScope");

// The fixed category heading every ingredient-purchase batch is grouped
// under in the expense breakdown - see getDayEndReport's own comment on why
// this is shown but never added into otherExpenses/netProfit.
const KITCHEN_STOCK_CATEGORY = "Kitchen Stock";

// Same plain YYYY-MM-DD `startDate`/`endDate` convention as
// customerController.getCustomerLedger and ingredientPurchaseController -
// one date-range shape used everywhere in this app, so the frontend's
// Daily/Monthly/Yearly/Custom picker can talk to every report endpoint the
// same way. Falls back to "today" (UTC) when either is missing/invalid -
// a Day-End report with nothing picked yet should default to today's
// numbers, not an empty or all-time range.
function resolveRange(query) {
  const { startDate, endDate } = query;
  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return { start, end };
    }
  }
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  return { start, end };
}

// GET /api/reports/day-end?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//
// Task 3 (Purchasing/Financial Logic): the Day-End Closing matrix.
//   Total Revenue     = sum of Order.total for every non-cancelled order in
//                        range - the exact same definition
//                        shopSessionController.summarizeOrders already uses
//                        for a shift's totalSales, just aggregated over an
//                        arbitrary date range instead of one open session.
//   Total Product Cost (COGS) = sum of Order.costPrice - the frozen
//                        per-order ingredient cost snapshot
//                        services/stockService.js computed at the moment
//                        each order was placed (see Order.js's own comment
//                        on why that's a snapshot, not a live recompute).
//   Other Expenses     = sum of Expense.amount logged in range (gas,
//                        electricity, wages, waste, ...), also broken down
//                        per category so a manager can see where money went.
//   Net Profit         = Total Revenue - Total Product Cost - Other Expenses.
//
// Ingredient Purchase Workflow enhancement: every IngredientPurchase batch
// logged in range (see ingredientPurchaseController.createPurchase) is
// ALSO surfaced here, grouped under a single "Kitchen Stock" heading in
// expenseBreakdown - with the underlying line items themselves returned as
// `kitchenStockDetails` (Company Name, Product Name, Quantity, and the
// financial totals for each batch) so the dashboard can render a real
// detail table, not just one lump total - so a manager sees total cash
// spent on stock, and exactly what made it up, in the same dashboard as
// every other expense. It is deliberately excluded from otherExpenses/
// netProfit (flagged via excludedFromNetProfit on its expenseBreakdown row)
// - that ingredient cost is already counted exactly once, via costOfGoods,
// at the moment it's actually CONSUMED by a sale (see Order.costPrice's own
// comment). Folding the raw purchase amount into otherExpenses too would
// subtract the same money from Net Profit twice: once when it's bought,
// again when it's sold.
//
// Three queries (Order aggregate, Expense aggregate x2, IngredientPurchase
// find) instead of one combined pipeline - different collections with no
// join key worth $lookup-ing across for a single summary; running them in
// parallel via Promise.all costs nothing extra a sequential set of queries
// wouldn't also cost.
exports.getDayEndReport = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const shopObjectId = new mongoose.Types.ObjectId(shopId);
    const { start, end } = resolveRange(req.query);

    const [orderTotals, expenseTotals, expenseByCategory, kitchenStockPurchaseDocs] = await Promise.all([
      Order.aggregate([
        { $match: { shopId: shopObjectId, status: { $ne: "cancelled" }, createdAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$total" },
            costOfGoods: { $sum: "$costPrice" },
            grossProfit: { $sum: "$grossProfit" },
            orderCount: { $sum: 1 },
          },
        },
      ]),
      Expense.aggregate([
        { $match: { shopId: shopObjectId, date: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Expense.aggregate([
        { $match: { shopId: shopObjectId, date: { $gte: start, $lte: end } } },
        { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      // .find() rather than a $group aggregate - the detail table needs
      // every individual batch (company, product, quantity, totals), not
      // just a lump sum, so the totals below are derived from this same
      // array in JS instead of running a second query for them.
      //
      // Dual-Status Stock Inventory Workflow: status:"received" +
      // receivedAt (not purchaseDate) - a "pending" purchase order hasn't
      // actually cost the shop anything yet (nothing's arrived, nothing's
      // been paid, and it was never folded into Ingredient stock/cost), so
      // counting it here would overstate real spend for a period that
      // hasn't actually happened yet. receivedAt (not purchaseDate) is what
      // this range is scoped by, since that's the date the cost was
      // genuinely incurred - see IngredientPurchase.js's own comment on the
      // two fields.
      IngredientPurchase.find({ shopId: shopObjectId, status: "received", receivedAt: { $gte: start, $lte: end } })
        .select("companyName ingredientName productDetails quantity unit rate totalAmount paidAmount remainingAmount purchaseDate receivedAt")
        .sort({ receivedAt: -1 })
        .lean(),
    ]);

    const revenue = orderTotals[0]?.revenue || 0;
    const costOfGoods = orderTotals[0]?.costOfGoods || 0;
    const orderCount = orderTotals[0]?.orderCount || 0;
    const otherExpenses = expenseTotals[0]?.total || 0;
    const expenseCount = expenseTotals[0]?.count || 0;
    const kitchenStockPurchases = kitchenStockPurchaseDocs.reduce((sum, p) => sum + (p.totalAmount || 0), 0);
    const kitchenStockPurchaseCount = kitchenStockPurchaseDocs.length;
    // Recomputed here (revenue - costOfGoods - otherExpenses) rather than
    // trusting a sum of the per-order grossProfit snapshots - grossProfit
    // only ever nets out COGS against revenue, it has no idea Other
    // Expenses even exist, so it can never be net profit on its own.
    // kitchenStockPurchases is deliberately NOT subtracted here - see this
    // function's own comment above on why.
    const netProfit = Math.round((revenue - costOfGoods - otherExpenses) * 100) / 100;

    const expenseBreakdown = expenseByCategory.map((row) => ({ category: row._id || "Uncategorized", total: row.total, count: row.count }));
    if (kitchenStockPurchaseCount > 0) {
      expenseBreakdown.push({
        category: KITCHEN_STOCK_CATEGORY,
        total: kitchenStockPurchases,
        count: kitchenStockPurchaseCount,
        excludedFromNetProfit: true,
      });
    }

    res.json({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      revenue,
      costOfGoods,
      otherExpenses,
      kitchenStockPurchases,
      kitchenStockPurchaseCount,
      netProfit,
      orderCount,
      expenseCount,
      expenseBreakdown,
      kitchenStockDetails: kitchenStockPurchaseDocs.map((p) => ({
        id: String(p._id),
        companyName: p.companyName || "Unspecified",
        ingredientName: p.ingredientName,
        productDetails: p.productDetails || "",
        quantity: p.quantity,
        unit: p.unit,
        rate: p.rate,
        totalAmount: p.totalAmount,
        paidAmount: p.paidAmount,
        remainingAmount: p.remainingAmount,
        purchaseDate: p.purchaseDate,
        receivedAt: p.receivedAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/reports/my-sales?date=YYYY-MM-DD (optional, defaults to today)
//
// Role-Based Security: the Receptionist role (config/permissions.js) is
// deliberately given "reports.view.own_sales" instead of the full
// "reports.view" - this is what that key actually unlocks. Scoped two ways
// at once: only orders THIS logged-in account created (Order.userId, set
// from req.user.id at creation time - see orderController.createOrder),
// and only a single calendar day (a "daily personal sales report", not a
// date-range one - no rangeFrom/rangeTo picker here, unlike getDayEndReport).
// Returns revenue/collected/due and the order list only - deliberately NO
// costPrice/grossProfit/netProfit fields, so a Receptionist's own network
// traffic never carries restaurant-wide profit data even if the frontend
// never renders it.
exports.getMySalesReport = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const shopObjectId = new mongoose.Types.ObjectId(shopId);

    const requestedDate = typeof req.query.date === "string" ? req.query.date : "";
    const parsedStart = requestedDate ? new Date(`${requestedDate}T00:00:00.000Z`) : null;
    const day = parsedStart && !Number.isNaN(parsedStart.getTime()) ? requestedDate : new Date().toISOString().slice(0, 10);
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(`${day}T23:59:59.999Z`);

    const orders = await Order.find({
      shopId: shopObjectId,
      userId: String(req.user.id),
      createdAt: { $gte: start, $lte: end },
    })
      .select("dailyOrderNumber orderType status total paidAmount remainingAmount createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const activeOrders = orders.filter((order) => order.status !== "cancelled");
    const revenue = activeOrders.reduce((sum, order) => sum + (order.total || 0), 0);
    const totalCollected = activeOrders.reduce((sum, order) => sum + (order.paidAmount || 0), 0);
    const totalDue = activeOrders.reduce((sum, order) => sum + (order.remainingAmount || 0), 0);

    res.json({
      date: day,
      orderCount: activeOrders.length,
      cancelledCount: orders.length - activeOrders.length,
      revenue,
      totalCollected,
      totalDue,
      orders: orders.map((order) => ({
        id: String(order._id),
        dailyOrderNumber: order.dailyOrderNumber,
        orderType: order.orderType,
        status: order.status,
        total: order.total,
        paidAmount: order.paidAmount,
        remainingAmount: order.remainingAmount,
        createdAt: order.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/reports/inventory?startDate=&endDate=
//
// Role-Based Security: the Stock Manager role is given
// "reports.view.inventory" instead of "reports.view" - this is what that
// key unlocks. Task 2's "data, logs, and supplier dues directly related to
// inventory and kitchen stock management" - kitchen stock purchase batches
// in range (same shape as getDayEndReport's own kitchenStockDetails) plus
// every company's all-time outstanding balance (mirrors
// ingredientPurchaseController.getCompanyLedger's grouping exactly, kept as
// its own query here rather than calling that controller function directly,
// so this route's response shape stays independent of the Ledger page's).
// Deliberately NO revenue/costOfGoods/netProfit fields anywhere in this
// response - a Stock Manager's own network traffic never carries
// restaurant-wide sales/profit data.
exports.getInventoryReport = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const shopObjectId = new mongoose.Types.ObjectId(shopId);
    const { start, end } = resolveRange(req.query);

    const [purchasesInRange, allPurchases] = await Promise.all([
      // Dual-Status Stock Inventory Workflow: status:"received" +
      // receivedAt, same reasoning as getDayEndReport's identical query
      // above - a still-"pending" order hasn't cost anything yet.
      IngredientPurchase.find({ shopId: shopObjectId, status: "received", receivedAt: { $gte: start, $lte: end } })
        .select("companyName ingredientName productDetails quantity unit rate totalAmount paidAmount remainingAmount purchaseDate receivedAt")
        .sort({ receivedAt: -1 })
        .lean(),
      // All-time (not range-scoped) - same "current balance vs period
      // activity" split as getCompanyLedger: totalDue must reflect every
      // batch ever logged, not just what's in the picked window. Also
      // status:"received"-only - see getCompanyLedger's own comment on why
      // a pending order carries no real due yet.
      IngredientPurchase.find({ shopId: shopObjectId, companyName: { $ne: "" }, status: "received" })
        .select("companyName remainingAmount")
        .lean(),
    ]);

    const kitchenStockPurchases = purchasesInRange.reduce((sum, p) => sum + (p.totalAmount || 0), 0);

    const dueByCompany = new Map();
    for (const purchase of allPurchases) {
      const key = (purchase.companyName || "").trim();
      if (!key) continue;
      dueByCompany.set(key, (dueByCompany.get(key) || 0) + (purchase.remainingAmount || 0));
    }
    const supplierDues = Array.from(dueByCompany.entries())
      .map(([companyName, totalDue]) => ({ companyName, totalDue }))
      .sort((a, b) => b.totalDue - a.totalDue);

    res.json({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      kitchenStockPurchases,
      kitchenStockPurchaseCount: purchasesInRange.length,
      kitchenStockDetails: purchasesInRange.map((p) => ({
        id: String(p._id),
        companyName: p.companyName || "Unspecified",
        ingredientName: p.ingredientName,
        productDetails: p.productDetails || "",
        quantity: p.quantity,
        unit: p.unit,
        rate: p.rate,
        totalAmount: p.totalAmount,
        paidAmount: p.paidAmount,
        remainingAmount: p.remainingAmount,
        purchaseDate: p.purchaseDate,
        receivedAt: p.receivedAt,
      })),
      supplierDues,
      totalSupplierDue: supplierDues.reduce((sum, row) => sum + row.totalDue, 0),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
