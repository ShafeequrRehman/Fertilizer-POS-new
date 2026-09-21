const mongoose = require("mongoose");
const IngredientPurchase = require("../models/IngredientPurchase");
const Ingredient = require("../models/Ingredient");
const Shop = require("../models/Shop");
const Customer = require("../models/Customer");
const User = require("../models/User");
const { shopScope } = require("../middleware/attachShopScope");
const { toMilliUnits, fromMilliUnits } = require("../config/ingredientUnits");
const { reverseIngredientReceipt } = require("../services/stockService");

// Unified Khata: resolves an optional `customerId` from a purchase request
// body into that Customer's own document (just id/name - all that's needed
// here), scoped to this shop so one shop can never link a purchase to
// another shop's customer. Deliberately non-fatal, same "an optional
// lookup failing should never take down the whole request" rule
// orderController.createOrder's own customer-sync try/catch already
// follows - an invalid/missing/cross-shop id just means this purchase
// isn't linked to a Khata contact, not a 500.
async function resolveLinkedCustomer(customerId, req) {
  if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) return null;
  try {
    return await Customer.findOne({ _id: customerId, ...shopScope(req) }).select("name").lean();
  } catch {
    return null;
  }
}

// Formats a shop's permanent purchaseOrderSequenceCounter into the
// human-readable invoice number every logged batch gets ("PO-000123") -
// Task 2's "handle it exactly like an invoice system: auto-generate a
// unique Purchase Order Number". Zero-padded to 6 digits purely for a
// clean, consistent look on a receipt/sheet - the counter itself is never
// reset and keeps counting past 999999 with a wider (still unique, just
// unpadded) number rather than ever wrapping or colliding.
function formatPurchaseOrderNumber(sequence) {
  return `PO-${String(sequence).padStart(6, "0")}`;
}

// Atomically reserves the next Purchase Order Number off the shop's own
// never-resetting counter - same $inc-then-read pattern used by both
// createPurchase (one number per single-line legacy batch) and
// createPurchaseOrder below (one number shared by every line of a
// multi-item order), factored out so both stay byte-for-byte consistent.
async function reservePurchaseOrderNumber(shopId) {
  const updatedShop = await Shop.findOneAndUpdate(
    { _id: shopId },
    { $inc: { purchaseOrderSequenceCounter: 1 } },
    { new: true }
  );
  return formatPurchaseOrderNumber(updatedShop ? updatedShop.purchaseOrderSequenceCounter : 1);
}

// Weighted-average cost: folds one batch's rate into an ingredient's
// currentStock/averageCost proportionally to how much of the NEW total
// stock it represents. Shared by createPurchase (immediate) and
// receivePurchaseOrder below (deferred until physical delivery) so both
// apply the exact same math - see createPurchase's own comment for the
// full reasoning. Mutates and saves the ingredient in place; does not
// create/save any purchase document itself.
async function applyPurchaseToIngredientStock(ingredient, qty, purchaseRate) {
  const oldStock = Number(ingredient.currentStock || 0);
  const oldAverage = Number(ingredient.averageCost || 0);
  // Safe Math Addition Logic (floating-point round-off fix) - same
  // integer-milli-unit round-trip as stockService.js's
  // deductStockForItems/restoreStockForOrder (see ingredientUnits.js's own
  // comment), so a purchase batch folding into currentStock can't
  // reintroduce the same drift on the "stock coming IN" side.
  const newStock = fromMilliUnits(toMilliUnits(oldStock) + toMilliUnits(qty));
  ingredient.averageCost = newStock > 0 ? (oldStock * oldAverage + qty * purchaseRate) / newStock : purchaseRate;
  ingredient.currentStock = newStock;
  await ingredient.save();
}

