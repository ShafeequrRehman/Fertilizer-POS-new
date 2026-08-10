const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/authenticate");
const { requireShopOwner } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const ctrl = require("../controllers/shopOwnerController");

// Employee/role management and shop profile are Shop Owner-only actions
// (per spec: "Employees created only by the Shop Owner"), and are blocked
// the same way any other dashboard feature is once a shop's license
// expires or the shop is suspended.
router.use(authenticate, requireShopOwner, requireLicenseValid);

// Employees
router.get("/employees", ctrl.listEmployees);
router.post("/employees", ctrl.createEmployee);
router.patch("/employees/:id", ctrl.updateEmployee);
router.delete("/employees/:id", ctrl.deleteEmployee);
router.patch("/employees/:id/reset-password", ctrl.resetEmployeePassword);

// Payroll
router.get("/payroll", ctrl.listPayroll);
router.get("/payroll/payments", ctrl.listPayments);
router.post("/payroll/payments", ctrl.recordPayment);
router.delete("/payroll/payments/:id", ctrl.deletePayment);

// Roles
router.get("/roles", ctrl.listRoles);
router.post("/roles", ctrl.createRole);
router.patch("/roles/:id", ctrl.updateRole);
router.delete("/roles/:id", ctrl.deleteRole);

// Permission catalog (for the role editor UI)
router.get("/permissions", ctrl.listPermissionCatalog);

// Own shop profile
router.get("/profile", ctrl.getOwnShop);
router.patch("/profile", ctrl.updateOwnShop);

// Sidebar page visibility (gated by the Page Visibility Key the Super
// Admin assigned - see shopOwnerController.exports.updateEnabledPages)
router.patch("/pages", ctrl.updateEnabledPages);

module.exports = router;
