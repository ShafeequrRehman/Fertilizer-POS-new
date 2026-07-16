const mongoose = require("mongoose");

// A ShopSession is one "Shop Open" -> "Shop Close" cycle (a shift/day).
// Orders are always scoped by shopId (see attachShopScope), but there was
// previously no way to know exactly which orders belonged to a given
// business day/shift without relying on wall-clock date filters, which
// break down around midnight and don't capture "we opened late" or "we
// closed early" days. Each session records who opened/closed it and a
// summary computed from Orders created in [openedAt, closedAt) at close
// time - see controllers/shopSessionController.js.
//
// Only one session per shop should ever be "open" at a time - enforced in
// the controller (openSession refuses if one is already open), not here.
const shopSessionSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    status: { type: String, enum: ["open", "closed"], default: "open", index: true },
    // Atomically incremented (via $inc in orderController.createOrder) to
    // hand out each order's dailyOrderNumber for this shift. Using an
    // atomic counter instead of counting existing Order documents avoids a
    // race where two orders placed within the same instant both read the
    // same count and get assigned the same number (seen in production as
    // duplicate "#001" tickets).
    orderCounter: { type: Number, default: 0 },
    openedAt: { type: Date, required: true },
    openedBy: { type: String, default: "" },
    openedByName: { type: String, default: "" },
    closedAt: { type: Date, default: null },
    closedBy: { type: String, default: "" },
    closedByName: { type: String, default: "" },
    // Whether the session was closed despite unpaid/pending orders still
    // being open at close time (the user confirmed the "force close"
    // warning) - kept so shift history can flag it later.
    closedWithUnpaidOrders: { type: Boolean, default: false },
    summary: {
      orderCount: { type: Number, default: 0 },
      cancelledCount: { type: Number, default: 0 },
      totalSales: { type: Number, default: 0 },
      totalPaid: { type: Number, default: 0 },
      totalDue: { type: Number, default: 0 },
      totalDiscount: { type: Number, default: 0 },
      paymentBreakdown: {
        Cash: { type: Number, default: 0 },
        Card: { type: Number, default: 0 },
        "E-Wallet": { type: Number, default: 0 },
      },
    },
  },
  { timestamps: true }
);

shopSessionSchema.index({ shopId: 1, status: 1 });

module.exports = mongoose.model("ShopSession", shopSessionSchema);
