const jwt = require("jsonwebtoken");
const crypto = require("crypto");

// Access tokens are short-lived and carry everything a request needs to
// know about the caller (id, role, shopId, employeeRoleId) so most routes
// never need to hit the database just to find out who's asking. Refresh
// tokens are long-lived, opaque, single-use-per-rotation, and only ever
// stored on the server as a SHA-256 hash (see User.refreshTokenHash) -
// exactly like a password, so a leaked database dump doesn't hand out
// usable refresh tokens.
const ACCESS_TOKEN_TTL = "2h";
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// `permissions` (only meaningful for role === "employee") is denormalized
// into the token at sign time from the employee's assigned Role, so
// requirePermission() can check it with zero extra database round-trips
// on every request. The tradeoff: if a Shop Owner changes an employee's
// role permissions mid-session, the change takes effect the next time
// that employee's token is refreshed/re-issued (at most ACCESS_TOKEN_TTL
// later), not instantly. That's an acceptable, common tradeoff for a 2h
// access token lifetime.
function signAccessToken(user, permissions = []) {
  return jwt.sign(
    {
      id: String(user._id),
      role: user.role,
      shopId: user.shopId ? String(user.shopId) : null,
      employeeRoleId: user.employeeRoleId ? String(user.employeeRoleId) : null,
      permissions: user.role === "employee" ? permissions : undefined,
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function generateRefreshToken() {
  const token = crypto.randomBytes(48).toString("hex");
  const tokenHash = hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  return { token, tokenHash, expiresAt };
}

function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_MS,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
};