// GET /api/ingredient-purchases?ingredientId=&startDate=&endDate=&status=
// startDate/endDate are optional plain YYYY-MM-DD strings - same format/
// parsing convention as customerController.getCustomerLedger's own Date
// Range picker, so the frontend can reuse one date-range component for
// both without a different payload shape to remember. `status` (optional,
// "pending" or "received") is the Purchase page's Dual-Status filter - the
// Purchase Log groups these flat line-item rows by purchaseOrderNumber
// client-side (see PurchasePage.tsx), so no separate grouped endpoint is
// needed just to support that view.
exports.getPurchases = async (req, res) => {
  const { ingredientId, supplierId, startDate, endDate, status } = req.query;
  const query = { ...shopScope(req) };
  if (ingredientId) query.ingredientId = ingredientId;
  // Per-Supplier Dashboard: lets the Purchase page fetch one Supplier
  // Company's full purchase history (its own independent date range, not
  // the main page's) without needing a dedicated endpoint - same optional-
  // filter pattern as ingredientId/status right above.
  if (supplierId && mongoose.Types.ObjectId.isValid(supplierId)) query.supplierId = supplierId;
  if (status === "pending" || status === "received") query.status = status;
  if (startDate && endDate) {
    const rangeStart = new Date(`${startDate}T00:00:00.000Z`);
    const rangeEnd = new Date(`${endDate}T23:59:59.999Z`);
    if (!Number.isNaN(rangeStart.getTime()) && !Number.isNaN(rangeEnd.getTime())) {
      query.purchaseDate = { $gte: rangeStart, $lte: rangeEnd };
    }
  }
  const purchases = await IngredientPurchase.find(query).sort({ purchaseDate: -1 }).lean();
  res.json(purchases);
};

exports.getPurchase = async (req, res) => {
  const purchase = await IngredientPurchase.findOne({ _id: req.params.id, ...shopScope(req) }).lean();
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });
  res.json(purchase);
};

