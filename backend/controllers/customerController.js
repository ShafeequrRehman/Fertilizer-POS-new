const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const Order = require("../models/Order");
const { shopScope } = require("../middleware/attachShopScope");

// Placeholder phone used for walk-in/guest orders (see
// orderController.createOrder) - these are never upserted into the
// Customer collection, so they're excluded here too rather than showing
// up as a phantom "customer".
const WALKIN_PHONE = "03000000000";

exports.searchCustomers = async (req, res) => {
  const query = String(req.query.q || "").trim();
  const searchBy = req.query.searchBy || "both";

  if (query.length < 2) {
    return res.json([]);
  }

  const phoneQuery = query.replace(/\D/g, "");
  const filters = [];

  if (searchBy === "name" || searchBy === "both") {
    filters.push({ name: { $regex: query, $options: "i" } });
  }

  if ((searchBy === "phone" || searchBy === "both") && phoneQuery) {
    filters.push({ phone: { $regex: phoneQuery, $options: "i" } });
  }

  const baseQuery = { ...shopScope(req) };
  if (filters.length) baseQuery.$or = filters;

  const customers = await Customer.find(baseQuery).sort({ createdAt: -1 }).limit(20);
  res.json(customers);
};

exports.getAllCustomers = async (req, res) => {
  const customers = await Customer.find({ ...shopScope(req) }).sort({ name: 1 });
  res.json(customers);
};


exports.createCustomer = async (req, res) => {
  const customer = await Customer.create({ ...req.body, shopId: req.user.shopId });
  res.status(201).json(customer);
};

exports.updateCustomer = async (req, res) => {
  const { shopId, ...updates } = req.body;
  const customer = await Customer.findOneAndUpdate(
    { _id: req.params.id, ...shopScope(req) },
    updates,
    { new: true }
  );
  if (!customer) {
    return res.status(404).json({ error: "Customer not found" });
  }
  res.json(customer);
};

// GET /api/customers/ledger
// Per-customer statement: every order they've placed, how much of each
// order they've paid, and what's still outstanding - plus the older
// lump-sum `previousDues` figure (pre-dating per-order paid/remaining
// tracking) folded into the same "total owed" number. This is a read
// aggregation only; it doesn't change how paidAmount/remainingAmount are
// written (that still happens in orderController).
exports.getCustomerLedger = async (req, res) => {
  try {
    const scope = shopScope(req);
    const [customers, orders] = await Promise.all([
      Customer.find(scope).sort({ name: 1 }).lean(),
      // Projected to just the fields this endpoint actually reads below -
      // an unprojected find() here pulls every order's full `items` array
      // and everything else across the shop's ENTIRE order history (this
      // intentionally isn't date-bounded, since an old unpaid order must
      // still count towards totalOrderBalance no matter how old it is), so
      // on a shop with a large order history that was the main cost behind
      // this endpoint occasionally being slow enough to hit the frontend's
      // request timeout.
      Order.find(
        { ...scope, "customer.phone": { $exists: true, $ne: "" } },
        "customer.phone dailyOrderNumber createdAt orderType status paymentMethod total paidAmount remainingAmount"
      )
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const ordersByPhone = new Map();
    for (const order of orders) {
      const phone = order.customer?.phone;
      if (!phone || phone === WALKIN_PHONE) continue;
      if (!ordersByPhone.has(phone)) ordersByPhone.set(phone, []);
      ordersByPhone.get(phone).push(order);
    }

    const ledger = customers.map((customer) => {
      const customerOrders = ordersByPhone.get(customer.phone) || [];
      // Cancelled orders never billed anything - excluded from the money
      // totals, but still listed in the order history below for context.
      const billable = customerOrders.filter((order) => order.status !== "cancelled");

      const totalBilled = billable.reduce((sum, order) => sum + (order.total || 0), 0);
      const totalPaid = billable.reduce((sum, order) => sum + (order.paidAmount || 0), 0);
      const totalOrderBalance = billable.reduce((sum, order) => {
        const remaining = typeof order.remainingAmount === "number"
          ? order.remainingAmount
          : Math.max((order.total || 0) - (order.paidAmount || 0), 0);
        return sum + remaining;
      }, 0);
      const previousDues = Number(customer.previousDues || 0);

      return {
        id: String(customer._id),
        name: customer.name,
        phone: customer.phone,
        address: customer.address || "",
        previousDues,
        orderCount: customerOrders.length,
        totalBilled,
        totalPaid,
        totalOrderBalance,
        totalDue: totalOrderBalance + previousDues,
        lastOrderAt: customerOrders[0]?.createdAt || null,
        orders: customerOrders.map((order) => ({
          id: String(order._id),
          dailyOrderNumber: order.dailyOrderNumber,
          createdAt: order.createdAt,
          orderType: order.orderType,
          status: order.status,
          paymentMethod: order.paymentMethod,
          total: order.total || 0,
          paidAmount: order.paidAmount || 0,
          remainingAmount: typeof order.remainingAmount === "number"
            ? order.remainingAmount
            : Math.max((order.total || 0) - (order.paidAmount || 0), 0),
        })),
      };
    });

    ledger.sort((a, b) => b.totalDue - a.totalDue);
    res.json(ledger);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/customers/:phone/outstanding?excludeOrderId=<id>
// A customer is now allowed to have more than one order open at once (see
// orderController.createOrder - the old "one pending order at a time"
// block was removed), so when a cashier is about to collect payment on
// ANY one of a customer's bills, this tells them the true total the
// customer owes right now: every other non-cancelled order's still-unpaid
// balance, plus the older lump-sum previousDues figure. `excludeOrderId`
// leaves out the bill currently being paid, since its own total is
// already accounted for separately by the caller (see SalesPage.tsx).
exports.getCustomerOutstanding = async (req, res) => {
  try {
    const scope = shopScope(req);
    const phone = req.params.phone;
    const excludeOrderId = req.query.excludeOrderId;

    const orderQuery = {
      ...scope,
      "customer.phone": phone,
      status: { $ne: "cancelled" },
    };
    if (excludeOrderId && mongoose.Types.ObjectId.isValid(String(excludeOrderId))) {
      orderQuery._id = { $ne: excludeOrderId };
    }

    const [customer, orders] = await Promise.all([
      Customer.findOne({ phone, ...scope }).lean(),
      Order.find(orderQuery).lean(),
    ]);

    const ordersBalance = orders.reduce((sum, order) => {
      const remaining = typeof order.remainingAmount === "number"
        ? order.remainingAmount
        : Math.max((order.total || 0) - (order.paidAmount || 0), 0);
      return sum + remaining;
    }, 0);

    const previousDues = Number(customer?.previousDues || 0);

    res.json({ outstanding: ordersBalance + previousDues, ordersBalance, previousDues, pendingOrderCount: orders.filter((o) => o.status === "pending").length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateCustomerDues = async (req, res) => {
  const customer = await Customer.findOneAndUpdate(
    { phone: req.params.phone, ...shopScope(req) },
    { previousDues: Number(req.body.previousDues || 0) },
    { new: true }
  );

  if (!customer) {
    return res.status(404).json({ error: "Customer not found" });
  }

  res.json(customer);
};
