# Multi-Tenant Authentication & Licensing Architecture

This document covers the redesign of `pos-web` from a single-tenant admin/user login into a
three-tier, multi-tenant commercial SaaS POS system: **Super Admin** (you, the software
provider), **Shop Owner** (each customer), and **Employee** (staff created by a Shop Owner).

The existing UI, pages, and POS features were preserved and refactored in place — nothing was
rewritten from scratch.

## 1. Database Schema Changes

Every business-data collection now carries a required, indexed `shopId` (`Product`, `Customer`,
`Order`, `Waiter`, plus the new `Purchase`, `Expense`, `Supplier`, `Role`). Uniqueness
constraints that used to be global were rescoped to be per-shop:

- `Customer`: `phone` unique index changed from global to compound `{ shopId, phone }`.
- `Waiter`: `name` unique index changed from global to compound `{ shopId, name }`.

`User` was rewritten: `role` is now a required enum (`superadmin` | `shopowner` | `employee`,
no default), with `shopId` (nullable, only null for Super Admin), `employeeRoleId` (links an
Employee to their `Role`), `isActive`, `lastLoginAt`, and refresh-token fields
(`refreshTokenHash`, `refreshTokenExpiresAt` — only the SHA-256 hash is ever stored, mirroring
password hashing).

## 2. New Mongoose Models (`backend/models/`)

| Model | Purpose |
|---|---|
| `Shop` | One per tenant. `name`, `ownerUserId`, contact info, `status` (active/suspended), `planId`, `licenseId`. |
| `License` | One per shop. `startDate`, `expiryDate`, `status` (trial/active/expired/suspended), `renewalHistory[]`, `isExpired()` method. |
| `Plan` | Subscription tiers Super Admin defines (price, duration, max employees, features). |
| `Payment` | Internal-only payment record (no gateway integration, per your instruction). |
| `Permission` | Catalog collection, seeded from `backend/config/permissions.js`. |
| `Role` | Per-shop, named set of permission keys (e.g. Cashier, Manager). Compound unique `{shopId, name}`. |
| `Supplier`, `Purchase`, `Expense` | Shop-scoped business records (backend CRUD built; see Scope Notes below on frontend wiring). |
| `SystemSettings` | Singleton doc backing "Manage Software Settings". |

**Design decision — one `User` collection, not three.** All three tiers share a single
collection distinguished by `role`, rather than separate schemas per tier. Employees are
genuinely login-capable users (username/password/JWT/lockout), so a second parallel auth system
would duplicate all of that logic for no benefit. This is documented in `models/User.js`.

## 3. Backend Folder Structure

```
backend/
  auth/            tokenService.js (JWT + refresh token issuance/verification)
  config/          db.js, seed.js, permissions.js (permission catalog + default role presets)
  controllers/      one per resource, all shop-scoped
  middleware/       authenticate, roleGuards, requirePermission, requireLicenseValid, attachShopScope
  models/           all Mongoose schemas
  routes/           one per resource
  scripts/          migrateToMultiTenant.js, resetAdminPassword.js
  services/         whatsappService.js
```

## 4. Middleware (`backend/middleware/`)

- `authenticate.js` — verifies the JWT, populates `req.user` (`{id, role, shopId, employeeRoleId, permissions}`).
- `roleGuards.js` — `requireSuperAdmin`, `requireShopOwner`, `requireShopMember` (shopowner or employee).
- `requirePermission(key)` — Super Admin/Shop Owner always pass; Employees must have `key` in their token's `permissions[]`.
- `requireLicenseValid` — re-checks the shop's `status` and `License.isExpired()` **on every request**, independent of the access token's 2h lifetime. Returns `402` with a machine-readable `reason` (`license_expired`, `shop_suspended`, `license_missing`).
- `attachShopScope.js` — `shopScope(req)` helper every controller uses to build `{shopId: req.user.shopId}` — the single source of truth for tenant isolation, trusting only the verified JWT, never the request body.

## 5. Authentication Flow

`POST /api/auth/login` — exactly the 7 steps specified:

