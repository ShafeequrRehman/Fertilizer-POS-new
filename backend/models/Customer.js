const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Phone was globally unique before multi-tenancy, which is wrong once
    // multiple shops can each have a customer with the same number -
    // uniqueness is now scoped to (shopId, phone) instead.
    phone: { type: String, required: true, trim: true },
    address: { type: String, default: "" },
    previousDues: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

customerSchema.index({ shopId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model("Customer", customerSchema);
