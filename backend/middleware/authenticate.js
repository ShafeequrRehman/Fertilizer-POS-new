const { verifyAccessToken } = require("../auth/tokenService");

// Replaces the old middlewares/authMiddleware.js. Verifies the access
// token and attaches its payload (id, role, shopId, employeeRoleId) to
// req.user. Does NOT hit the database - keep this fast, since it runs on
// almost every request. Role/permission/license checks are separate
// middleware layered on top (requireSuperAdmin, requireShopOwner,
// requirePermission, requireLicenseValid) so each route only pays for the
// checks it actually needs.
module.exports = function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Not authorized" });
  }

  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    const expired = error.name === "TokenExpiredError";
    return res.status(401).json({
      message: expired ? "Session expired" : "Invalid token",
      reason: expired ? "token_expired" : "invalid_token",
    });
  }
};
