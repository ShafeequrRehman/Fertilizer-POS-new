const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Shop = require("../models/Shop");
const License = require("../models/License");
const Role = require("../models/Role");
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyAccessToken,
  REFRESH_TOKEN_TTL_MS,
} = require("../auth/tokenService");

// Tune these two to change lockout behavior. This backs the "3 wrong
// passwords" rule; it is always temporary, never permanent.
const MAX_LOGIN_ATTEMPTS = 3;
const LOCK_DURATION_MS = 60 * 1000; // 1 minute

// Where the frontend should route a user right after a successful login.
// The frontend owns the actual route table (task: frontend auth wiring) -
// this is just a hint so it doesn't have to duplicate the role->route
// mapping in two places.
function redirectPathFor(role) {
  if (role === "superadmin") return "/superadmin";
  return "/dashboard";
}

// Employee permissions are resolved from their assigned Role at the moment
// a token is issued (login or refresh), then denormalized into the JWT -
// see auth/tokenService.js for the tradeoffs of that approach.
async function resolveEmployeePermissions(user) {
  if (user.role !== "employee" || !user.employeeRoleId) return [];
  const role = await Role.findById(user.employeeRoleId);
  return role ? role.permissions : [];
}

async function issueTokenPair(user, permissions) {
  const accessToken = signAccessToken(user, permissions);
  const { token: refreshToken, tokenHash, expiresAt } = generateRefreshToken();

  user.refreshTokenHash = tokenHash;
  user.refreshTokenExpiresAt = expiresAt;
  user.lastLoginAt = new Date();
  await user.save();

  return { accessToken, refreshToken, refreshTokenExpiresAt: expiresAt };
}

function safeUser(user) {
  const obj = user.toObject();
  delete obj.password;
  delete obj.refreshTokenHash;
  delete obj.refreshTokenExpiresAt;
  return obj;
}

// NOTE: There is deliberately no public self-service registration endpoint.
// Account creation now only happens through the admin-mediated flows:
// Super Admin creates Shop Owner accounts (routes/superAdminRoutes.js),
// Shop Owner creates Employee accounts (routes/shopOwnerRoutes.js). Open
// self-registration is incompatible with a licensed, per-shop commercial
// product where every account must be tied to a paying shop.
exports.register = async (req, res) => {
  res.status(410).json({
    message: "Self-service registration is disabled. Accounts are created by the Super Admin (shop owners) or by your Shop Owner (employees).",
    reason: "registration_disabled",
  });
};

// Login sequence, exactly as specified:
// 1. verify username  2. verify password  3. verify user is active
// 4. verify shop is active  5. verify license has not expired
// 6. generate JWT (+ refresh token)  7. tell the frontend where to redirect
exports.login = async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const loginIdentifier = username || email;

    if (!loginIdentifier || !password) {
      return res.status(400).json({ message: "Username/email and password are required", reason: "validation_error" });
    }

    // 1. verify username
    const user = await User.findOne({ $or: [{ username: loginIdentifier }, { email: loginIdentifier }] });
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials", reason: "user_not_found" });
    }

    if (user.lockUntil && user.lockUntil.getTime() > Date.now()) {
      const secondsRemaining = Math.ceil((user.lockUntil.getTime() - Date.now()) / 1000);
      return res.status(423).json({
        message: `Too many failed attempts. Try again in ${secondsRemaining}s.`,
        reason: "account_locked",
        lockUntil: user.lockUntil,
        secondsRemaining,
      });
    }

    // 2. verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const attempts = (user.failedLoginAttempts || 0) + 1;

      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        user.failedLoginAttempts = 0;
        user.lockUntil = new Date(Date.now() + LOCK_DURATION_MS);
        await user.save();

        const secondsRemaining = Math.ceil(LOCK_DURATION_MS / 1000);
        return res.status(423).json({
          message: `Too many failed attempts. Try again in ${secondsRemaining}s.`,
          reason: "account_locked",
          lockUntil: user.lockUntil,
          secondsRemaining,
        });
      }

      user.failedLoginAttempts = attempts;
      user.lockUntil = null;
      await user.save();

      const attemptsRemaining = MAX_LOGIN_ATTEMPTS - attempts;
      return res.status(400).json({
        message: `Invalid credentials. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} remaining before a temporary lock.`,
        reason: "wrong_password",
        attemptsRemaining,
      });
    }

    // Successful password match clears any prior failure state.
    if (user.failedLoginAttempts || user.lockUntil) {
      user.failedLoginAttempts = 0;
      user.lockUntil = null;
      await user.save();
    }

    // 3. verify user is active
    if (!user.isActive) {
      return res.status(403).json({
        message: "This account has been deactivated. Contact your Shop Owner or the software provider.",
        reason: "user_inactive",
      });
    }

    // Super Admin has no shop - skip straight to token issuance.
    if (user.role === "superadmin") {
      const { accessToken, refreshToken, refreshTokenExpiresAt } = await issueTokenPair(user, []);
      return res.json({
        accessToken,
        refreshToken,
        refreshTokenExpiresAt,
        user: safeUser(user),
        redirectTo: redirectPathFor(user.role),
      });
    }

    // Shop Owner / Employee: shop + license must both check out.
    const shop = await Shop.findById(user.shopId);
    if (!shop) {
      return res.status(403).json({ message: "No shop is associated with this account. Contact the software provider.", reason: "shop_not_found" });
    }

    // 4. verify shop is active
    if (shop.status === "suspended") {
      return res.status(402).json({
        message: "Your shop has been suspended by the software provider. Please contact support to reactivate your account.",
        reason: "shop_suspended",
        shop: { name: shop.name, status: shop.status },
      });
    }

    // 5. verify license has not expired
    const license = await License.findOne({ shopId: shop._id });
    if (!license || license.isExpired()) {
      return res.status(402).json({
        message: "Your license has expired. Please contact the software provider to renew your subscription before continuing.",
        reason: license ? "license_expired" : "license_missing",
        shop: { name: shop.name },
        license: license ? { status: license.status, expiryDate: license.expiryDate } : null,
      });
    }

    // 6. generate JWT (+ refresh token)
    const permissions = await resolveEmployeePermissions(user);
    const { accessToken, refreshToken, refreshTokenExpiresAt } = await issueTokenPair(user, permissions);

    // 7. redirect according to role
    res.json({
      accessToken,
      refreshToken,
      refreshTokenExpiresAt,
      user: safeUser(user),
      shop: { id: shop._id, name: shop.name, status: shop.status },
      license: { status: license.status, expiryDate: license.expiryDate },
      permissions,
      redirectTo: redirectPathFor(user.role),
    });
  } catch (error) {
    res.status(500).json({ message: "Server error during login", reason: "server_error", detail: error.message });
  }
};