// POST /api/ingredient-purchases
// body: { ingredientId, quantity, rate, paidAmount?, companyName?, productDetails?, supplierId?, purchaseDate?, note? }
// Task 1: records one incoming batch, applies it to the ingredient's stock,
// and folds its rate into the ingredient's moving-average cost - the three
// things that must always happen together, atomically, whenever a batch is
// logged. `totalAmount`/`remainingAmount` are always SERVER-computed
// (quantity*rate, and totalAmount-paidAmount) - never trusted from the
// client, same "recompute the derived numbers" rule
// orderController.recalculateTotals already follows for order totals.
//
// Dual-Status Stock Inventory Workflow: this is the LEGACY single-batch
// "Log Purchase" entry point (Ingredient Stock page - see
// IngredientStockSection.tsx), whose whole existing UX model is "I already
// have this stock in hand, I'm recording it right now" - unlike the newer
// Purchase page's createPurchaseOrder/receivePurchaseOrder below, there was
// never a "still waiting on delivery" phase here to begin with. So this
// path is always created (and stays) status:"received" with receivedAt set
// immediately - preserving its exact original behavior (stock/averageCost
// updated the instant it's logged) rather than silently starting these
// batches as "pending" and leaving them stuck there with no UI that ever
// marks a single-line legacy purchase "received".
exports.createPurchase = async (req, res) => {
  try {
    const { ingredientId, quantity, rate, paidAmount, companyName, productDetails, supplierId, purchaseDate, note, customerId } = req.body || {};

    if (!ingredientId || !mongoose.Types.ObjectId.isValid(ingredientId)) {
      return res.status(400).json({ error: "A valid ingredient is required." });
    }
    const qty = Number(quantity);
    const purchaseRate = Number(rate);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "Quantity must be greater than 0." });
    }
    if (!Number.isFinite(purchaseRate) || purchaseRate < 0) {
      return res.status(400).json({ error: "Purchase rate is required." });
    }

    const ingredient = await Ingredient.findOne({ _id: ingredientId, ...shopScope(req) });
    if (!ingredient) {
      return res.status(404).json({ error: "Ingredient not found" });
    }

    const totalAmount = Math.round(qty * purchaseRate * 100) / 100;
    // Correct Payment & Dues Logic (this is the ONE place a batch's
    // paid/due split is ever computed): `paid` is always what the Stock
    // Manager actually paid the supplier right now - clamped to the
    // total's own range so it can never go negative or exceed the bill -
    // and `remaining` (this company's Due/Udhaar on this batch) is always
    // exactly `totalAmount - paid`, never a separately-trusted number of
    // its own. A Full Payment (frontend sends paidAmount === totalAmount)
    // always lands remaining at strictly 0 this way; anything less always
    // leaves the true difference as Due, which getCompanyLedger below
    // rolls into that company's credit-ledger balance automatically.
    const paid = Math.min(Math.max(Number(paidAmount) || 0, 0), totalAmount);
    const remaining = Math.max(totalAmount - paid, 0);

    // Purchase Order Number: a permanent, never-reused invoice number for
    // this exact batch, atomically reserved off the shop's own counter -
    // same $inc-then-read pattern as orderController.js's
    // shopSequenceNumber, just its own separate sequence (a purchase order
    // and a sales order must never share one). This create path is always
    // online (the Stock Manager's ingredient-purchase requests never queue
    // through the offline Local Hub the way POS orders do), so there's no
    // "a number was already reserved offline" case to reconcile here.
    const purchaseOrderNumber = await reservePurchaseOrderNumber(req.user.shopId);

    // Unified Khata: when this batch is linked to an existing Khata
    // contact, that contact's own name is what should show wherever
    // companyName is already displayed (Purchase Log rows, exports, etc.)
    // - overriding whatever free-text companyName was also sent, so the two
    // never silently disagree about who this purchase was really from.
    const linkedCustomer = await resolveLinkedCustomer(customerId, req);

    const purchase = await IngredientPurchase.create({
      purchaseOrderNumber,
      ingredientId: ingredient._id,
      ingredientName: ingredient.name,
      unit: ingredient.unit,
      supplierId: supplierId || null,
      linkedCustomerId: linkedCustomer ? linkedCustomer._id : null,
      companyName: linkedCustomer ? linkedCustomer.name : (companyName || "").trim(),
      productDetails: (productDetails || "").trim(),
      quantity: qty,
      rate: purchaseRate,
      totalAmount,
      paidAmount: paid,
      remainingAmount: remaining,
      purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
      status: "received",
      receivedAt: new Date(),
      receivedBy: req.user.id,
      note: note || "",
      shopId: req.user.shopId,
      recordedBy: req.user.id,
    });

    // Weighted-average cost: fold this batch's rate in proportionally to
    // how much of the NEW total stock it represents. If there was nothing
    // on the shelf before this batch (or the ingredient never had a cost
    // recorded), the average is simply this batch's own rate - there's
    // nothing to average against yet.
    await applyPurchaseToIngredientStock(ingredient, qty, purchaseRate);

    // Returns both the new purchase record AND the now-updated ingredient
    // (new currentStock/averageCost) in one response - saves the frontend
    // a second round-trip (or worse, re-deriving the same average-cost math
    // itself, which would risk drifting out of sync with this function).
    res.status(201).json({ purchase, ingredient });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /api/ingredient-purchases/orders
