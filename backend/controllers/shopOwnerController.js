const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Role = require("../models/Role");
const Shop = require("../models/Shop");
const Plan = require("../models/Plan");
const StaffPayment = require("../models/StaffPayment");
const { PERMISSIONS, PERMISSION_KEYS } = require("../config/permissions");

function safeUser(user) {
  const obj = user.toObject ? user.toObject() : user;
  delete obj.password;
  delete obj.refreshTokenHash;
  delete obj.refreshTokenExpiresAt;
  return obj;
}

function validatePermissionKeys(keys) {
  if (!Array.isArray(keys)) return false;
  return keys.every((key) => PERMISSION_KEYS.includes(key));
}

// ---------------------------------------------------------------------
// Employees (Users with role: "employee", scoped to req.user.shopId)
// ---------------------------------------------------------------------

// GET /api/shop/employees
exports.listEmployees = async (req, res) => {
  try {
    const employees = await User.find({ shopId: req.user.shopId, role: "employee" }).populate("employeeRoleId", "name permissions").sort({ createdAt: -1 });
    res.json(employees.map(safeUser));
  } catch (error) {
    res.status(500).json({ message: "Failed to load employees", detail: error.message });
  }
};

// POST /api/shop/employees
exports.createEmployee = async (req, res) => {
  try {
    const {
      name, username, password, email, phone, roleId,
      designation, idCardNumber, address, reference, comment, monthlySalary,
    } = req.body;
    if (!username || !password || !roleId) {
      return res.status(400).json({ message: "username, password, and roleId are required", reason: "validation_error" });
    }

    const role = await Role.findOne({ _id: roleId, shopId: req.user.shopId });
    if (!role) {
      return res.status(400).json({ message: "Role not found for this shop", reason: "role_not_found" });
    }

    // Enforce the plan's employee-seat limit, if the shop has a plan.
    const shop = await Shop.findById(req.user.shopId).populate("planId");
    if (shop?.planId?.maxEmployees) {
      const currentCount = await User.countDocuments({ shopId: req.user.shopId, role: "employee" });
      if (currentCount >= shop.planId.maxEmployees) {
        return res.status(400).json({
          message: `Your plan allows a maximum of ${shop.planId.maxEmployees} employees. Contact the software provider to upgrade.`,
          reason: "employee_limit_reached",
        });
      }
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({ message: "That username is already taken", reason: "username_taken" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const employee = await User.create({
      name: name || username,
      username,
      email: email || "",
      phone: phone || "",
      password: hashedPassword,
      role: "employee",
      shopId: req.user.shopId,
      employeeRoleId: role._id,
      designation: designation || "",
      idCardNumber: idCardNumber || "",
      address: address || "",
      reference: reference || "",
      comment: comment || "",
      monthlySalary: Number(monthlySalary) || 0,
    });

    res.status(201).json({ ...safeUser(employee), roleName: role.name, permissions: role.permissions });
  } catch (error) {
    res.status(500).json({ message: "Failed to create employee", detail: error.message });
  }
};

// PATCH /api/shop/employees/:id
exports.updateEmployee = async (req, res) => {
  try {
    const employee = await User.findOne({ _id: req.params.id, shopId: req.user.shopId, role: "employee" });
    if (!employee) return res.status(404).json({ message: "Employee not found" });

    const {
      name, email, phone, roleId, isActive, username,
      designation, idCardNumber, address, reference, comment, monthlySalary,
    } = req.body;

    if (username && username !== employee.username) {
      const clash = await User.findOne({ username, _id: { $ne: employee._id } });
      if (clash) return res.status(400).json({ message: "That username is already taken", reason: "username_taken" });
      employee.username = username;
    }
    if (name !== undefined) employee.name = name;
    if (email !== undefined) employee.email = email;
    if (phone !== undefined) employee.phone = phone;
    if (isActive !== undefined) employee.isActive = isActive;
    if (designation !== undefined) employee.designation = designation;
    if (idCardNumber !== undefined) employee.idCardNumber = idCardNumber;
    if (address !== undefined) employee.address = address;
    if (reference !== undefined) employee.reference = reference;
    if (comment !== undefined) employee.comment = comment;
    if (monthlySalary !== undefined) employee.monthlySalary = Number(monthlySalary) || 0;

    if (roleId) {
      const role = await Role.findOne({ _id: roleId, shopId: req.user.shopId });
      if (!role) return res.status(400).json({ message: "Role not found for this shop", reason: "role_not_found" });
      employee.employeeRoleId = role._id;
    }

    await employee.save();
    res.json(safeUser(employee));
  } catch (error) {
    res.status(500).json({ message: "Failed to update employee", detail: error.message });
  }
};

// DELETE /api/shop/employees/:id
exports.deleteEmployee = async (req, res) => {
  try {
    const result = await User.deleteOne({ _id: req.params.id, shopId: req.user.shopId, role: "employee" });
    if (result.deletedCount === 0) return res.status(404).json({ message: "Employee not found" });
    res.json({ message: "Employee removed" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete employee", detail: error.message });
  }
};

// PATCH /api/shop/employees/:id/reset-password  body: { newPassword }
exports.resetEmployeePassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: "newPassword must be at least 6 characters", reason: "validation_error" });
    }
    const employee = await User.findOne({ _id: req.params.id, shopId: req.user.shopId, role: "employee" });
    if (!employee) return res.status(404).json({ message: "Employee not found" });

    employee.password = await bcrypt.hash(newPassword, 10);
    employee.failedLoginAttempts = 0;
    employee.lockUntil = null;
    employee.refreshTokenHash = null;
    employee.refreshTokenExpiresAt = null;
    await employee.save();

    res.json({ message: "Employee password has been reset", username: employee.username });
  } catch (error) {
    res.status(500).json({ message: "Failed to reset password", detail: error.message });
  }
};

