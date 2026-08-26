const mongoose = require("mongoose");

// Every login-capable account in the system is a User - Super Admin, Shop
// Owner, and Employee all share this one collection, distinguished by
// `role`. This is a deliberate design choice: employees genuinely are
// users who log in with a username/password like anyone else, so giving
// them a second, separate "Employee" login collection would mean
// duplicating all of the auth/lockout/JWT logic below for no benefit. The
// `employeeRoleId` field (only meaningful when role === "employee") is
// what maps an employee to their assigned Role/permission set - see
// models/Role.js.
const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    username: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    phone: { type: String, default: "" },
    password: {
      type: String,
      required: true,
    },
    // superadmin: the software owner, exactly one account unless more are
    //   explicitly created; shopId is always null.
    // shopowner: the customer who owns a shop; shopId is required and is
    //   the tenant boundary for everything they can see.
    // employee: staff created only by a Shop Owner; shopId is required and
    //   must match the shop that created them; employeeRoleId points at
    //   the Role (permission set) they were assigned.
    role: {
      type: String,
      enum: ["superadmin", "shopowner", "employee"],
      required: true,
    },
    shopId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      default: null,
      index: true,
    },
    employeeRoleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      default: null,
    },
    // Staff directory fields (Manage Staff page) - only meaningful for
    // role: "employee". `designation` is the job title shown throughout
    // the app (Chief, Manager, Cashier, Order Taker, Waiter, etc.) and is
    // what POS order placement filters by when building the waiter/order
    // taker dropdown (see waiterController.getWaiters) - free text so a
    // shop can use whatever titles fit their team, not a fixed enum.
    designation: { type: String, default: "" },
    idCardNumber: { type: String, default: "" },
    address: { type: String, default: "" },
    // Vehicle/bike registration number - only really meaningful for staff
    // with designation "Delivery Rider", but kept as free text on every
    // employee (same reasoning as idCardNumber/address) rather than a
    // rider-only sub-schema, so it survives a designation change cleanly.
    // Surfaced in waiterController.getRiders for the SalesPage.tsx rider
    // picker, and shown/edited in EmployeesPage.tsx's Manage Staff form.
    vehicleNumber: { type: String, default: "" },
    reference: { type: String, default: "" },
    comment: { type: String, default: "" },
    // Agreed monthly salary, used by the Payroll page alongside
    // StaffPayment records to compute how much of the month's pay has
    // already been taken and how much remains.
    monthlySalary: { type: Number, default: 0 },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    // Backs the temporary login lockout in authController.login.
    // failedLoginAttempts resets to 0 on success or once lockUntil
    // expires; lockUntil is always a short, temporary window - never
    // a permanent lock.
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
      default: null,
    },
    // Refresh token rotation: only a hash is ever stored, never the raw
    // token (mirrors how `password` is stored). Set on login/refresh,
    // cleared on logout. See backend/auth/tokenService.js.
    refreshTokenHash: {
      type: String,
      default: null,
      index: true,
      sparse: true,
    },
    refreshTokenExpiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

userSchema.index({ shopId: 1, role: 1 });

module.exports = mongoose.model("User", userSchema);
