const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    category: { type: String, default: "General" },
    variation: { type: String, default: "" },
    image: { type: String, default: "" },
    color: { type: String, default: "bg-slate-50" },
    description: { type: String, default: "" },
    isDeal: { type: Boolean, default: false },
    dealItems: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);