// ---------------------------------------------------------------------
// Payroll - built on top of User.monthlySalary plus a ledger of
// StaffPayment rows (salary/advance/bonus/deduction). "Paid this month"
// sums salary+advance+bonus and subtracts deduction, all within the
// requested month; "remaining" is monthlySalary minus that sum, floored
// at 0 for display purposes only (the raw number is still returned so
// the UI can show an overpayment if it ever happens).
// ---------------------------------------------------------------------

function monthRange(monthParam) {
  // monthParam is "YYYY-MM"; defaults to the current calendar month.
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    year = Number(monthParam.slice(0, 4));
    month = Number(monthParam.slice(5, 7)) - 1;
  }
  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 1, 1, 0, 0, 0, 0);
  return { start, end, monthKey: `${year}-${String(month + 1).padStart(2, "0")}` };
}

// GET /api/shop/payroll?month=YYYY-MM
exports.listPayroll = async (req, res) => {
  try {
    const { start, end, monthKey } = monthRange(req.query.month);
    const employees = await User.find({ shopId: req.user.shopId, role: "employee" }).sort({ name: 1 });
    const payments = await StaffPayment.find({
      shopId: req.user.shopId,
      date: { $gte: start, $lt: end },
    });

    const totalsByEmployee = new Map();
    for (const payment of payments) {
      const key = String(payment.employeeId);
      const bucket = totalsByEmployee.get(key) || { paid: 0, bonus: 0, deduction: 0 };
      if (payment.type === "deduction") bucket.deduction += payment.amount;
      else if (payment.type === "bonus") bucket.bonus += payment.amount;
      else bucket.paid += payment.amount; // salary + advance both count against the salary owed
      totalsByEmployee.set(key, bucket);
    }

    const rows = employees.map((employee) => {
      const bucket = totalsByEmployee.get(String(employee._id)) || { paid: 0, bonus: 0, deduction: 0 };
      const paidThisMonth = bucket.paid - bucket.deduction;
      const remaining = (employee.monthlySalary || 0) - paidThisMonth;
      return {
        employeeId: String(employee._id),
        name: employee.name,
        username: employee.username,
        designation: employee.designation || "",
        isActive: employee.isActive,
        monthlySalary: employee.monthlySalary || 0,
        paidThisMonth,
        bonusThisMonth: bucket.bonus,
        remaining,
      };
    });

    const summary = rows.reduce(
      (acc, row) => {
        acc.totalMonthlySalary += row.monthlySalary;
        acc.totalPaidThisMonth += row.paidThisMonth;
        acc.totalRemaining += Math.max(row.remaining, 0);
        return acc;
      },
      { totalMonthlySalary: 0, totalPaidThisMonth: 0, totalRemaining: 0 }
    );

    res.json({ month: monthKey, rows, summary });
  } catch (error) {
    res.status(500).json({ message: "Failed to load payroll", detail: error.message });
  }
};

