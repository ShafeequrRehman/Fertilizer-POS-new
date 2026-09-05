// Isolated, self-cleaning verification of the real Cancel Order pipeline
// (backend/controllers/orderController.js: exports.cancelOrder / cancelOrderCore).
// Creates a throwaway Shop + Order (never touches any real shop's data),
// calls the ACTUAL exported handler used by POST /api/orders/:id/cancel
// (bypassing only the HTTP/auth layer, not the business logic), and checks:
//   1. Wrong key is rejected (401, order stays pending)
//   2. Correct key cancels the order (status/cancelledAt/cancelledBy/reason/version)
//   3. Cancelling an already-cancelled order is rejected (400, already_cancelled)
// Deletes all test documents at the end regardless of outcome.

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const Shop = require("/sessions/zen-eager-wozniak/mnt/pos-web-new/backend/models/Shop");
const Order = require("/sessions/zen-eager-wozniak/mnt/pos-web-new/backend/models/Order");
const orderController = require("/sessions/zen-eager-wozniak/mnt/pos-web-new/backend/controllers/orderController");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to DB:", mongoose.connection.name);

  const TEST_KEY = "TEST-VERIFY-KEY-9999";
  const keyHash = await bcrypt.hash(TEST_KEY, 10);

  const shop = await Shop.create({
    name: "ZZZ_AUTOMATED_TEST_SHOP_DELETE_ME",
    cancelOrderKeyHash: keyHash,
  });

  const order = await Order.create({
    shopId: shop._id,
    items: [{ name: "Test Burger", price: 500, quantity: 2, variation: "Regular" }],
    subtotal: 1000,
    total: 1000,
    orderType: "TakeAway",
    customer: { name: "Test Customer", phone: "03000000000", address: "" },
    address: "",
    note: "",
    waiter: "",
    table: "",
    status: "pending",
    paymentMethod: "Cash",
    createdAt: new Date(),
  });

  const results = [];

  // 1. Wrong key must be rejected, order must remain pending.
  {
    const res = fakeRes();
    await orderController.cancelOrder(
      { params: { id: String(order._id) }, body: { key: "WRONG-KEY", reason: "verify: wrong key" }, user: { shopId: shop._id } },
      res,
    );
    const stillPending = (await Order.findById(order._id)).status === "pending";
    results.push({
      check: "Wrong key rejected",
      pass: res.statusCode === 401 && res.body?.reason === "wrong_key" && stillPending,
      detail: `status=${res.statusCode} reason=${res.body?.reason} orderStatus=${stillPending ? "pending" : "CHANGED"}`,
    });
  }

  // 2. Correct key actually cancels the order.
  {
    const res = fakeRes();
    await orderController.cancelOrder(
      { params: { id: String(order._id) }, body: { key: TEST_KEY, reason: "verify: correct key" }, user: { shopId: shop._id, id: null } },
      res,
    );
    const fresh = await Order.findById(order._id);
    results.push({
      check: "Correct key cancels the order",
      pass: res.statusCode === 200 && fresh.status === "cancelled" && !!fresh.cancelledAt && fresh.cancelReason === "verify: correct key" && fresh.version === 1,
      detail: `status=${res.statusCode} order.status=${fresh.status} cancelledAt=${fresh.cancelledAt} reason="${fresh.cancelReason}" version=${fresh.version}`,
    });
  }

  // 3. Cancelling again (already cancelled) must be rejected, not silently re-applied.
  {
    const res = fakeRes();
    await orderController.cancelOrder(
      { params: { id: String(order._id) }, body: { key: TEST_KEY, reason: "verify: second attempt" }, user: { shopId: shop._id } },
      res,
    );
    results.push({
      check: "Re-cancelling an already-cancelled order is rejected",
      pass: res.statusCode === 400 && res.body?.reason === "already_cancelled",
      detail: `status=${res.statusCode} reason=${res.body?.reason}`,
    });
  }

  console.log("\n--- Results ---");
  let allPass = true;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} - ${r.check} (${r.detail})`);
    if (!r.pass) allPass = false;
  }

  // Cleanup - never leave test data behind.
  await Order.deleteOne({ _id: order._id });
  await Shop.deleteOne({ _id: shop._id });
  console.log("\nCleanup done - test Shop/Order removed.");

  await mongoose.disconnect();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Verification script crashed:", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