// body: { companyName?, supplierId?, purchaseDate?, note?, items: [{ ingredientId, quantity, productDetails? }] }
//
// Rate-Less Order Placement redesign, Phase 1 (Order Placed): the Purchase
// page's "New Purchase Order" now only asks for a Supplier Company and one
// or more ingredient lines - Ingredient + Quantity, nothing else. No price
// is known (or asked for) at this point at all - the manager is simply
// raising a demand requirement sheet to send to the supplier, not billing
// anything yet. `rate`/`totalAmount` are left at their schema defaults (0)
// on every line; the actual supplier rate is only entered once physically
// received (see receivePurchaseOrder below, Phase 2's real billing screen).
// Every line still shares ONE auto-generated purchaseOrderNumber (a real
// multi-item invoice, not several unrelated single-item ones), and every
// line is created status:"pending" - deliberately NOT folded into
// Ingredient.currentStock/averageCost yet, and with paidAmount:0 - nothing
// has been paid because nothing has been billed or delivered.
exports.createPurchaseOrder = async (req, res) => {
  try {
    const { companyName, supplierId, purchaseDate, note, items, customerId } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one item is required." });
    }

    // Validate every line BEFORE reserving a PO number or writing anything -
    // a rejected request should never burn a purchase order number or leave
    // a partial order behind.
    const normalizedLines = [];
    for (const item of items) {
      const { ingredientId, quantity, productDetails } = item || {};
      if (!ingredientId || !mongoose.Types.ObjectId.isValid(ingredientId)) {
        return res.status(400).json({ error: "Every item needs a valid ingredient." });
      }
      const qty = Number(quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: "Every item's quantity must be greater than 0." });
      }
      normalizedLines.push({ ingredientId, qty, productDetails: (productDetails || "").trim() });
    }

    const ingredientIds = normalizedLines.map((line) => line.ingredientId);
    const ingredients = await Ingredient.find({ _id: { $in: ingredientIds }, ...shopScope(req) }).select("name unit").lean();
    const ingredientById = new Map(ingredients.map((ing) => [String(ing._id), ing]));
    for (const line of normalizedLines) {
      if (!ingredientById.has(String(line.ingredientId))) {
        return res.status(404).json({ error: "One or more ingredients on this order could not be found." });
      }
    }

    const purchaseOrderNumber = await reservePurchaseOrderNumber(req.user.shopId);
    const sharedPurchaseDate = purchaseDate ? new Date(purchaseDate) : new Date();

    // Unified Khata: resolved once and shared across every line of this
    // order - see createPurchase's own comment on why companyName is
    // overridden from the linked contact's name when one is set. Set here
    // at Phase 1 (Order Placed) so it survives all the way through
    // Phase 2 (receivePurchaseOrder below only flips status/rate/paid
    // fields on the already-existing lines - it never touches or drops
    // linkedCustomerId).
    const linkedCustomer = await resolveLinkedCustomer(customerId, req);

    const docs = normalizedLines.map((line) => {
      const ingredient = ingredientById.get(String(line.ingredientId));
      return {
        purchaseOrderNumber,
        ingredientId: line.ingredientId,
        ingredientName: ingredient.name,
        unit: ingredient.unit,
        supplierId: supplierId || null,
        linkedCustomerId: linkedCustomer ? linkedCustomer._id : null,
        companyName: linkedCustomer ? linkedCustomer.name : (companyName || "").trim(),
        productDetails: line.productDetails,
        quantity: line.qty,
        // Rate-Less Phase 1: no price known yet - schema defaults (0) apply.
        rate: 0,
        totalAmount: 0,
        paidAmount: 0,
        remainingAmount: 0,
        purchaseDate: sharedPurchaseDate,
        status: "pending",
        receivedAt: null,
        note: note || "",
        shopId: req.user.shopId,
        recordedBy: req.user.id,
      };
    });

    const created = await IngredientPurchase.insertMany(docs);
    res.status(201).json({ purchaseOrderNumber, lines: created });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PATCH /api/ingredient-purchases/orders/:purchaseOrderNumber/receive
