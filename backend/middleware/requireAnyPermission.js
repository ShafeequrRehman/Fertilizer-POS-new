// requireAnyPermission("purchases.manage", "stock.manage") etc. - same
// short-circuit rules as requirePermission.js (Super Admin and Shop Owner
// always pass), but for routes that more than one distinct permission key
// should unlock. Introduced for the Stock Manager role (config/
// permissions.js), whose narrower `stock.manage` key needs to satisfy
// exactly the same ingredient/purchase routes that `inventory.manage` /
// `purchases.manage` already gate for Manager/Store Keeper - without
// widening what THOSE existing keys unlock. Kept as its own middleware
// rather than changing requirePermission(key) to accept an array, so every
// existing single-key call site stays untouched.
function requireAnyPermission(...keys) {
  return function anyPermissionGuard(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ message: "Not authorized" });
    }

    if (req.user.role === "superadmin" || req.user.role === "shopowner") {
      return next();
    }

    if (req.user.role === "employee" && Array.isArray(req.user.permissions) && keys.some((key) => req.user.permissions.includes(key))) {
      return next();
    }

    return res.status(403).json({ message: `Missing required permission (any of): ${keys.join(", ")}`, reason: "missing_permission", permissions: keys });
  };
}

module.exports = requireAnyPermission;
