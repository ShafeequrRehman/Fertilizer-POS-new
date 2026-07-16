// requirePermission("sales.create") etc. Super Admin and Shop Owner always
// pass (a Shop Owner can never be locked out of their own shop's data).
// Employees must have the permission key in the `permissions` array that
// was embedded in their access token at login (see auth/tokenService.js
// and controllers/authController.js) - which mirrors their assigned
// Role.permissions at the time the token was issued.
function requirePermission(key) {
  return function permissionGuard(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ message: "Not authorized" });
    }

    if (req.user.role === "superadmin" || req.user.role === "shopowner") {
      return next();
    }

    if (req.user.role === "employee" && Array.isArray(req.user.permissions) && req.user.permissions.includes(key)) {
      return next();
    }

    return res.status(403).json({ message: `Missing required permission: ${key}`, reason: "missing_permission", permission: key });
  };
}

module.exports = requirePermission;