// GET /api/shop/payroll/payments?employeeId=&month=YYYY-MM
exports.listPayments = async (req, res) => {
  try {
    const query = { shopId: req.user.shopId };
    if (req.query.employeeId) query.employeeId = req.query.employeeId;
    if (req.query.month) {
      const { start, end } = monthRange(req.query.month);
      query.date = { $gte: start, $lt: end };
    }
    const payments = await StaffPayment.find(query).populate("employeeId", "name username").sort({ date: -1 });
    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: "Failed to load payroll payments", detail: error.message });
  }
};

// POST /api/shop/payroll/payments  body: { employeeId, amount, type, note, date }
exports.recordPayment = async (req, res) => {
  try {
    const { employeeId, amount, type, note, date } = req.body;
    if (!employeeId || !amount || Number(amount) <= 0) {
      return res.status(400).json({ message: "employeeId and a positive amount are required", reason: "validation_error" });
    }
    const employee = await User.findOne({ _id: employeeId, shopId: req.user.shopId, role: "employee" });
    if (!employee) return res.status(404).json({ message: "Employee not found" });

    const payment = await StaffPayment.create({
      shopId: req.user.shopId,
      employeeId,
      amount: Number(amount),
      type: ["salary", "advance", "bonus", "deduction"].includes(type) ? type : "salary",
      note: note || "",
      date: date ? new Date(date) : new Date(),
      recordedBy: req.user.id || req.user._id,
    });

    res.status(201).json(await payment.populate("employeeId", "name username"));
  } catch (error) {
    res.status(500).json({ message: "Failed to record payment", detail: error.message });
  }
};

// DELETE /api/shop/payroll/payments/:id
exports.deletePayment = async (req, res) => {
  try {
    const result = await StaffPayment.deleteOne({ _id: req.params.id, shopId: req.user.shopId });
    if (result.deletedCount === 0) return res.status(404).json({ message: "Payment record not found" });
    res.json({ message: "Payment record removed" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete payment", detail: error.message });
  }
};

// ---------------------------------------------------------------------
// Roles (per-shop permission sets employees are assigned to)
// ---------------------------------------------------------------------

// GET /api/shop/roles
exports.listRoles = async (req, res) => {
  try {
    res.json(await Role.find({ shopId: req.user.shopId }).sort({ name: 1 }));
  } catch (error) {
    res.status(500).json({ message: "Failed to load roles", detail: error.message });
  }
};

// POST /api/shop/roles
exports.createRole = async (req, res) => {
  try {
    const { name, permissions } = req.body;
    if (!name) return res.status(400).json({ message: "name is required", reason: "validation_error" });
    if (permissions !== undefined && !validatePermissionKeys(permissions)) {
      return res.status(400).json({ message: "permissions contains an unknown permission key", reason: "invalid_permissions" });
    }

    const role = await Role.create({ shopId: req.user.shopId, name, permissions: permissions || [] });
    res.status(201).json(role);
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: "A role with that name already exists for your shop", reason: "duplicate_role" });
    res.status(500).json({ message: "Failed to create role", detail: error.message });
  }
};

// PATCH /api/shop/roles/:id
exports.updateRole = async (req, res) => {
  try {
    const role = await Role.findOne({ _id: req.params.id, shopId: req.user.shopId });
    if (!role) return res.status(404).json({ message: "Role not found" });

    const { name, permissions } = req.body;
    if (permissions !== undefined) {
      if (!validatePermissionKeys(permissions)) {
        return res.status(400).json({ message: "permissions contains an unknown permission key", reason: "invalid_permissions" });
      }
      role.permissions = permissions;
    }
    if (name !== undefined) role.name = name;

    await role.save();
    res.json(role);
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: "A role with that name already exists for your shop", reason: "duplicate_role" });
    res.status(500).json({ message: "Failed to update role", detail: error.message });
  }
};

