const mongoose = require("mongoose");
const Order = require("../models/Order");
const Expense = require("../models/Expense");
const IngredientPurchase = require("../models/IngredientPurchase");
const StaffPayment = require("../models/StaffPayment");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Ingredient = require("../models/Ingredient");
const Bank = require("../models/Bank");
const Grain = require("../models/Grain");
const LabourAccount = require("../models/LabourAccount");
const MunshiAccount = require("../models/MunshiAccount");
const CashRegister = require("../models/CashRegister");
const DashboardAdjustment = require("../models/DashboardAdjustment");
const { shopScope } = require("../middleware/attachShopScope");

// The fixed category heading every ingredient-purchase batch is grouped
// under in the expense breakdown - see getDayEndReport's own comment on why
// this is shown but never added into otherExpenses/netProfit.
const KITCHEN_STOCK_CATEGORY = "Kitchen Stock";

// Same idea as KITCHEN_STOCK_CATEGORY, but the OPPOSITE accounting
// treatment - see getDayEndReport's StaffPayment aggregate below for why
// this one DOES get added into otherExpenses/netProfit.
const SALARY_PAYMENT_CATEGORY = "Salary Payment / Advance";

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
    // Day-End Shop Closing Summary passes full ISO timestamps (the current
    // open ShopSession's exact openedAt, and "now") instead of plain
    // YYYY-MM-DD dates - a shift can start and end mid-day, so widening it
    // out to midnight-to-midnight the way the Reports page's Daily/
    // Monthly/Yearly picker intentionally does would pull in orders from
    // BEFORE the shop opened (e.g. a previous shift earlier that same
    // calendar day). Detected by the presence of "T" - a plain date string
    // never contains one, an ISO timestamp always does - so this stays
    // fully backward compatible with every existing YYYY-MM-DD caller.
    const start = startDate.includes("T") ? new Date(startDate) : new Date(`${startDate}T00:00:00.000Z`);
    const end = endDate.includes("T") ? new Date(endDate) : new Date(`${endDate}T23:59:59.999Z`);
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
// Day-End Shop Closing Summary (the "Close Shop" screen, DashboardShell.tsx's
// ShopClosingSummaryModal) reuses this exact endpoint - scoped to the
// current open ShopSession's [openedAt, now) window instead of an
// arbitrary picked range - for its own Total Orders (Dine-In/Takeaway/
// Delivery split, via orderTypeBreakdown) and Outstanding Due figures
// (totalDue), on top of the Revenue/Expenses/Net Profit this already
// computed.
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

    const [orderTotals, orderTypeTotals, expenseTotals, expenseByCategory, kitchenStockPurchaseDocs, staffPaymentTotals] = await Promise.all([
      Order.aggregate([
        { $match: { shopId: shopObjectId, status: { $ne: "cancelled" }, createdAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$total" },
            costOfGoods: { $sum: "$costPrice" },
            grossProfit: { $sum: "$grossProfit" },
            orderCount: { $sum: 1 },
            // Shop Closing Summary: total still-owed amount across every
            // non-cancelled order in range - remainingAmount is already
            // clamped/maintained by every place that ever touches it (see
            // Order.js's own comment), so a plain $sum here is exact, no
            // extra "only if status !== paid" filter needed - a fully-paid
            // order's remainingAmount is already 0.
            totalDue: { $sum: "$remainingAmount" },
          },
        },
      ]),
      // Day-End Shop Closing Summary: order count split by orderType
      // (DineIn/TakeAway/Delivery - see Order.js's enum) - a separate
      // $group (keyed by orderType instead of null) rather than trying to
      // fold this into the aggregate above, since a single $group can only
      // ever produce one row per distinct _id.
      Order.aggregate([
        { $match: { shopId: shopObjectId, status: { $ne: "cancelled" }, createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: "$orderType", count: { $sum: 1 } } },
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
      // Employee Salary/Advance in the Daily Expense Report: unlike
      // Kitchen Stock above, a StaffPayment IS a genuine, otherwise-
      // uncounted cash expense - nothing else in this report (COGS,
      // otherExpenses) ever reflects labor cost, so this has to be added
      // in, not excluded. Grouped by `type` so bonus/deduction net out
      // correctly (see the totals math below) rather than assuming every
      // row reduces cash the same way a plain salary/advance payout does.
      // Deliberately no employee names/per-person amounts here - this
      // report is reachable by "reports.view" alone (Manager, Accountant),
      // while the Payroll page's own per-employee ledger
      // (shopOwnerController.listPayments) stays Shop-Owner-only; folding
      // named payment details into this shared report would leak exactly
      // the per-employee wage data that access boundary exists to protect.
      // A single same-day total carries no more than "Other Expenses"
      // already does for every other category.
      StaffPayment.aggregate([
        { $match: { shopId: shopObjectId, date: { $gte: start, $lte: end } } },
        { $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    const revenue = orderTotals[0]?.revenue || 0;
    const costOfGoods = orderTotals[0]?.costOfGoods || 0;
    const orderCount = orderTotals[0]?.orderCount || 0;
    const totalDue = Math.round((orderTotals[0]?.totalDue || 0) * 100) / 100;
    // Day-End Shop Closing Summary: always all three keys, even at 0 - a
    // shift with zero Delivery orders should still show "Delivery: 0" on
    // the closing screen rather than omitting the row entirely, which is
    // why this starts as a fixed object instead of building it purely from
    // whatever _id values the aggregate happened to return.
    const orderTypeBreakdown = { DineIn: 0, TakeAway: 0, Delivery: 0 };
    for (const row of orderTypeTotals) {
      if (row._id && Object.prototype.hasOwnProperty.call(orderTypeBreakdown, row._id)) {
        orderTypeBreakdown[row._id] = row.count;
      }
    }
    const kitchenStockPurchases = kitchenStockPurchaseDocs.reduce((sum, p) => sum + (p.totalAmount || 0), 0);
    const kitchenStockPurchaseCount = kitchenStockPurchaseDocs.length;

    // Employee Salary/Advance total for the period - salary and advance
    // and bonus are all real cash paid out to staff; deduction claws money
    // back (e.g. correcting an earlier overpayment), so it nets AGAINST
    // the other three rather than adding to them. Exact same net-effect
    // formula shopOwnerController.listPayroll already uses for one
    // employee's "paid this month" (bucket.paid - bucket.deduction, with
    // bonus tracked separately there too) - just summed across every
    // employee and every type here instead of scoped to one person.
    const staffPaymentByType = { salary: 0, advance: 0, bonus: 0, deduction: 0 };
    let staffPaymentRowCount = 0;
    for (const row of staffPaymentTotals) {
      if (row._id && Object.prototype.hasOwnProperty.call(staffPaymentByType, row._id)) {
        staffPaymentByType[row._id] = row.total;
      }
      staffPaymentRowCount += row.count;
    }
    const staffPaymentNet = Math.round(
      (staffPaymentByType.salary + staffPaymentByType.advance + staffPaymentByType.bonus - staffPaymentByType.deduction) * 100
    ) / 100;

    // otherExpenses/expenseCount now cover BOTH the Expense collection
    // (gas, electricity, employee meals, ...) AND staff salary/advance
    // payments - unlike kitchenStockPurchases below, salary is a genuine
    // cost this report never counted anywhere else (COGS only ever
    // reflects ingredient cost, never labor), so leaving it out would
    // understate real spend and overstate netProfit.
    const otherExpenses = Math.round(((expenseTotals[0]?.total || 0) + staffPaymentNet) * 100) / 100;
    const expenseCount = (expenseTotals[0]?.count || 0) + staffPaymentRowCount;
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
    if (staffPaymentRowCount > 0) {
      expenseBreakdown.push({
        category: SALARY_PAYMENT_CATEGORY,
        total: staffPaymentNet,
        count: staffPaymentRowCount,
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
      orderTypeBreakdown,
      totalDue,
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

// GET /api/reports/dashboard-summary
//
// Home Dashboard's Accounting Overview - the one-shot "how's the shop
// doing right now" widget row the shop owner asked for (mirroring the
// Total Sale/Customer Balances/Cash in Hand/Balance on Bank/Stock Value/
// Vendor Balance/Total Purchase/Total Expenses/Sale on Cash/Sale on
// Credit/Sale on Bank/Total Recovery layout of the accounting software
// screenshot they shared). Always scoped to TODAY (server's UTC calendar
// day, same convention resolveRange's own default already uses) for every
// "today" figure - this is a live dashboard card, not a date-range report.
// Point-in-time figures (Cash in Hand, Balance on Bank, Stock Value,
// Vendor Balance, Customer Udhar/Advance) are always all-time/current -
// a balance doesn't reset at midnight.
// Accounting Overview's Day/This Month/Custom filter - "yahan bhe date
// honi chahy sara states ki day month aur year aur custom date ka hissab
// say states update hona chahya". Query params: range=today|month|custom
// (defaults to today, same as before this filter existed), plus
// startDate/endDate (YYYY-MM-DD) when range=custom.
//
// Only the tiles that are genuinely a SUM OF ACTIVITY within a period
// (Total Sale, Sale on Cash/Bank/Credit, Total Purchase, Total Expenses,
// Total Recovery) actually change value across Day/Month/Custom - their
// source data (Order.createdAt, IngredientPurchase.receivedAt,
// Expense.date, Customer.duesHistory[].createdAt) is fully timestamped, so
// re-summing over a different window is exact.
//
// Cash in Hand and Balance on Bank are handled specially: for Today/This
// Month (whose end is effectively "right now") the live CashRegister/Bank
// .balance is already the answer, but for a Custom range whose end date is
// before today, this replays each account's own history[] (every entry
// already carries its own balanceAfter/createdAt - see CashRegister.js/
// Bank.js) to reconstruct what the balance actually was at the end of that
// day - not just today's balance relabelled.
//
// Stock Value, Vendor Balance, Customer Udhar and Customer Advance are
// deliberately left as their current live totals regardless of range -
// Ingredient.currentStock, IngredientPurchase.remainingAmount and
// Customer.previousDues are all single live fields with no dated history
// of their own past values, so there's no reliable way to rewind them to
// an arbitrary past date without risking a wrong number - showing today's
// real balance is safer than a fabricated historical guess.
exports.getDashboardSummary = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const shopObjectId = new mongoose.Types.ObjectId(shopId);
    const now = new Date();
    const rangeMode = ["today", "month", "custom"].includes(req.query.range) ? req.query.range : "today";

    let start;
    let end;
    if (rangeMode === "month") {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
      end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    } else if (rangeMode === "custom" && req.query.startDate && req.query.endDate) {
      start = new Date(`${req.query.startDate}T00:00:00.000Z`);
      end = new Date(`${req.query.endDate}T23:59:59.999Z`);
    } else {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
      end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    }

    // See this function's own comment above - only a Custom range ending
    // before today needs the history-replay path; Today/This Month's end
    // is effectively "now", where the live balance already IS correct.
    const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    const needsHistoricalBalance = rangeMode === "custom" && end < todayEnd;

    function balanceAsOfEnd(currentBalance, history) {
      if (!needsHistoricalBalance) return Number(currentBalance || 0);
      let result = 0;
      let lastTime = -Infinity;
      for (const entry of history || []) {
        const t = entry.createdAt ? new Date(entry.createdAt).getTime() : null;
        if (t !== null && t <= end.getTime() && t > lastTime) {
          result = Number(entry.balanceAfter || 0);
          lastTime = t;
        }
      }
      return result;
    }

    const [
      todaysOrders,
      products,
      ingredients,
      banks,
      grains,
      labourAccount,
      munshiAccount,
      cashRegister,
      vendorDueAgg,
      todaysPurchaseAgg,
      todaysExpenseAgg,
      customers,
      customerOrderDueAgg,
      dashboardAdjustmentDocs,
    ] = await Promise.all([
      // Today's Sale / Sale on Cash / Sale on Bank / Sale on Credit - one
      // pass over today's non-cancelled orders, split by paymentMethod the
      // same way getLedgerTransactions already reads it.
      Order.find({ shopId: shopObjectId, status: { $ne: "cancelled" }, createdAt: { $gte: start, $lte: end } })
        .select("total paidAmount remainingAmount paymentMethod")
        .lean(),
      // Stock Value fallback - selling-price x current stock, used ONLY for
      // a Product that has no matching raw-stock Ingredient (see below).
      // There's no separate cost-price field on Product.js, so this stays
      // "what the shelf is worth at sale price" for that leftover case.
      Product.find({ shopId: shopObjectId }).select("name price stock").lean(),
      // Stock Value - real raw-stock valuation: currentStock x averageCost
      // (the actual weighted purchase rate this batch cost, from
      // IngredientPurchase - see Ingredient.js's own averageCost comment)
      // for every tracked ingredient. This is what most items on a
      // Fertilizer POS shelf actually are (Urea, DAP, sprays, ...) - see
      // stockService.js's own "no-setup-required" same-name Product<->
      // Ingredient auto-match, which is exactly why Product.stock itself is
      // never touched/maintained for these and can't be used here.
      Ingredient.find({ shopId: shopObjectId }).select("name currentStock averageCost").lean(),
      // Balance on Bank - every named bank this shop has added (Bank page).
      // history is only actually walked when needsHistoricalBalance is true
      // (see balanceAsOfEnd above) but is always selected here since which
      // range is active is only known after this query already ran.
      Bank.find({ shopId: shopObjectId }).select("balance history").lean(),
      // Grain Stock - every grain (Rice, Gandam, ...) this shop has added
      // (Grain Stock page), same "current rupee value on hand" idea as
      // Bank above - see grainController.js's own comment.
      Grain.find({ shopId: shopObjectId }).select("balance history").lean(),
      // Labour/Munshi Khata - each shop's own single running balance (not
      // a list of named accounts like Bank/Grain) - see LabourAccount.js/
      // MunshiAccount.js's own comment on why they track ON TOP of Cash in
      // Hand rather than instead of it.
      LabourAccount.findOne({ shopId: shopObjectId }).select("balance history").lean(),
      MunshiAccount.findOne({ shopId: shopObjectId }).select("balance history").lean(),
      CashRegister.findOne({ shopId: shopObjectId }).select("balance history").lean(),
      // Vendor Balance - total still owed to suppliers across every
      // received (not pending/cancelled) stock batch ever logged, same
      // status:"received" convention getCompanyLedger/getInventoryReport
      // already use.
      IngredientPurchase.aggregate([
        { $match: { shopId: shopObjectId, status: "received" } },
        { $group: { _id: null, total: { $sum: "$remainingAmount" } } },
      ]),
      // Total Purchase (today) - same receivedAt-scoped convention as
      // getDayEndReport's kitchenStockPurchaseDocs.
      IngredientPurchase.aggregate([
        { $match: { shopId: shopObjectId, status: "received", receivedAt: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
      Expense.aggregate([
        { $match: { shopId: shopObjectId, date: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // Customer Udhar (receivable) / Customer Advance - same
      // previousDues + totalOrderBalance definition
      // customerController.getCustomerLedger uses for one customer's own
      // totalDue, just aggregated across every customer here. duesHistory
      // also gives Total Recovery (today) below, off the very same read.
      Customer.find({ shopId: shopObjectId }).select("name phone previousDues duesHistory").lean(),
      Order.aggregate([
        { $match: { shopId: shopObjectId, status: { $ne: "cancelled" }, "customer.phone": { $exists: true, $ne: "" } } },
        { $group: { _id: "$customer.phone", due: { $sum: "$remainingAmount" } } },
      ]),
      // Manual per-tile corrections (Task 1's "every box editable" ask) -
      // see DashboardAdjustment.js's own comment on why cashInHand/
      // balanceOnBank are excluded (they already own a real edit home).
      DashboardAdjustment.find({ shopId: shopObjectId }).select("key total").lean(),
    ]);
    const adjustmentByKey = {};
    dashboardAdjustmentDocs.forEach((doc) => {
      adjustmentByKey[doc.key] = Number(doc.total || 0);
    });

    let saleOnCash = 0;
    let saleOnBank = 0;
    let saleOnCredit = 0;
    let totalSaleToday = 0;
    for (const order of todaysOrders) {
      totalSaleToday += Number(order.total || 0);
      saleOnCredit += Number(order.remainingAmount || 0);
      if (order.paymentMethod === "Bank") saleOnBank += Number(order.paidAmount || 0);
      else saleOnCash += Number(order.paidAmount || 0);
    }

    // Stock Value = every tracked Ingredient's own currentStock x
    // averageCost (the real purchase-rate valuation, e.g. 199pcs x
    // Rs400 = Rs79,600 for a batch bought at Rs400/pc), PLUS the old
    // price x stock fallback for any Product that has no matching
    // Ingredient by name (same case-insensitive match
    // stockService.js's ingredientNameKey uses) - so a product that
    // genuinely isn't raw-stock-tracked still counts, but one that IS
    // (the normal case here) is valued off its real Ingredient record
    // instead of Product.stock, which auto-matched products never
    // actually update.
    const ingredientNameSet = new Set(ingredients.map((i) => String(i.name || "").trim().toLowerCase()));
    const ingredientStockValue = ingredients.reduce((sum, i) => sum + Number(i.currentStock || 0) * Number(i.averageCost || 0), 0);
    const untrackedProductStockValue = products.reduce((sum, p) => {
      if (ingredientNameSet.has(String(p.name || "").trim().toLowerCase())) return sum;
      return sum + Number(p.price || 0) * Number(p.stock || 0);
    }, 0);
    const stockValue = ingredientStockValue + untrackedProductStockValue;
    const balanceOnBank = banks.reduce((sum, b) => sum + balanceAsOfEnd(b.balance, b.history), 0);
    const grainStockValue = grains.reduce((sum, g) => sum + balanceAsOfEnd(g.balance, g.history), 0);
    const labourBalance = balanceAsOfEnd(labourAccount?.balance, labourAccount?.history);
    const munshiBalance = balanceAsOfEnd(munshiAccount?.balance, munshiAccount?.history);
    const cashInHand = balanceAsOfEnd(cashRegister?.balance, cashRegister?.history);
    const vendorBalance = vendorDueAgg[0]?.total || 0;
    const totalPurchaseToday = todaysPurchaseAgg[0]?.total || 0;
    const totalExpensesToday = todaysExpenseAgg[0]?.total || 0;

    const orderDueByPhone = new Map(customerOrderDueAgg.map((row) => [row._id, row.due || 0]));
    let customerUdharTotal = 0;
    let customerAdvanceTotal = 0;
    let totalRecoveryToday = 0;
    // Task 4: the Dashboard's Customer Advance "Details" button just wants
    // a plain name + amount list, nothing else - one row per customer who
    // is currently in credit (totalDue < 0, i.e. they've paid the shop more
    // than they currently owe it).
    const customerAdvances = [];
    for (const customer of customers) {
      const totalDue = (orderDueByPhone.get(customer.phone) || 0) + Number(customer.previousDues || 0);
      if (totalDue > 0) {
        customerUdharTotal += totalDue;
      } else if (totalDue < 0) {
        customerAdvanceTotal += Math.abs(totalDue);
        customerAdvances.push({ name: customer.name || customer.phone, phone: customer.phone, amount: Math.abs(totalDue) });
      }

      for (const entry of customer.duesHistory || []) {
        if (entry.type !== "settle") continue;
        const entryDate = entry.createdAt ? new Date(entry.createdAt) : null;
        if (entryDate && entryDate >= start && entryDate <= end) {
          totalRecoveryToday += Number(entry.amount || 0);
        }
      }
    }
    customerAdvances.sort((a, b) => b.amount - a.amount);

    // Task 1: fold each tile's manual correction on top of its own real
    // computed figure - see DashboardAdjustment.js's own comment. cashInHand
    // and balanceOnBank are deliberately never touched here; they already
    // have their own real editable home (CashRegister/Bank).
    const adjusted = (key, value) => value + (adjustmentByKey[key] || 0);

    res.json({
      date: start.toISOString().slice(0, 10),
      range: rangeMode,
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      totalSaleToday: adjusted("totalSaleToday", totalSaleToday),
      saleOnCash: adjusted("saleOnCash", saleOnCash),
      saleOnBank: adjusted("saleOnBank", saleOnBank),
      saleOnCredit: adjusted("saleOnCredit", saleOnCredit),
      totalPurchaseToday: adjusted("totalPurchaseToday", totalPurchaseToday),
      totalExpensesToday: adjusted("totalExpensesToday", totalExpensesToday),
      totalRecoveryToday: adjusted("totalRecoveryToday", totalRecoveryToday),
      cashInHand,
      balanceOnBank,
      grainStockValue,
      labourBalance,
      munshiBalance,
      stockValue: adjusted("stockValue", stockValue),
      vendorBalance: adjusted("vendorBalance", vendorBalance),
      customerUdharTotal: adjusted("customerUdharTotal", customerUdharTotal),
      customerAdvanceTotal: adjusted("customerAdvanceTotal", customerAdvanceTotal),
      customerAdvances,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/reports/recovery-history?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//
// Task 3's "Recovery" Details button: a flat, date-filterable, newest-first
// list of every real due-payment ("- Pay Dues"/"Clear" on Customer Dues) any
// customer has ever made, whichever method it came in on - same duesHistory
// type:"settle" rows the Dashboard's own totalRecoveryToday already sums,
// just returned as a full list instead of one number, with a chosen range
// instead of always "today". No date params = every recovery ever recorded
// (the modal's own "All" pill on the frontend).
exports.getRecoveryHistory = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const shopObjectId = new mongoose.Types.ObjectId(shopId);
    const { startDate, endDate } = req.query;
    const rangeStart = startDate ? new Date(`${startDate}T00:00:00.000Z`) : null;
    const rangeEnd = endDate ? new Date(`${endDate}T23:59:59.999Z`) : null;

    const customers = await Customer.find({ shopId: shopObjectId }).select("name phone duesHistory").lean();

    const rows = [];
    for (const customer of customers) {
      for (const entry of customer.duesHistory || []) {
        if (entry.type !== "settle") continue;
        const entryDate = entry.createdAt ? new Date(entry.createdAt) : null;
        if (!entryDate) continue;
        if (rangeStart && entryDate < rangeStart) continue;
        if (rangeEnd && entryDate > rangeEnd) continue;
        rows.push({
          customerName: customer.name || customer.phone,
          customerPhone: customer.phone,
          amount: Number(entry.amount || 0),
          paymentMethod: entry.paymentMethod || "cash",
          bankName: entry.bankName || "",
          note: entry.note || "",
          createdBy: entry.createdBy || "",
          createdAt: entry.createdAt,
        });
      }
    }
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      total: rows.reduce((sum, row) => sum + row.amount, 0),
      rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/reports/ledger-transactions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//
// Shop Ledger / financial records (feature 6): a single, flat, date-sorted
// list of every real money-in/money-out event in the given range, so
// AccountingPage.tsx's "General Ledger" table can show actual transactions
// (cash sales, credit sales, due payments, purchases, expenses) instead of
// only Expense documents. Deliberately its own endpoint rather than
// folding this into getDayEndReport above - that one already has its own
// well-established shape (summary cards, budgeting breakdown) that other
// callers depend on; this returns raw rows instead, one per transaction,
// for a table to render directly.
//
// Same non-cancelled / date-range conventions getDayEndReport and
// getInventoryReport already use for Orders/IngredientPurchase, so the
// numbers here always agree with the rest of the Reports section.
exports.getLedgerTransactions = async (req, res) => {
  try {
    const { shopId } = shopScope(req);
    const shopObjectId = new mongoose.Types.ObjectId(shopId);
    const { start, end } = resolveRange(req.query);

    const [orders, purchases, expenses, customers] = await Promise.all([
      // Cash sales in / credit sales: one row per non-cancelled order in
      // range. `paidAmount` is what actually came in at/after creation
      // (money in); `remainingAmount > 0` marks it as carrying a credit
      // component - no separate collection needed, an order IS the credit
      // sale the moment it leaves a due.
      Order.find({ shopId: shopObjectId, status: { $ne: "cancelled" }, createdAt: { $gte: start, $lte: end } })
        .select("dailyOrderNumber shopSequenceNumber total paidAmount remainingAmount paymentMethod customer orderType createdAt status")
        .sort({ createdAt: 1 })
        .lean(),
      // Shop purchases out: same status:"received" + receivedAt convention
      // getDayEndReport's kitchenStockPurchaseDocs query already uses (see
      // that query's own comment on why receivedAt, not purchaseDate).
      IngredientPurchase.find({ shopId: shopObjectId, status: "received", receivedAt: { $gte: start, $lte: end } })
        .select("companyName ingredientName productDetails totalAmount paidAmount remainingAmount receivedAt")
        .sort({ receivedAt: 1 })
        .lean(),
      // General expenses out.
      Expense.find({ shopId: shopObjectId, date: { $gte: start, $lte: end } })
        .select("category description amount date")
        .sort({ date: 1 })
        .lean(),
      // Customer due payments in: duesHistory is a subdocument array on
      // each Customer, not its own collection - same flatten-in-JS
      // approach customerController.getCustomerLedger already uses for
      // this exact field, rather than an $unwind aggregate for what's a
      // relatively small array per customer.
      Customer.find({ shopId: shopObjectId }).select("name phone duesHistory").lean(),
    ]);

    const rows = [];

    for (const order of orders) {
      const isCredit = Number(order.remainingAmount || 0) > 0;
      rows.push({
        type: "sale",
        isCredit,
        date: order.createdAt,
        amount: Number(order.total || 0),
        direction: "in",
        label: `Order #${order.dailyOrderNumber ?? order.shopSequenceNumber ?? String(order._id).slice(-4)}`,
        detail: [
          order.customer?.name || "Walk-in Customer",
          order.paymentMethod || "Cash",
          isCredit ? `Rs ${order.remainingAmount} still due` : "Fully paid",
        ].filter(Boolean).join(" · "),
        refId: String(order._id),
        paidAmount: Number(order.paidAmount || 0),
        remainingAmount: Number(order.remainingAmount || 0),
        paymentMethod: order.paymentMethod || "Cash",
      });
    }

    for (const purchase of purchases) {
      rows.push({
        type: "purchase",
        isCredit: false,
        date: purchase.receivedAt,
        amount: Number(purchase.totalAmount || 0),
        direction: "out",
        label: purchase.ingredientName || purchase.productDetails || "Stock purchase",
        detail: purchase.companyName ? `From ${purchase.companyName}` : "",
        refId: String(purchase._id),
      });
    }

    for (const expense of expenses) {
      rows.push({
        type: "expense",
        isCredit: false,
        date: expense.date,
        amount: Number(expense.amount || 0),
        direction: "out",
        label: expense.category || "Expense",
        detail: expense.description || "",
        refId: String(expense._id),
      });
    }

    for (const customer of customers) {
      for (const entry of customer.duesHistory || []) {
        if (entry.type !== "settle") continue;
        const entryDate = entry.createdAt ? new Date(entry.createdAt) : null;
        if (!entryDate || Number.isNaN(entryDate.getTime()) || entryDate < start || entryDate > end) continue;
        rows.push({
          type: "due_payment",
          isCredit: false,
          date: entry.createdAt,
          amount: Number(entry.amount || 0),
          direction: "in",
          label: `Due payment - ${customer.name || customer.phone}`,
          detail: entry.note || "",
          refId: String(customer._id),
        });
      }
    }

    rows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const totalIn = rows.filter((r) => r.direction === "in").reduce((sum, r) => sum + r.amount, 0);
    const totalOut = rows.filter((r) => r.direction === "out").reduce((sum, r) => sum + r.amount, 0);

    res.json({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      rows,
      totalIn,
      totalOut,
      net: totalIn - totalOut,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
