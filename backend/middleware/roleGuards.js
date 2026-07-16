// Role-based authorization guards. Always run authenticate() first - these
// read req.user, which authenticate() populates from the verified JWT.

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== "superadmin") {
    return res.status(403).json({ message: "Super Admin access required" });
  }
  next();
}

// Shop Owner-only actions (e.g. managing employees/roles). Super Admin is
// intentionally NOT allowed through this guard - the Super Admin manages
// shops, not a shop's day-to-day staff, keeping the boundary between "runs
// the software" and "runs a shop" clean and auditable.
function requireShopOwner(req, res, next) {
  if (!req.user || req.user.role !== "shopowner") {
    return res.status(403).json({ message: "Shop Owner access required" });
  }
  next();
}

// Shop Owner or Employee - i.e. "belongs to a shop", used for ordinary
// POS routes (products, sales, customers, etc.) before the more specific
// requirePermission() check for employees.
function requireShopMember(req, res, next) {
  if (!req.user || (req.user.role !== "shopowner" && req.user.role !== "employee")) {
    return res.status(403).json({ message: "Shop access required" });
  }
  if (!req.user.shopId) {
    return res.status(403).json({ message: "No shop associated with this account" });
  }
  next();
}

module.exports = { requireSuperAdmin, requireShopOwner, requireShopMember };
