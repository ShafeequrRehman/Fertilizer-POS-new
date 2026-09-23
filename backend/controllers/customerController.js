const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const Order = require("../models/Order");
const IngredientPurchase = require("../models/IngredientPurchase");
const User = require("../models/User");
const { shopScope } = require("../middleware/attachShopScope");
const { escapeRegex } = require("../utils/escapeRegex");
const { recordCustomerBankMovement } = require("./bankController");
const { recordCustomerGrainMovement } = require("./grainController");
const { recordCustomerLabourMovement } = require("./labourController");
const { recordCustomerMunshiMovement } = require("./munshiController");
const { recordCashMovement } = require("./cashController");

// The JWT (req.user) only ever carries id/role/shopId/permissions - never
// a display name (see auth/tokenService.js) - so recording who made a
// manual dues change needs one extra lookup, same pattern
// orderController.cancelOrder already uses for cancelledBy.
async function currentUserName(req) {
  if (!req.user?.id) return "";
  const user = await User.findById(req.user.id).select("name username").lean();
  return user?.name || user?.username || "";
}

// Placeholder phone used for walk-in/guest orders (see
// orderController.createOrder) - these are never upserted into the
// Customer collection, so they're excluded here too rather than showing
// up as a phantom "customer".
const WALKIN_PHONE = "03000000000";

// Every route below used to hand Mongoose documents/`.lean()` objects
// straight to res.json(), which serialize with `_id`, never `id` - the
// Customer model has no `toJSON: { virtuals: true }` set, so even
// non-lean docs don't get the built-in `id` virtual for free. Both
// frontends' Customer type declares `id` as required (pos-web/src/lib/
// pos-types.ts, pos-mobile/src/types/models.ts) and use it as their React
// list key and as the identifier passed back into updateCustomer(id, ...)
// - with `id` always undefined, list keys collapsed to the same
// `undefined` value (surfaced as the "each child in a list should have a
// unique key" warning, most visibly on pos-mobile's DuesScreen where
// LogBox shows it as a red-screen error) AND POSPage.tsx's "editing an
// existing selected customer's details" flow silently no-opped, since its
// `if (!selectedCustomerId || ...) return;` guard saw undefined and bailed
// every time. This helper is the one place that now guarantees `id` is
// always present - works on both lean plain objects and real Mongoose
// documents. `/customers/ledger` (getCustomerLedger below) already built
// its own response shape by hand and was never affected.
function serializeCustomer(customer) {
  const plain = typeof customer.toObject === "function" ? customer.toObject() : customer;
  return { ...plain, id: String(plain._id) };
}

exports.searchCustomers = async (req, res) => {
  const query = String(req.query.q || "").trim();
  const searchBy = req.query.searchBy || "both";

  if (query.length < 2) {
    return res.json([]);
  }

  const phoneQuery = query.replace(/\D/g, "");
  const filters = [];

  if (searchBy === "name" || searchBy === "both") {
    // escapeRegex - `query` is whatever the cashier typed into the search
    // box, handed straight to Mongo's regex engine; unescaped, a crafted
    // pattern can cause catastrophic backtracking (a same-shop denial of
    // service) - see utils/escapeRegex.js's own comment.
    filters.push({ name: { $regex: escapeRegex(query), $options: "i" } });
  }

  if ((searchBy === "phone" || searchBy === "both") && phoneQuery) {
    // phoneQuery was already stripped to digits only above, so it can
    // never contain a regex metacharacter - no escaping needed here.
    filters.push({ phone: { $regex: phoneQuery, $options: "i" } });
  }

  const baseQuery = { ...shopScope(req) };
  if (filters.length) baseQuery.$or = filters;

  // Alphabetical by name - matches every other customer listing in this
  // app (getAllCustomers/getCustomerLedger both already .sort({ name: 1 }))
  // and is what PurchasePage.tsx's "Link to Existing Khata Contact" search
  // box needs: the owner explicitly asked for an alphabetical lookup of
  // credit customers, not "most recently added first" (which is what this
  // used to sort by - a bug relative to that request, not a deliberate
  // choice, since nothing else in the app sorts customers this way).
  const customers = await Customer.find(baseQuery).sort({ name: 1 }).limit(20).lean();
  res.json(customers.map(serializeCustomer));
};

