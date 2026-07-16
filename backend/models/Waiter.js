const mongoose = require("mongoose");

const waiterSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

waiterSchema.index({ shopId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Waiter", waiterSchema);
