const express = require("express");
const authenticate = require("../middleware/authenticate");
const { requireShopMember } = require("../middleware/roleGuards");
const requireLicenseValid = require("../middleware/requireLicenseValid");
const { createProduct, deleteProduct, getProduct, getProducts, updateProduct } = require("../controllers/productController");

const router = express.Router();

router.use(authenticate, requireShopMember, requireLicenseValid);

router.get("/", getProducts);
router.post("/", createProduct);
router.get("/:id", getProduct);
router.patch("/:id", updateProduct);
router.delete("/:id", deleteProduct);

module.exports = router;
