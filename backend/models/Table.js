const mongoose = require("mongoose");

// A dine-in Table for a shop. `name` is the plain identifier the shop
// person types/sees (e.g. "5", "VIP-1") - it's stored on Order.table exactly
// as before (POSPage.tsx used to just generate values "1".."20" client-side
// with no backing record at all). `isFamily` flags a table as a Family
// Table so the Dine-In screen can visually call it out during selection.
const tableSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isFamily: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

tableSchema.index({ shopId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Table", tableSchema);
