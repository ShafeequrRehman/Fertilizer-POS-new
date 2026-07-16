const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const ctrl = require("../controllers/expenseController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/", ctrl.getExpenses);
router.get("/:id", ctrl.getExpense);
router.post("/", requirePermission("expenses.manage"), ctrl.createExpense);
router.patch("/:id", requirePermission("expenses.manage"), ctrl.updateExpense);
router.delete("/:id", requirePermission("expenses.manage"), ctrl.deleteExpense);

module.exports = router;