1. Look up user by username/email.
2. `bcrypt.compare` password (existing 3-attempt lockout preserved).
3. Check `user.isActive`.
4. Check `shop.status === 'active'` (skipped for Super Admin, who has no shop).
5. Check `License.isExpired()`.
6. Issue a 2h JWT access token (`signAccessToken`) + a 30-day opaque refresh token (stored server-side only as a SHA-256 hash).
7. Response includes `redirectTo` (`/superadmin` or `/dashboard`) for the frontend.

If step 4 or 5 fails, the response is `402` with a professional message and shop/license
details — **no token is issued**, so a locked-out shop never gets dashboard access at all, not
even a fleeting flash of it.

Additional endpoints: `POST /auth/refresh` (rotates the refresh token, re-checks
active/shop/license state), `POST /auth/logout` (invalidates the stored refresh-token hash),
`GET /auth/me` (session rehydration). **Self-service `POST /auth/register` is now disabled**
(`410 Gone`) — accounts are only created by Super Admin (shop owners) or Shop Owner (employees).

## 6. License Validation Flow (defense in depth)

1. **At login** — blocks token issuance entirely (see above).
2. **On every shop-data request** — `requireLicenseValid` middleware re-queries `Shop`/`License` server-side, so a shop that expires mid-session is blocked immediately, not just at next login.
3. **Client-side** — `ProtectedRoute` checks the cached license on route entry (instant redirect, no flash of the dashboard), and the axios response interceptor redirects to `/license-expired` on any `402` from the API.

`src/pages/LicenseExpiredPage.tsx` shows shop name, license status, and expiry date, with a
professional "contact the software provider" message — no dashboard content is reachable from
it.

## 7. Role & Permission System

`backend/config/permissions.js` is the canonical catalog (15 keys across Sales, Inventory,
Customers, Purchasing, Accounting, Reports, Employees, Settings). Employee permissions are
resolved from their assigned `Role` at login/refresh time and **denormalized into the JWT**, so
`requirePermission` never needs a DB round-trip. Documented tradeoff: a permission change to an
already-logged-in employee's role takes effect on their next token refresh (≤2h), not instantly.

Default role presets (Cashier, Manager, Accountant, Store Keeper) are seeded automatically for
every new shop, editable/deletable by the Shop Owner afterward.

## 8. Frontend Changes

- **`lib/auth.ts`** — rewritten session layer: access token, refresh token, role, shopId, user,
  shop, license, permissions, all persisted to localStorage+sessionStorage+cookie. New
  `hasPermission(key)` helper.
- **`lib/api.ts`** — axios interceptor now attempts a silent token refresh on `401` before
  logging out, and redirects to `/license-expired` on any `402`.
- **`store/authSlice.ts`** — extended Redux state (role/shopId/shop/license/permissions).
- **`routes/ProtectedRoute.tsx`** — now takes `allowedRoles` to gate `/dashboard/*` (Shop
  Owner + Employee) vs `/superadmin/*` (Super Admin only).
- **`routes/RequirePermission.tsx`** (new) — per-route permission gate for Employee-restricted pages.
- **`pages/dashboard/components/DashboardShell.tsx`** — nav items now filtered by
  `hasPermission()`; Shop Owner sees everything, Employees see only what their Role grants.
  Added an "Employees" nav item (Shop Owner only).
- **`pages/dashboard/EmployeesPage.tsx`** (new) — Shop Owner UI for employee CRUD, password
  reset, and Role management with a permission-checkbox editor grouped by module.
- **`pages/superadmin/`** (new tree) — `SuperAdminShell`, `OverviewPage` (stats), `ShopsPage`
  (create shop+owner+license in one flow, activate/suspend, extend license, reset owner
  password), `PlansPage`, `PaymentsPage`, `LogsPage`, `SettingsPage`.

## 9. Modified Files (existing, not new)