// Exchanges a still-valid refresh token for a new access token (and
// rotates the refresh token, so a stolen-but-unused refresh token becomes
// worthless the next time the legitimate client refreshes). Re-checks
// active/shop/license state too, since a shop could be suspended or expire
// while the user's tab is still open with an old access token.
exports.refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ message: "Refresh token is required", reason: "validation_error" });
    }

    const tokenHash = hashRefreshToken(refreshToken);
    const user = await User.findOne({ refreshTokenHash: tokenHash });

    if (!user || !user.refreshTokenExpiresAt || user.refreshTokenExpiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: "Refresh token is invalid or expired. Please log in again.", reason: "invalid_refresh_token" });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "This account has been deactivated.", reason: "user_inactive" });
    }

    if (user.role !== "superadmin") {
      const shop = await Shop.findById(user.shopId);
      if (!shop || shop.status === "suspended") {
        return res.status(402).json({ message: "Your shop has been suspended.", reason: "shop_suspended" });
      }
      const license = await License.findOne({ shopId: shop._id });
      if (!license || license.isExpired()) {
        return res.status(402).json({ message: "Your license has expired.", reason: license ? "license_expired" : "license_missing" });
      }
    }

    const permissions = await resolveEmployeePermissions(user);
    const { accessToken, refreshToken: newRefreshToken, refreshTokenExpiresAt } = await issueTokenPair(user, permissions);

    res.json({ accessToken, refreshToken: newRefreshToken, refreshTokenExpiresAt, permissions });
  } catch (error) {
    res.status(500).json({ message: "Server error during token refresh", detail: error.message });
  }
};

// Invalidates the current refresh token server-side. The access token
// itself can't be revoked early (it's stateless), but it's short-lived
// (2h) and the client is expected to discard it immediately on logout.
exports.logout = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const tokenHash = hashRefreshToken(refreshToken);
      await User.updateOne({ refreshTokenHash: tokenHash }, { refreshTokenHash: null, refreshTokenExpiresAt: null });
    } else if (req.user?.id) {
      await User.updateOne({ _id: req.user.id }, { refreshTokenHash: null, refreshTokenExpiresAt: null });
    }
    res.json({ message: "Logged out" });
  } catch (error) {
    res.status(500).json({ message: "Server error during logout", detail: error.message });
  }
};

// Lightweight "who am I" - lets the frontend rehydrate user/shop/license
// state on app load from a stored access token without re-sending
// credentials. Requires the `authenticate` middleware to already have run.
exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.role === "superadmin") {
      return res.json({ user: safeUser(user) });
    }

    const shop = await Shop.findById(user.shopId);
    const license = shop ? await License.findOne({ shopId: shop._id }) : null;

    res.json({
      user: safeUser(user),
      shop: shop ? { id: shop._id, name: shop.name, status: shop.status } : null,
      license: license ? { status: license.status, expiryDate: license.expiryDate, isExpired: license.isExpired() } : null,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", detail: error.message });
  }
};