// DELETE /api/shop/roles/:id
exports.deleteRole = async (req, res) => {
  try {
    const inUse = await User.exists({ employeeRoleId: req.params.id, shopId: req.user.shopId });
    if (inUse) {
      return res.status(400).json({ message: "Cannot delete a role that is still assigned to employees. Reassign them first.", reason: "role_in_use" });
    }
    const result = await Role.deleteOne({ _id: req.params.id, shopId: req.user.shopId });
    if (result.deletedCount === 0) return res.status(404).json({ message: "Role not found" });
    res.json({ message: "Role deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete role", detail: error.message });
  }
};

// GET /api/shop/permissions - the full catalog, for the role-editor UI
exports.listPermissionCatalog = async (req, res) => {
  res.json(PERMISSIONS);
};

// ---------------------------------------------------------------------
// Own shop profile (read-only license/plan view - Shop Owner cannot edit
// license fields; that's Super Admin only)
// ---------------------------------------------------------------------

// GET /api/shop/profile
exports.getOwnShop = async (req, res) => {
  try {
    const shop = await Shop.findById(req.user.shopId).populate("planId").lean();
    if (!shop) return res.status(404).json({ message: "Shop not found" });

    // Never send the key hashes themselves to the client - only whether
    // one has been set, same convention as superAdminController's
    // listShops. hasPageVisibilityKey is what SettingsPage.tsx's Sidebar
    // Pages section checks before letting the Shop Owner even try to
    // enter a key.
    const { cancelOrderKeyHash, pageVisibilityKeyHash, ...shopWithoutKeyHashes } = shop;
    res.json({
      ...shopWithoutKeyHashes,
      hasCancelOrderKey: Boolean(cancelOrderKeyHash),
      hasPageVisibilityKey: Boolean(pageVisibilityKeyHash),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load shop profile", detail: error.message });
  }
};

// PATCH /api/shop/profile - Shop Owner may edit their own contact details,
// never status/plan/license (those routes simply aren't exposed here).
exports.updateOwnShop = async (req, res) => {
  try {
    const shop = await Shop.findById(req.user.shopId);
    if (!shop) return res.status(404).json({ message: "Shop not found" });

    const { name, phone, email, address } = req.body;
    if (name !== undefined) shop.name = name;
    if (phone !== undefined) shop.phone = phone;
    if (email !== undefined) shop.email = email;
    if (address !== undefined) shop.address = address;

    await shop.save();
    res.json(shop);
  } catch (error) {
    res.status(500).json({ message: "Failed to update shop profile", detail: error.message });
  }
};

// PATCH /api/shop/pages  body: { enabledPages: string[], key }
// Lets the Shop Owner control their OWN dashboard sidebar - which pages
// show, which don't (see src/lib/dashboard-pages.ts for the key list,
// enforced client-side by DashboardShell.tsx's isPageEnabled filter) - but
// only with the Page Visibility Key the Super Admin assigned them (see
// superAdminController.exports.resetPageVisibilityKey). Mirrors
// orderController.exports.cancelOrder's key-check pattern exactly: key is
// bcrypt-compared, never hardcoded, never accepted in plaintext form.
exports.updateEnabledPages = async (req, res) => {
  try {
    const { enabledPages, key } = req.body;
    if (!Array.isArray(enabledPages)) {
      return res.status(400).json({ message: "enabledPages must be an array of page keys.", reason: "validation_error" });
    }
    if (!key) {
      return res.status(400).json({ message: "The shop's Page Visibility Key is required.", reason: "validation_error" });
    }

    const shop = await Shop.findById(req.user.shopId);
    if (!shop) return res.status(404).json({ message: "Shop not found" });
    if (!shop.pageVisibilityKeyHash) {
      return res.status(409).json({
        message: "No Page Visibility Key has been set up for this shop yet. Ask your software provider (Super Admin) to set one.",
        reason: "key_not_configured",
      });
    }

    const matches = await bcrypt.compare(String(key), shop.pageVisibilityKeyHash);
    if (!matches) {
      return res.status(401).json({ message: "Incorrect Page Visibility Key.", reason: "wrong_key" });
    }

    shop.enabledPages = enabledPages;
    await shop.save();
    res.json({ enabledPages: shop.enabledPages });
  } catch (error) {
    res.status(500).json({ message: "Failed to update page visibility", detail: error.message });
  }
};