// body: { items: [{ purchaseId, rate }], paidAmount }
//
// Phase 2 (Delivery Fulfillment & Billing) redesign: the physical delivery
// has arrived and this IS the billing screen - unlike the old flow, no rate
// was ever entered at creation time (Phase 1 is rate-less), so the manager
// enters the Actual Supplier Rate for EACH delivered line right here, right
// now. `items` carries one { purchaseId, rate } pair per line of this order
// (purchaseId = that IngredientPurchase line's own _id) - every pending
// line of the order must be represented or the request is rejected, since a
// partially-priced order can't be billed. totalAmount for each line is
// computed fresh from qty * this newly-entered rate (never trusted from the
// client), and the order's own grand total is only known AFTER that -
// mirroring createPurchase's "server recomputes the derived numbers" rule
// just deferred until now.
//
// `paidAmount` is still the TOTAL paid for the WHOLE order right now, not
// per line - a Full Payment (paidAmount === the freshly-computed order
// total) or a Partial one (anything less, the difference routed to the
// company's Dues) - split proportionally across lines by each line's own
// share of that order total, with the LAST line absorbing whatever rounding
// remainder is left so the lines' paidAmount always sums to EXACTLY the
// entered figure. Only once that split is decided does each line actually
// fold into its own ingredient's currentStock/averageCost
// (applyPurchaseToIngredientStock, fed the newly-entered rate) and flip to
// status:"received".
exports.receivePurchaseOrder = async (req, res) => {
  try {
    const { purchaseOrderNumber } = req.params;
    const { items } = req.body || {};
    const enteredPaid = Number(req.body?.paidAmount);
    if (!Number.isFinite(enteredPaid) || enteredPaid < 0) {
      return res.status(400).json({ error: "A valid paid amount is required (0 for fully on credit)." });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "A rate is required for every delivered item." });
    }

    const lines = await IngredientPurchase.find({ purchaseOrderNumber, status: "pending", ...shopScope(req) });
    if (lines.length === 0) {
      return res.status(404).json({ error: "Purchase order not found, or it was already received." });
    }

    // Every entered rate must resolve to a real, valid number >= 0, and
    // every line of this order must be represented - a rejected request
    // should never partially bill/receive an order.
    const rateByLineId = new Map();
    for (const item of items) {
      const { purchaseId, rate } = item || {};
      const purchaseRate = Number(rate);
      if (!purchaseId || !Number.isFinite(purchaseRate) || purchaseRate < 0) {
        return res.status(400).json({ error: "Every item needs a valid rate." });
      }
      rateByLineId.set(String(purchaseId), purchaseRate);
    }
    for (const line of lines) {
      if (!rateByLineId.has(String(line._id))) {
        return res.status(400).json({ error: "A rate is required for every delivered item." });
      }
    }

    // Compute each line's totalAmount fresh from qty * the just-entered
    // rate - this is the first moment any price has ever existed on this
    // order, so the order's own grand total is only knowable after this.
    const computedTotalsById = new Map();
    let orderTotal = 0;
    for (const line of lines) {
      const purchaseRate = rateByLineId.get(String(line._id));
      const lineTotal = Math.round(line.quantity * purchaseRate * 100) / 100;
      computedTotalsById.set(String(line._id), lineTotal);
      orderTotal += lineTotal;
    }

    const paidTotal = Math.min(Math.max(enteredPaid, 0), orderTotal);

    const ingredientIds = lines.map((line) => line.ingredientId);
    const ingredients = await Ingredient.find({ _id: { $in: ingredientIds }, ...shopScope(req) });
    const ingredientById = new Map(ingredients.map((ing) => [String(ing._id), ing]));

    let allocatedSoFar = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastLine = i === lines.length - 1;
      const purchaseRate = rateByLineId.get(String(line._id));
      const lineTotal = computedTotalsById.get(String(line._id));
      // Proportional split, last line takes the exact remainder - see this
      // function's own header comment on why (guarantees the lines' own
      // paidAmount always sums to precisely `paidTotal`, with no rounding
      // drift left over or double-counted).
      const linePaid = isLastLine
        ? Math.max(paidTotal - allocatedSoFar, 0)
        : Math.round((orderTotal > 0 ? (paidTotal * lineTotal) / orderTotal : 0) * 100) / 100;
      allocatedSoFar += linePaid;

      line.rate = purchaseRate;
      line.totalAmount = lineTotal;
      line.paidAmount = linePaid;
      line.remainingAmount = Math.max(lineTotal - linePaid, 0);
      line.status = "received";
      line.receivedAt = new Date();
      line.receivedBy = req.user.id;
      await line.save();

      const ingredient = ingredientById.get(String(line.ingredientId));
      if (ingredient) {
        await applyPurchaseToIngredientStock(ingredient, line.quantity, purchaseRate);
      }
    }

    res.json({
      purchaseOrderNumber,
      lines,
      ingredients: Array.from(ingredientById.values()),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PATCH /api/ingredient-purchases/:id/pay  body: { amount }
// Settles part (or all) of a batch's outstanding supplier due - the
// Stock Manager paying the supplier back over time. Additive, same
// pattern as ingredientController.restockIngredient - never lets paidAmount
// exceed totalAmount (an overpayment isn't representable as "negative
// due" here; reject it instead of silently producing one).
exports.recordPayment = async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "A positive amount is required." });
  }
  const purchase = await IngredientPurchase.findOne({ _id: req.params.id, ...shopScope(req) });
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });

  // Dual-Status Stock Inventory Workflow: a "pending" purchase order line
  // hasn't been received yet - nothing has been formally invoiced, and its
  // stock/cost effect hasn't been applied, so there's no real "due" to pay
  // down here yet. Receive it first (receivePurchaseOrder below, which
  // logs the actual Full/Partial payment at delivery time) - this endpoint
  // is only for paying down a due AFTER that, on an already-received batch.
  if (purchase.status !== "received") {
    return res.status(400).json({ error: "Mark this purchase order received before recording a payment against it." });
  }

  if (amount > purchase.remainingAmount) {
    return res.status(400).json({ error: `Cannot pay more than the remaining due (Rs ${purchase.remainingAmount}).` });
  }

  purchase.paidAmount = Number(purchase.paidAmount || 0) + amount;
  purchase.remainingAmount = Math.max(purchase.totalAmount - purchase.paidAmount, 0);
  await purchase.save();
  res.json(purchase);
};

