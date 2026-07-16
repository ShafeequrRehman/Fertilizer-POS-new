const mongoose = require("mongoose");

const purchaseItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const purchaseSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
    items: { type: [purchaseItemSchema], default: [] },
    total: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "received", "cancelled"], default: "pending" },
    purchaseDate: { type: Date, default: Date.now },
    note: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Purchase", purchaseSchema);
