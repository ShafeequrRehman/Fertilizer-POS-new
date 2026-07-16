const mongoose = require("mongoose");

// Subscription plan catalog, managed only by the Super Admin. Shops
// reference a plan via Shop.planId / License.planId; Payment records also
// reference the plan that was paid for.
const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "PKR" },
    durationMonths: { type: Number, required: true, min: 1 },
    maxEmployees: { type: Number, default: 10 },
    features: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Plan", planSchema);