`backend/index.js`, `backend/config/seed.js`, `backend/controllers/authController.js`,
`backend/routes/authRoutes.js`, `backend/models/{Product,Customer,Order,Waiter,User}.js`, every
existing controller/route pair that needed shop scoping (`product`, `customer`, `order`,
`invoice`, `waiter`), `package.json` (added `migrate` script — no new dependencies were needed;
`jsonwebtoken`, `bcryptjs`, and Node's built-in `crypto` already covered everything), `src/App.tsx`,
`src/lib/auth.ts`, `src/lib/api.ts`, `src/store/authSlice.ts`, `src/pages/LoginPage.tsx`,
`src/routes/ProtectedRoute.tsx`, `src/routes/PublicOnlyRoute.tsx`,
`src/pages/dashboard/components/DashboardShell.tsx`.

A pre-existing bug was also fixed along the way: `backend/routes/customerRoutes.js` had **no
authentication at all** on `/search`, `/` (GET), and `/` (POST) — any unauthenticated caller
could read or create customer records. Adding shop scoping required adding auth everywhere,
which closed that gap as a side effect.

## 10. Data Migration

`backend/scripts/migrateToMultiTenant.js` — idempotent (checks `Shop.countDocuments()` first;
safe to re-run). What it does:

1. Seeds the Permission catalog and a default "Standard" Plan.
2. Creates one Shop ("The Heaven Slice", using your existing receipt header/address as the
   real business identity) with a 12-month active License.
3. **Converts `admin`/`admin123` into the Super Admin** (`role: "superadmin"`, `shopId: null`) —
   per your explicit answer to keep that login as Super Admin.
4. **Creates a brand-new, separate Shop Owner account** for the shop, with a freshly generated
   password (printed to the console when the script runs — nowhere else).
5. Seeds the shop's default Roles (Cashier/Manager/Accountant/Store Keeper).
6. Tags every existing `Product`/`Customer`/`Order`/`Waiter` document with the new `shopId`.

> **Note on your Q1/Q2 answers:** you selected "migrate into a default shop" (which described
> turning your admin login into the Shop Owner) *and separately* "keep admin/admin123 as Super
> Admin." Those two conflict on one specific point — what happens to the admin account. I
> resolved it in favor of your more specific answer: **admin/admin123 becomes Super Admin**, and
> the shop instead gets a **new, separate Shop Owner account** the script generates for you.
> Flagging this explicitly since it wasn't a literal reading of the first option's description.

### Running it

**I could not run this migration for you.** This sandbox's network is restricted to an
allowlist that does not include MongoDB Atlas (the same restriction that blocked `npm install`
during the earlier Vite migration). The script is written, syntax-validated, and ready — run it
yourself from the `pos-web` folder on your machine, where the real database is reachable:

```
npm run migrate
```

It will print the Super Admin and new Shop Owner credentials to the console. **Save the Shop
Owner password immediately** — it is not stored anywhere in plaintext and cannot be recovered,
only reset.

## 11. Known Scope Limitations (flagged, not silently skipped)

- **WhatsApp integration is still a single global connection**, not per-shop. I added
  authentication to its routes (previously it had none), but every shop currently shares
  whichever WhatsApp number is connected to this backend instance. A proper fix needs a
  per-shop session pool — out of scope for an auth/licensing pass, flagging it here rather than
  leaving it as a silent gap.
- **Purchase/Expense/Supplier** have full backend CRUD + shop scoping + permission gating, but
  their frontend pages (`PurchasePage.tsx`, `AccountingPage.tsx`) are still the pre-existing
  mock-data UIs from before this task — wiring them to the new endpoints is a separate feature
  from "redesign authentication and licensing."
- **`AdminPage.tsx`** (the old single-tier "Admin Users" page, calling a `/users` endpoint that
  never existed as a real route) is superseded by the new Employees page + Super Admin Shops
  page. It's left in place per "don't delete existing pages," but no longer linked from the nav.
- **There's no standing audit-log collection.** The Super Admin "Logs" page is a best-effort
  feed assembled from License renewal history + Payment records, not a full request-level audit
  trail.

## 12. Production Readiness Checklist

- [x] JWT + bcrypt, short-lived access tokens, hashed refresh tokens
- [x] Every business collection scoped by `shopId`, enforced server-side (not just UI-hidden)
- [x] License enforcement at login *and* on every request (not just once)
- [x] Role-based authorization middleware, permission catalog is DB-backed and extensible
- [x] Self-registration disabled — no way to create an unlicensed account
- [x] Migration script is idempotent and safe to re-run
- [ ] **You must run `npm run migrate` yourself** (network restriction, see §10)
- [ ] WhatsApp per-shop isolation (flagged, not built — see §11)
- [ ] Purchase/Expense/Supplier frontend wiring (flagged, not built — see §11)
