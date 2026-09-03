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
    // Dashboard Permission Gate: unlike every key in `permissions` above
    // (which is additive - default DENIED, granted only if listed), this
    // is a standalone opt-OUT toggle - default false (Dashboard visible),
    // and only when explicitly set true does an employee assigned this
    // role stop seeing/reaching the main Dashboard home page after
    // logging in (see authController.js's resolveEmployeePermissions and
    // src/lib/dashboard-pages.ts's getFirstAccessiblePage). Kept as its
    // own field rather than a `permissions` entry precisely because its
    // default is the opposite of every other permission's.
    hideDashboard: { type: Boolean, default: false },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

roleSchema.index({ shopId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Role", roleSchema);
