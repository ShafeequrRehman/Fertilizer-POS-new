const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const customerController = require("../controllers/customerController");

const router = express.Router();

// Previously /search, / (GET) and / (POST) had NO auth at all - any
// unauthenticated caller could read or create customer records. That gap
// is closed here as part of adding shop scoping (a request can't be
// scoped to a shop without first knowing who's asking).
router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/search", customerController.searchCustomers);
router.get("/ledger", customerController.getCustomerLedger);
router.get("/:phone/outstanding", customerController.getCustomerOutstanding);
router.get("/", customerController.getAllCustomers);
router.post("/", customerController.createCustomer);
router.post("/:phone/settle-dues", customerController.settleCustomerDues);
router.patch("/dues/:phone", customerController.updateCustomerDues);
router.patch("/:id", customerController.updateCustomer);

module.exports = router;
