const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const requirePermission = require("../middleware/requirePermission");
const requireAnyPermission = require("../middleware/requireAnyPermission");
const customerController = require("../controllers/customerController");

const router = express.Router();

// Previously /search, / (GET) and / (POST) had NO auth at all - any
// unauthenticated caller could read or create customer records. That gap
// is closed here as part of adding shop scoping (a request can't be
// scoped to a shop without first knowing who's asking).
router.use(authenticate, requireShopMember, requireLicenseValid);

// Broken Access Control fix: this router only ever checked "logged in as
// SOME employee of this shop" - never which page/permission the caller
// actually has, so any employee token could read every customer's PII and
// due balance, or settle a due, via a direct API call. Reads are shared by
// several different-permission pages (see pos-api.ts's own callers):
// sales.create (POS/Sales customer search + due lookup at checkout),
// customers.manage (Management), dues.manage (Dues/Ledger), and
// orders.record.view (Record's own order/customer detail). Writes are
// narrower - creating/updating a customer record happens both from
// checkout and from Management, but SETTLING or manually adjusting a due
// balance is a distinct, more sensitive financial action reserved for
// dues.manage specifically (its own catalog description: "Adjust and clear
// customer outstanding balances") - sales.create alone must not be enough
// for that, even though it's enough to just create/update a customer.
const canReadCustomers = requireAnyPermission("sales.create", "customers.manage", "dues.manage", "orders.record.view");
const canWriteCustomer = requireAnyPermission("sales.create", "customers.manage");

router.get("/search", canReadCustomers, customerController.searchCustomers);
router.get("/ledger", canReadCustomers, customerController.getCustomerLedger);
router.get("/:phone/outstanding", canReadCustomers, customerController.getCustomerOutstanding);
router.get("/", canReadCustomers, customerController.getAllCustomers);
router.post("/", canWriteCustomer, customerController.createCustomer);
router.post("/:phone/settle-dues", requirePermission("dues.manage"), customerController.settleCustomerDues);
router.patch("/dues/:phone", requirePermission("dues.manage"), customerController.updateCustomerDues);
router.patch("/:id", canWriteCustomer, customerController.updateCustomer);

module.exports = router;