exports.getAllCustomers = async (req, res) => {
  // .lean() - read-only list (Ledger/Dues pages, customer lookup while
  // placing an order), same reasoning as productController.getProducts.
  const customers = await Customer.find({ ...shopScope(req) }).sort({ name: 1 }).lean();
  res.json(customers.map(serializeCustomer));
};


// Shared by the normal POST / route and importOfflineCustomerActions below
// (Offline Mode's queued "Add Customer" replay) - both just create a
// Customer doc from the same shape of payload, scoped to the same shop.
async function applyCreateCustomer(shopId, body) {
  return Customer.create({ ...body, shopId });
}

exports.createCustomer = async (req, res) => {
  const customer = await applyCreateCustomer(req.user.shopId, req.body);
  res.status(201).json(serializeCustomer(customer));
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
  res.json(serializeCustomer(customer));
};

// GET /api/customers/ledger?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Per-customer statement: every order they've placed, how much of each
// order they've paid, and what's still outstanding - plus the older
// lump-sum `previousDues` figure (pre-dating per-order paid/remaining
// tracking) folded into the same "total owed" number. This is a read
// aggregation only; it doesn't change how paidAmount/remainingAmount are
// written (that still happens in orderController).
//
// `startDate`/`endDate` are optional, plain `YYYY-MM-DD` strings (same
// format LedgerPage.tsx's Date Range picker - and RecordPage.tsx's - use
// for their `type="date"` inputs). When both are given, they scope which
// orders count towards `orderCount`/`totalBilled`/`totalPaid`/`orders`/
// `lastOrderAt` - i.e. what this statement shows as "activity in this
// period". They deliberately do NOT touch `totalOrderBalance`/`totalDue`/
// `previousDues`: those are this customer's real balance RIGHT NOW, and an
// old unpaid order sitting outside the picked report period still
// genuinely counts towards it - understating it just because it falls
// outside the dates picked for a report would make the number actively
// wrong, not just differently-scoped. This is the same "current balance
// vs. period activity" split any real statement/ledger makes.
exports.getCustomerLedger = async (req, res) => {
  try {
    const scope = shopScope(req);
    const { startDate, endDate } = req.query;
    let rangeStart = null;
    let rangeEnd = null;
    if (startDate && endDate) {
      const parsedStart = new Date(`${startDate}T00:00:00.000Z`);
      const parsedEnd = new Date(`${endDate}T23:59:59.999Z`);
      if (!Number.isNaN(parsedStart.getTime()) && !Number.isNaN(parsedEnd.getTime())) {
        rangeStart = parsedStart;
        rangeEnd = parsedEnd;
      }
    }

    const [customers, orders, purchases] = await Promise.all([
      Customer.find(scope).sort({ name: 1 }).lean(),
      // Projected to just the fields this endpoint actually reads below -
      // an unprojected find() here pulls every order's full `items` array
      // and everything else across the shop's ENTIRE order history (this
      // intentionally isn't date-bounded at the query level, even when a
      // report range is requested, since totalOrderBalance/totalDue below
      // still need every order regardless of the picked range - see the
      // comment above), so on a shop with a large order history that was
      // the main cost behind this endpoint occasionally being slow enough
      // to hit the frontend's request timeout.
      Order.find(
        { ...scope, "customer.phone": { $exists: true, $ne: "" } },
        "customer.phone dailyOrderNumber createdAt orderType status paymentMethod total paidAmount remainingAmount billTid billName cashRecipientName"
      )
        .sort({ createdAt: -1 })
        .lean(),
      // Unified Khata / Customer-Supplier Netting: every RECEIVED *or
      // CANCELLED* purchase this shop has ever logged against ANY Khata
      // contact, fetched once here (not N+1 per customer below) - same
      // batching style as ordersByPhone right below. "pending" is still
      // left out entirely - a still-"pending" order hasn't been billed/
      // paid against yet, so it shouldn't count toward (or even appear as
      // history for) what the shop owes this contact. "cancelled" purchases
      // ARE fetched (unlike getCompanyLedger, which only wants status:
      // "received" for its money totals) purely so this contact's History
      // timeline can show a cancelled purchase as an audited "Cancelled"
      // row instead of it silently vanishing - see the netBalance/
      // totalPurchaseBalance computation below, which still only sums
      // status:"received" lines, exactly as before.
      IngredientPurchase.find(
        { ...scope, linkedCustomerId: { $ne: null }, status: { $in: ["received", "cancelled"] } },
        "linkedCustomerId purchaseOrderNumber ingredientName quantity unit totalAmount paidAmount remainingAmount purchaseDate status cancelledAt cancelledBy cancelReason"
      )
        .sort({ purchaseDate: -1 })
        .lean(),
    ]);

    const ordersByPhone = new Map();
    for (const order of orders) {
      const phone = order.customer?.phone;
      if (!phone || phone === WALKIN_PHONE) continue;
      if (!ordersByPhone.has(phone)) ordersByPhone.set(phone, []);
      ordersByPhone.get(phone).push(order);
    }

    // Unified Khata: keyed by linkedCustomerId (a real ObjectId ref, unlike
    // ordersByPhone's phone-string key - a purchase is linked by id, not by
    // a phone number a supplier-side batch was never asked for).
    const purchasesByCustomerId = new Map();
    for (const purchase of purchases) {
      const key = String(purchase.linkedCustomerId);
      if (!purchasesByCustomerId.has(key)) purchasesByCustomerId.set(key, []);
      purchasesByCustomerId.get(key).push(purchase);
    }

    const ledger = customers.map((customer) => {
      const customerOrders = ordersByPhone.get(customer.phone) || [];
      // Cancelled orders never billed anything - excluded from the money
      // totals, but still listed in the order history below for context.
      const billable = customerOrders.filter((order) => order.status !== "cancelled");

      // Always computed from EVERY order this customer has ever placed,
      // never scoped to the picked report range - see this function's own
      // header comment for why.
      const totalOrderBalance = billable.reduce((sum, order) => {
        const remaining = typeof order.remainingAmount === "number"
          ? order.remainingAmount
          : Math.max((order.total || 0) - (order.paidAmount || 0), 0);
        return sum + remaining;
      }, 0);
      const previousDues = Number(customer.previousDues || 0);

      // Everything else below (orderCount, totalBilled, totalPaid,
      // lastOrderAt, the `orders` list itself) IS scoped to the picked
      // range when one was given - this is "what happened in this
      // period", the actual report content.
      const periodOrders = rangeStart
        ? customerOrders.filter((order) => {
            const createdAt = new Date(order.createdAt);
            return createdAt >= rangeStart && createdAt <= rangeEnd;
          })
        : customerOrders;
      const periodBillable = periodOrders.filter((order) => order.status !== "cancelled");
      const totalBilled = periodBillable.reduce((sum, order) => sum + (order.total || 0), 0);
      const totalPaid = periodBillable.reduce((sum, order) => sum + (order.paidAmount || 0), 0);

      // Unified Khata / Customer-Supplier Netting: exact same "current
      // balance (all-time) vs period activity" split as totalOrderBalance/
      // orders above, just for this contact's PURCHASE side instead of
      // their sales side.
      const customerPurchases = purchasesByCustomerId.get(String(customer._id)) || [];
      // Balance math only ever counts status:"received" lines - a
      // cancelled purchase never really happened as far as money/stock are
      // concerned, exactly like a cancelled Order never counts toward
      // totalOrderBalance above (see `billable` a few lines up).
      const receivedCustomerPurchases = customerPurchases.filter((p) => p.status === "received");
      const totalPurchaseBalance = receivedCustomerPurchases.reduce((sum, p) => sum + (p.remainingAmount || 0), 0);
      const periodPurchases = rangeStart
        ? customerPurchases.filter((p) => {
            const purchaseDate = new Date(p.purchaseDate);
            return purchaseDate >= rangeStart && purchaseDate <= rangeEnd;
          })
        : customerPurchases;

      const totalDue = totalOrderBalance + previousDues;
      // The netting itself: `totalDue` (this contact's real, all-time
      // sales-side balance - unchanged in meaning, still exactly what it
      // was before this feature) minus `totalPurchaseBalance` (their real,
      // all-time purchase-side balance). Both sides stay independently
      // correct and auditable - this is a read-time computed VIEW, never
      // written back into either Customer.previousDues/duesHistory or any
      // Order/IngredientPurchase document. Positive = the contact still
      // owes the shop; negative = the shop owes the contact.
      //
      // Worked examples (see the feature spec this implements):
      //   totalDue=50000, totalPurchaseBalance=40000 -> netBalance=+10000
      //   totalDue=50000, totalPurchaseBalance=70000 -> netBalance=-20000
      //   totalDue=30000, totalPurchaseBalance=20000 -> netBalance=+10000
      const netBalance = totalDue - totalPurchaseBalance;

      return {
        id: String(customer._id),
        name: customer.name,
        phone: customer.phone,
        address: customer.address || "",
        previousDues,
        orderCount: periodOrders.length,
        totalBilled,
        totalPaid,
        totalOrderBalance,
        totalDue,
        totalPurchaseBalance,
        netBalance,
        lastOrderAt: periodOrders[0]?.createdAt || null,
        // Manual add/settle entries (with whatever note the cashier typed)
        // - newest first. Merged client-side (DuesPage.tsx's History
        // dropdown) with the `orders` array below, which already carries
        // its own per-order trail (dailyOrderNumber, total, paid,
        // remaining) - so between the two, every rupee that makes up
        // totalDue traces back to either a note or an order number. Not
        // range-scoped, same reasoning as totalOrderBalance/totalDue above.
        duesHistory: (customer.duesHistory || [])
          .slice()
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .map((entry) => ({
            type: entry.type,
            amount: entry.amount,
            note: entry.note || "",
            balanceAfter: entry.balanceAfter,
            createdBy: entry.createdBy || "",
            createdAt: entry.createdAt,
            paymentMethod: entry.paymentMethod || "cash",
            bankName: entry.bankName || "",
          })),
        orders: periodOrders.map((order) => ({
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
          // Electricity Bill / Cash special-product details - see
          // backend/models/Order.js's own comment. DuesPage.tsx's History
          // dropdown shows these on the matching order entry.
          billTid: order.billTid || "",
          billName: order.billName || "",
          cashRecipientName: order.cashRecipientName || "",
        })),
        // Unified Khata: this contact's linked purchases, period-scoped the
        // same way `orders` above is - DuesPage.tsx merges these into the
        // same chronological History timeline as orders/duesHistory, tagged
        // distinctly (a purchase, not a sale) so it's always clear which
        // side of the net balance each row belongs to.
        purchases: periodPurchases.map((purchase) => ({
          id: String(purchase._id),
          purchaseOrderNumber: purchase.purchaseOrderNumber,
          ingredientName: purchase.ingredientName,
          quantity: purchase.quantity,
          unit: purchase.unit,
          totalAmount: purchase.totalAmount || 0,
          paidAmount: purchase.paidAmount || 0,
          remainingAmount: purchase.remainingAmount || 0,
          purchaseDate: purchase.purchaseDate,
          // Audit trail (Unified Khata purchase cancellation): DuesPage.tsx's
          // History timeline uses these to render a cancelled purchase as a
          // distinct "Cancelled" row (with who cancelled it and why) instead
          // of it just disappearing once cancelPurchase flips its status.
          status: purchase.status,
          cancelledAt: purchase.cancelledAt || null,
          cancelledBy: purchase.cancelledBy || "",
          cancelReason: purchase.cancelReason || "",
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

// PATCH /api/customers/dues/:phone  body: { previousDues, note?, paymentMethod?, bankId? }
// `previousDues` is still the new TOTAL lump-sum figure (not a delta) -
// kept exactly as before so pos-mobile's DuesScreen (which also calls this
// same endpoint) keeps working unchanged. The note - and the history entry
// recording this change - are new and optional: if the caller doesn't send
// a note, this behaves identically to before. The delta (new total minus
// whatever it was) is what actually gets recorded as the entry's `amount`
// so "+Rs 500 (note)" in the History dropdown always matches what really
// changed, not just whatever number happened to be typed into the field.
//
// paymentMethod/bankId are new: this endpoint is only ever called from
// "+ Add Dues" (DuesPage.tsx), which is the shop CHARGING the customer -
// giving them something (an advance, credit for a purchase not tied to an
// order) rather than collecting anything. When that credit was actually
// handed over via bank transfer instead of cash-in-hand, the picked
// bank's own balance needs to go DOWN by the same amount - see
// bankController.recordCustomerBankMovement. A plain cash entry (the
// default, and the only option before this) never touches any Bank
// document, exactly as before.
// Shared by the normal PATCH /dues/:phone route and
// importOfflineCustomerActions below (Offline Mode's queued "+ Add Dues"
// replay) - both apply the exact same lump-sum-dues move for a given
// phone, just called with a real req vs. a queued action's own payload.
async function applyUpdateCustomerDues(scope, phone, body, createdBy) {
  const nextPreviousDues = Number(body.previousDues || 0);
  const note = String(body.note || "").trim();
  const paymentMethod = ["bank", "grain", "labour", "munshi"].includes(body.paymentMethod) ? body.paymentMethod : "cash";
  const bankId = body.bankId ? String(body.bankId) : "";
  const grainId = body.grainId ? String(body.grainId) : "";
  const grainKg = Math.max(Number(body.grainKg) || 0, 0);

  const customer = await Customer.findOne({ phone, ...scope });
  if (!customer) {
    throw Object.assign(new Error("Customer not found"), { statusCode: 404 });
  }

  const delta = nextPreviousDues - Number(customer.previousDues || 0);
  customer.previousDues = nextPreviousDues;

  // Move the bank's own money FIRST (if applicable) so its real name is
  // known before building the duesHistory entry below - recordCustomerBankMovement
  // returns null (a silent no-op on the bank side) if the id doesn't
  // resolve, in which case this just falls back to recording a plain cash
  // entry rather than failing the whole "+ Add Dues" action.
  let bank = null;
  if (paymentMethod === "bank" && bankId && delta > 0) {
    bank = await recordCustomerBankMovement({
      bankId,
      shopId: scope.shopId,
      type: "withdrawal",
      amount: delta,
      note,
      customerName: customer.name,
      customerPhone: customer.phone,
      createdBy,
    });
  }

  // Same idea, but for grain stock - the shop handing a customer credit
  // "via Grain Stock" means grain (kg + its rupee value) leaves that
  // grain's own balance instead of Cash in Hand - see
  // grainController.recordCustomerGrainMovement.
  let grain = null;
  if (paymentMethod === "grain" && grainId && delta > 0) {
    grain = await recordCustomerGrainMovement({
      grainId,
      shopId: scope.shopId,
      type: "withdrawal",
      kg: grainKg,
      amount: delta,
      note,
      customerName: customer.name,
      customerPhone: customer.phone,
      createdBy,
    });
  }

  // Labour/Munshi are different from Bank/Grain Stock above - they don't
  // replace Cash in Hand, they track ON TOP of it. A "+ Add Dues" made
  // "via Labour"/"via Munshi" is still real cash physically handed to the
  // customer (so Cash in Hand still goes down below, same as plain Cash),
  // but it's ALSO recorded as money that came out of that labour/munshi
  // khata specifically, for the owner's own bookkeeping of what's been
  // spent through each. See labourController.recordCustomerLabourMovement/
  // munshiController.recordCustomerMunshiMovement.
  if (paymentMethod === "labour" && delta > 0) {
    await recordCustomerLabourMovement({
      shopId: scope.shopId,
      type: "due_given",
      direction: "out",
      amount: delta,
      note,
      customerName: customer.name,
      customerPhone: customer.phone,
      createdBy,
    });
  }
  if (paymentMethod === "munshi" && delta > 0) {
    await recordCustomerMunshiMovement({
      shopId: scope.shopId,
      type: "due_given",
      direction: "out",
      amount: delta,
      note,
      customerName: customer.name,
      customerPhone: customer.phone,
      createdBy,
    });
  }

  // Cash in Hand (Dashboard): a Cash/Labour/Munshi-method "+ Add Dues" is
  // the shop physically handing the customer an advance/credit - real cash
  // leaving the till right now, the mirror image of settleCustomerDues's
  // due_recovery below. Only when it wasn't already a bank withdrawal or a
  // grain withdrawal above (those move their own balance INSTEAD of Cash
  // in Hand - Labour/Munshi move it ON TOP of Cash in Hand, see their own
  // comment above, so cash still moves for them too).
  if (!bank && !grain && delta > 0) {
    await recordCashMovement({
      shopId: scope.shopId,
      type: "due_given",
      direction: "out",
      amount: delta,
      note: note || `Advance/credit given - ${customer.name || customer.phone}`,
      relatedCustomerName: customer.name,
      relatedCustomerPhone: customer.phone,
      createdBy,
    });
  }

  // Zero-delta manual "saves" (e.g. re-submitting the same figure) aren't
  // worth a history row - only a real change is.
  if (delta !== 0) {
    customer.duesHistory.push({
      type: delta > 0 ? "add" : "settle",
      amount: Math.abs(delta),
      note,
      balanceAfter: nextPreviousDues,
      createdBy,
      paymentMethod: bank ? "bank" : grain ? "grain" : paymentMethod === "labour" ? "labour" : paymentMethod === "munshi" ? "munshi" : "cash",
      bankName: bank?.name || "",
      grainName: grain?.name || "",
      grainKg: grain ? grainKg : 0,
    });
  }
  await customer.save();
  return customer;
}

exports.updateCustomerDues = async (req, res) => {
  try {
    const scope = shopScope(req);
    const createdBy = await currentUserName(req);
    const customer = await applyUpdateCustomerDues(scope, req.params.phone, req.body, createdBy);
    res.json(serializeCustomer(customer));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// POST /api/customers/:phone/settle-dues  body: { amount, note?, paymentMethod?, bankId? }
// A real payment collected from the customer - "- Pay Dues"/"Clear" on
// DuesPage.tsx. This is a pure manual-ledger move: it only ever adjusts
// the lump-sum previousDues, by the full amount typed, and NEVER reaches
// into this customer's Orders any more (an order's own paidAmount/
// remainingAmount only ever changes through completing that specific
// order - SalesPage/POSPage's Complete Payment flow - never from here).
// previousDues can go negative as a result - that's a genuine advance/
// credit (the customer has paid the shop more than the manual side of
// what they currently owe), same idea as a bank account going into
// credit. It nets against any real unpaid-order balance in totalDue
// (see getCustomerLedger) without ever touching those Order documents
// directly, so a customer's `+Rs 3224` / `-Rs 688` Dues Statement balance
// always exactly matches Current Dues on the very last row - no separate
// "applied to orders" bookkeeping to keep in sync with it.
//
// paymentMethod/bankId: when this payment actually arrived via bank
// transfer rather than cash-in-hand, the picked bank's own balance goes UP
// by the same amount - see bankController.recordCustomerBankMovement.
// Shared by the normal POST /:phone/settle-dues route and
// importOfflineCustomerActions below (Offline Mode's queued "- Pay Dues"/
// "Clear" replay).
async function applySettleCustomerDues(scope, phone, body, createdBy) {
  const amount = Math.max(Number(body.amount) || 0, 0);
  const note = String(body.note || "").trim();
  const paymentMethod = ["bank", "grain", "labour", "munshi"].includes(body.paymentMethod) ? body.paymentMethod : "cash";
  const bankId = body.bankId ? String(body.bankId) : "";
  const grainId = body.grainId ? String(body.grainId) : "";
  const grainKg = Math.max(Number(body.grainKg) || 0, 0);
  if (amount <= 0) {
    throw Object.assign(new Error("amount must be greater than 0"), { statusCode: 400 });
  }

  const customer = await Customer.findOne({ phone, ...scope });
  if (!customer) {
    throw Object.assign(new Error("Customer not found"), { statusCode: 404 });
  }

  const previousDues = Number(customer.previousDues || 0) - amount;
  customer.previousDues = previousDues;

  // Move the bank's own money FIRST (if applicable) so its real name is
  // known before building the duesHistory entry below - see
  // applyUpdateCustomerDues's own comment on the same ordering.
  let bank = null;
  if (paymentMethod === "bank" && bankId) {
    bank = await recordCustomerBankMovement({
      bankId,
      shopId: scope.shopId,
      type: "deposit",
      amount,
      note,
      customerName: customer.name,
      customerPhone: customer.phone,
      createdBy,
    });
  }

  // Same idea, but for grain stock - a customer paying dues "via Grain
  // Stock" means the grain they handed over (kg + its rupee value) adds
  // onto that grain's own balance instead of Cash in Hand - see
  // grainController.recordCustomerGrainMovement.
  let grain = null;
  if (paymentMethod === "grain" && grainId) {
    grain = await recordCustomerGrainMovement({
      grainId,
      shopId: scope.shopId,
      type: "deposit",
      kg: grainKg,
      amount,
      note,
      customerName: customer.name,
      customerPhone: customer.phone,
      createdBy,
    });
  }

  // Labour/Munshi - a customer paying dues "via Labour"/"via Munshi" is
  // still real cash landing at the till (so Cash in Hand still goes up
  // below, same as plain Cash), but it's ALSO recorded as money collected
  // through that labour/munshi khata specifically - see
  // applyUpdateCustomerDues's own comment on why these two are additive
  // tracking on top of cash rather than a replacement for it.
  if (paymentMethod === "labour") {
    await recordCustomerLabourMovement({
      shopId: scope.shopId,
      type: "due_recovery",
      direction: "in",
      amount,
      note,
      customerName: customer.name,
      customerPhone: customer.phone,
      createdBy,
    });
  }
  if (paymentMethod === "munshi") {
    await recordCustomerMunshiMovement({
      shopId: scope.shopId,
      type: "due_recovery",
      direction: "in",
      amount,
      note,
      customerName: customer.name,
      customerPhone: customer.phone,
      createdBy,
    });
  }

  // Total Recovery / Cash in Hand (Dashboard): a Cash/Labour/Munshi-method
  // "Pay Dues" is real cash landing at the till right now, same as a
  // Cash-method order payment (orderController.js's own completeAndSettle
  // branch) - recorded here so the Dashboard's Cash in Hand figure and
  // today's Total Recovery both reflect it. Only when the money did NOT
  // already go into a bank or grain stock above (those move their own
  // balance INSTEAD of Cash in Hand - Labour/Munshi move it ON TOP of Cash
  // in Hand, see their own comment above, so cash still moves for them
  // too).
  if (!bank && !grain) {
    await recordCashMovement({
      shopId: scope.shopId,
      type: "due_recovery",
      direction: "in",
      amount,
      note: note || `Due payment - ${customer.name || customer.phone}`,
      relatedCustomerName: customer.name,
      relatedCustomerPhone: customer.phone,
      createdBy,
    });
  }

  customer.duesHistory.push({
    type: "settle",
    amount,
    note,
    balanceAfter: previousDues,
    createdBy,
    paymentMethod: bank ? "bank" : grain ? "grain" : paymentMethod === "labour" ? "labour" : paymentMethod === "munshi" ? "munshi" : "cash",
    bankName: bank?.name || "",
    grainName: grain?.name || "",
    grainKg: grain ? grainKg : 0,
  });

  await customer.save();
  return amount;
}

exports.settleCustomerDues = async (req, res) => {
  try {
    const scope = shopScope(req);
    const createdBy = await currentUserName(req);
    const amount = await applySettleCustomerDues(scope, req.params.phone, req.body, createdBy);
    // appliedAmount is always the full amount now (nothing left
    // "unapplied") - kept in the response shape so the frontend's existing
    // `result.appliedAmount` toast keeps working unchanged.
    res.json({ appliedAmount: amount, unapplied: 0 });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// DELETE /api/customers/:phone/dues-history  body: { createdAt, amount, type }
// Deletes ONE manual "+ Add Dues" / "- Pay Dues" entry from Customer Dues
// page's History timeline (updateCustomerDues/settleCustomerDues above are
// the only two places that ever push one). duesHistorySchema deliberately
// has no _id (see Customer.js), so the entry to remove is identified by
// its own (createdAt, amount, type) triple instead - for one shop's
// single-cashier-at-a-time usage this is unambiguous in practice, and it
// is still verified against the live document (not trusted blindly from
// the client) before anything is touched.
//
// Deleting the entry must undo exactly what creating it did:
//  - a plain "add"/"settle" from updateCustomerDues only ever moved the
//    manual previousDues lump sum, so undoing it is just the inverse move.
//  - a "settle" from settleCustomerDues can have paid down real Orders
//    too (recorded in its own note as "Applied to orders: #12 (Rs 300)") -
//    those specific orders' paidAmount/remainingAmount/status are reversed
//    the same way a payment applied them, and only the leftover portion
//    (if any) is put back onto previousDues. An order that was separately
//    cancelled since is left alone rather than reopened.
exports.deleteDuesHistoryEntry = async (req, res) => {
  try {
    const { phone } = req.params;
    const { createdAt, amount, type } = req.body || {};
    const targetAmount = Number(amount);
    if (!createdAt || !Number.isFinite(targetAmount) || !["add", "settle"].includes(type)) {
      return res.status(400).json({ message: "createdAt, amount and type are required" });
    }

    const customer = await Customer.findOne({ phone, ...shopScope(req) });
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const targetTime = new Date(createdAt).getTime();
    const index = customer.duesHistory.findIndex((entry) => {
      const entryTime = entry.createdAt ? new Date(entry.createdAt).getTime() : NaN;
      return entryTime === targetTime && Number(entry.amount) === targetAmount && entry.type === type;
    });
    if (index === -1) {
      return res.status(404).json({ message: "This dues history entry could not be found - it may have already been removed." });
    }

    const entry = customer.duesHistory[index];

    // Reverse any order payments this "settle" entry's note says it made.
    let orderPortion = 0;
    const orderRefs = [...String(entry.note || "").matchAll(/#(\S+)\s*\(Rs\s*([\d.]+)\)/g)];
    for (const match of orderRefs) {
      const dailyOrderNumber = Number(match[1]);
      const appliedAmount = Number(match[2]);
      if (!Number.isFinite(dailyOrderNumber) || !Number.isFinite(appliedAmount) || appliedAmount <= 0) continue;
      const order = await Order.findOne({ dailyOrderNumber, "customer.phone": phone, ...shopScope(req) });
      if (!order || order.status === "cancelled") continue;
      const revert = Math.min(appliedAmount, Number(order.paidAmount || 0));
      order.paidAmount = Number(order.paidAmount || 0) - revert;
      order.remainingAmount = Number(order.remainingAmount || 0) + revert;
      if (order.status === "completed" && order.remainingAmount > 0) order.status = "pending";
      order.version = Number(order.version || 0) + 1;
      await order.save();
      orderPortion += revert;
    }

    // No longer floored at 0 - previousDues itself isn't any more (see
    // Customer.js), so undoing an "add" can legitimately take it negative
    // if other activity since has already put this customer in credit.
    const previousDuesPortion = Number(entry.amount) - orderPortion;
    let nextPreviousDues = Number(customer.previousDues || 0);
    nextPreviousDues = entry.type === "add" ? nextPreviousDues - previousDuesPortion : nextPreviousDues + previousDuesPortion;

    customer.previousDues = nextPreviousDues;
    customer.duesHistory.splice(index, 1);
    await customer.save();

    res.json({ success: true, previousDues: nextPreviousDues });
  } catch (error) {
    res.status(500).json({ message: "Could not delete this dues history entry.", detail: error.message });
  }
};

// POST /api/customers/import-offline-actions  body: { actions: [...] }
// Offline Mode's queued Customer-Dues writes (Add Customer / + Add Dues /
// - Pay Dues made while the till had no internet, or net was too slow -
// see src/lib/offline-dues-helpers.ts on the frontend), replayed here once
// connectivity returns. Each action carries its own clientActionId (a
// locally-generated id, not a Mongo _id) purely so the frontend can match
// each result back to the queued item it came from and ack/drop only
// that one - the whole batch never fails as a unit just because one
// action in it did (e.g. a customer that was already created from
// another device before this one got back online).
exports.importOfflineCustomerActions = async (req, res) => {
  try {
    const scope = shopScope(req);
    const createdBy = await currentUserName(req);
    const actions = Array.isArray(req.body.actions) ? req.body.actions : [];
    const results = [];
    for (const action of actions) {
      const clientActionId = action.clientActionId;
      try {
        if (action.kind === "create") {
          const customer = await applyCreateCustomer(scope.shopId, {
            name: action.name,
            phone: action.phone,
            address: action.address,
            previousDues: action.previousDues,
          });
          results.push({ clientActionId, success: true, customer: serializeCustomer(customer) });
        } else if (action.kind === "add_due") {
          const customer = await applyUpdateCustomerDues(scope, action.phone, action, createdBy);
          results.push({ clientActionId, success: true, customer: serializeCustomer(customer) });
        } else if (action.kind === "settle_due") {
          const amount = await applySettleCustomerDues(scope, action.phone, action, createdBy);
          results.push({ clientActionId, success: true, appliedAmount: amount });
        } else {
          results.push({ clientActionId, success: false, error: "Unknown offline action kind" });
        }
      } catch (error) {
        // Per-action failure (e.g. a duplicate phone on "create", or the
        // customer having since been removed) - reported individually so
        // one bad queued item never blocks every other one behind it.
        results.push({ clientActionId, success: false, error: error.message, code: error.code });
      }
    }
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
