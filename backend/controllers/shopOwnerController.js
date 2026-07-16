const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Role = require("../models/Role");
const Shop = require("../models/Shop");
const Plan = require("../models/Plan");
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
    const { name, username, password, email, phone, roleId } = req.body;
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

    const { name, email, phone, roleId, isActive, username } = req.body;

    if (username && username !== employee.username) {
      const clash = await User.findOne({ username, _id: { $ne: employee._id } });
      if (clash) return res.status(400).json({ message: "That username is already taken", reason: "username_taken" });
      employee.username = username;
    }
    if (name !== undefined) employee.name = name;
    if (email !== undefined) employee.email = email;
    if (phone !== undefined) employee.phone = phone;
    if (isActive !== undefined) employee.isActive = isActive;

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
    const shop = await Shop.findById(req.user.shopId).populate("planId");
    if (!shop) return res.status(404).json({ message: "Shop not found" });
    res.json(shop);
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