// There is deliberately no deletePurchase here - once a batch has been
// folded into Ingredient.currentStock and averageCost, undoing it cleanly
// would mean reversing a weighted average that later purchases (and sales)
// may have already built on top of, which can't be done losslessly. Real
// accounting practice doesn't delete a received bill either - a mistake
// gets corrected going forward (a new batch, or a manual stock adjustment
// via ingredientController.updateIngredient), not erased from history.
//
// POST /api/ingredient-purchases/:id/cancel  body: { reason? }
// Unified Khata: the audited alternative to ever actually deleting a
// received purchase (see this file's own comment right above, and
// IngredientPurchase.js's header comment) - mirrors
// orderController.cancelOrderCore as closely as this model's own shape
// allows: same "already cancelled" guard, same cancelledAt/cancelledBy/
// cancelReason fields, same non-fatal stock-reversal-never-blocks-the-
// cancellation reasoning. Used to also require the shop's Cancel Order Key
// (bcrypt-checked against cancelOrderKeyHash, shared with order
// cancellation) - the shop owner asked to drop that step everywhere, so
// this route now relies solely on the purchases.manage/stock.manage
// permission already required for every route in this controller (see
// backend/routes/ingredientPurchaseRoutes.js) as its access control.
//
// Stock reversal: a RECEIVED purchase added `quantity` of this ingredient
// to Ingredient.currentStock at receive time (applyPurchaseToIngredientStock
// above) - cancelling it means that stock never really arrived, so
// stockService.reverseIngredientReceipt takes it back off the shelf (floored
// at 0, averageCost deliberately left alone - see that function's own
// comment on why). A "pending" purchase (never received, so never folded
// into stock at all) is simply flipped to cancelled with no stock effect -
// there's nothing to reverse.
exports.cancelPurchase = async (req, res) => {
  try {
    const purchase = await IngredientPurchase.findOne({ _id: req.params.id, ...shopScope(req) });
    if (!purchase) {
      return res.status(404).json({ error: "Purchase not found" });
    }
    if (purchase.status === "cancelled") {
      return res.status(400).json({ error: "This purchase is already cancelled.", reason: "already_cancelled" });
    }

    const { reason } = req.body || {};

    const user = req.user?.id ? await User.findById(req.user.id).select("name username").lean() : null;

    const wasReceived = purchase.status === "received";
    const { ingredientId, quantity, shopId } = purchase;

    purchase.status = "cancelled";
    purchase.cancelledAt = new Date();
    purchase.cancelledBy = user?.name || user?.username || "";
    purchase.cancelReason = reason || "No reason provided";
    await purchase.save();

    // Only a purchase that was actually RECEIVED (i.e. really folded into
    // stock) has anything to reverse - a still-"pending" order never
    // touched Ingredient.currentStock in the first place (see
    // createPurchaseOrder's own comment).
    if (wasReceived) {
      await reverseIngredientReceipt(ingredientId, quantity, shopId);
    }

    res.json(purchase);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /api/ingredient-purchases/company-ledger?startDate=&endDate=
// Task 4 (Ledger Integration): "track outstanding supplier balances
// dynamically so the user can filter or view exactly how much due amount
// is owed to which specific company." Groups every purchase this shop has
// ever logged by its free-text companyName (see IngredientPurchase.js's
// own comment on why that's a plain string, not a Supplier reference) into
// one row per company.
//
// Mirrors customerController.getCustomerLedger's exact "current balance vs
// period activity" split: `totalDue` is always computed from EVERY
// purchase ever logged for that company, regardless of any range picked -
// a batch bought outside the report window still genuinely counts toward
// what's owed right now, so scoping it to the range would understate a
// real debt. `purchaseCount`/`totalPurchased`/`totalPaid`/`lastPurchaseAt`
// ARE scoped to the optional startDate/endDate range (same plain
// YYYY-MM-DD convention as every other date-range endpoint in this app) -
// that's "what happened in this period" activity, the actual report
// content when a range is picked.
exports.getCompanyLedger = async (req, res) => {
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

  // Dual-Status Stock Inventory Workflow: status:"received" only - a
  // "pending" order hasn't been formally invoiced or paid against yet (see
  // recordPayment's own guard above), so it shouldn't inflate a company's
  // totalPurchased/totalPaid/totalDue until it's actually been received.
  //
  // linkedCustomerId: null - a purchase now tied to a Khata contact (Unified
  // Khata / Customer-Supplier Netting) is already counted, correctly, in
  // that contact's own netBalance (customerController.getCustomerLedger).
  // Also counting it here, grouped by its (now contact-derived) companyName,
  // would double-count the same real due in two unreconciled ledgers - this
  // plain free-text Suppliers view is only for a company that ISN'T also a
  // Khata contact.
  const purchases = await IngredientPurchase.find({ ...shopScope(req), companyName: { $ne: "" }, status: "received", linkedCustomerId: null })
    .select("companyName ingredientName quantity unit rate totalAmount paidAmount remainingAmount purchaseDate")
    .sort({ purchaseDate: -1 })
    .lean();

  const byCompany = new Map();
  for (const purchase of purchases) {
    const key = purchase.companyName.trim();
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(purchase);
  }

  const ledger = [...byCompany.entries()].map(([companyName, companyPurchases]) => {
    // Always all-time - see this function's own header comment.
    const totalDue = companyPurchases.reduce((sum, p) => sum + (p.remainingAmount || 0), 0);

    const periodPurchases = rangeStart
      ? companyPurchases.filter((p) => {
          const purchaseDate = new Date(p.purchaseDate);
          return purchaseDate >= rangeStart && purchaseDate <= rangeEnd;
        })
      : companyPurchases;

    return {
      companyName,
      purchaseCount: periodPurchases.length,
      totalPurchased: periodPurchases.reduce((sum, p) => sum + (p.totalAmount || 0), 0),
      totalPaid: periodPurchases.reduce((sum, p) => sum + (p.paidAmount || 0), 0),
      totalDue,
      // Already sorted purchaseDate descending above, so this company's
      // own first entry in its (unfiltered) list is its most recent batch.
      lastPurchaseAt: companyPurchases[0]?.purchaseDate || null,
    };
  }).sort((a, b) => b.totalDue - a.totalDue);

  res.json(ledger);
};
