const mongoose = require("mongoose");

// A Role is always scoped to exactly one shop - Shop Owners define their
// own Cashier/Manager/Accountant/etc. roles (or custom ones) and assign
// them to Employee users via User.employeeRoleId. `permissions` stores
// keys from config/permissions.js (PERMISSION_KEYS).
const roleSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    name: { type: String, required: true, trim: true },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

roleSchema.index({ shopId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Role", roleSchema);
