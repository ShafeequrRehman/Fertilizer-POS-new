# Next.js → React + Vite Migration Report

Target stack delivered: **React 19 (Vite) + React Router + Redux Toolkit + Tailwind CSS v4 + Electron + Express + MongoDB Atlas.**

All existing UI, business logic, API calls, authentication, and state management were preserved as-is. Nothing was rewritten from scratch — every page/component was relocated into `src/` and had only its Next.js-specific imports swapped for Vite/React Router equivalents.

## 1. New architecture

```
Electron  →  Vite dev server (dev) / dist/index.html (prod)  →  Express backend (localhost:5000)  →  MongoDB Atlas
```

- **Routing**: `react-router-dom` with `HashRouter` (not `BrowserRouter`) — required because the packaged Electron app loads `dist/index.html` from a `file://` URL with no server to rewrite deep-link paths on refresh.
- **State**: Redux Toolkit added as a thin wrapper (`src/store/authSlice.ts`) around the existing `lib/auth.ts` session helpers (localStorage/sessionStorage token + cookie). The underlying auth implementation was **not** rewritten — the slice just mirrors it into Redux.
- **Styling**: Tailwind v4 via the official `@tailwindcss/vite` plugin (replaces the old `@tailwindcss/postcss` + `postcss.config.mjs`). `src/index.css` is unchanged from `app/globals.css`.
- **Auth guarding**: The old `proxy.ts` (Next's renamed middleware) + server-component cookie checks in `app/page.tsx` / `app/dashboard/layout.tsx` are replaced by two client-side route wrappers: `src/routes/ProtectedRoute.tsx` (redirects to `/login` if not authenticated) and `src/routes/PublicOnlyRoute.tsx` (redirects `/login` to `/dashboard` if already authenticated). Both use the same `isAuthenticated()` from `lib/auth.ts` that the rest of the app already relied on.

## 2. New files created

| File | Purpose |
|---|---|
| `vite.config.ts` | Vite config: React + Tailwind plugins, `@` → `src/` alias, dev server on port 5173, dev-only proxy for `/api/pos/*` and `/api/system/*` (replaces the old `next.config.ts` rewrites), `base: './'` for Electron's `file://` production loads |
| `index.html` | Vite entry point (replaces `app/layout.tsx`'s `<head>`/metadata) |
| `src/main.tsx` | React root: `Provider` (Redux) → `HashRouter` → `App` |
| `src/App.tsx` | Full route table, replacing Next's App Router filesystem routing |
| `src/index.css` | Copied verbatim from `app/globals.css` |
| `src/vite-env.d.ts` | Vite client types + `import.meta.env` typings |
| `src/store/index.ts`, `src/store/authSlice.ts`, `src/store/hooks.ts` | Redux Toolkit store and typed hooks |
| `src/routes/ProtectedRoute.tsx`, `src/routes/PublicOnlyRoute.tsx` | Client-side auth route guards |

## 3. Files relocated (moved into `src/`, otherwise unchanged)

Zero Next.js dependencies existed in these files — they were copied as-is:

- `lib/*.ts` → `src/lib/*.ts` (api.ts, auth.ts, auth-constants.ts, offline-db.ts, offline-sync.ts, pos-api.ts, pos-settings.ts, pos-store.ts, pos-types.ts, print-logo.ts)
- `components/{ProductManagementSection,WaiterManagementSection,ReceiptManagementSection,OfflineSyncBootstrap}.tsx` → `src/components/`
- `app/dashboard/_components/{OfflineSyncManager,DashboardPageClient,ThermalReceipt}.tsx` → `src/pages/dashboard/components/`
- `app/dashboard/{help,kitchen,accounting,reports,purchase,payroll,management,whatsapp,dues,settings}/page.tsx` → `src/pages/dashboard/*Page.tsx`

## 4. Files relocated **and** edited (Next-specific imports swapped)

| Old file | New file | Change |
|---|---|---|
| `app/login/page.tsx` | `src/pages/LoginPage.tsx` | `next/navigation` → `react-router-dom`; dropped `Suspense` wrapper (not needed outside Next SSR); removed temporary debug `console.log`s added during earlier login debugging |
| `app/dashboard/_components/DashboardShell.tsx` | `src/pages/dashboard/components/DashboardShell.tsx` | `next/link`/`next/navigation` → `react-router-dom`; now a **layout route** rendering `<Outlet/>` instead of a `children` prop |
| `app/dashboard/admin/page.tsx` | `src/pages/dashboard/AdminPage.tsx` | `useRouter` → `useNavigate` |
| `app/dashboard/sales/page.tsx` | `src/pages/dashboard/sales/SalesPage.tsx` | `next/link` → `react-router-dom` `Link to=` |
| `app/dashboard/sales/_components/AddItemsManager.tsx` | `src/pages/dashboard/sales/components/AddItemsManager.tsx` | Removed unused `next/image` import (component never actually used `<Image>`, only plain `<img>`) |
| `app/dashboard/sales/[id]/edit/page.tsx` | `src/pages/dashboard/sales/EditOrderPage.tsx` | `next/link` + `useParams` → `react-router-dom`; `[id]` folder route → `:id` param |
| `app/dashboard/sales/print/[id]/page.tsx` | `src/pages/dashboard/sales/PrintOrderPage.tsx` | Same as above, plus `useSearchParams` |
| `app/dashboard/pos/page.tsx` | `src/pages/dashboard/pos/POSPage.tsx` | Removed unused `next/image` import |
| `app/receipt/print/[id]/page.tsx` | `src/pages/ReceiptPrintPage.tsx` | `useParams`/`useSearchParams` → `react-router-dom` |
| `lib/api.ts` | `src/lib/api.ts` | `process.env.NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_INVOICE_SYNC_ENDPOINT` → `import.meta.env.VITE_API_URL` / `VITE_INVOICE_SYNC_ENDPOINT` (Vite has no `process.env` in the browser bundle — this would have crashed the app at load time if left as-is) |

## 5. Route mapping (old Next path → new React Router path)

| Old (App Router) | New (React Router) |
|---|---|
| `/` | redirects to `/dashboard` (or `/login` via `ProtectedRoute`) |
| `/login` | `/login` |
| `/dashboard` | `/dashboard` (index route, renders `DashboardPageClient`) |
| `/dashboard/pos` | `/dashboard/pos` |
| `/dashboard/sales` | `/dashboard/sales` |
| `/dashboard/sales/[id]/edit` | `/dashboard/sales/:id/edit` |
| `/dashboard/sales/print/[id]` | `/dashboard/sales/print/:id` |
| `/dashboard/{accounting,purchase,management,dues,payroll,reports,admin,settings,whatsapp,help,kitchen}` | same paths, unchanged |
| `/receipt/print/[id]` | `/receipt/print/:id` |

All routes are hash-based in production (`#/dashboard/pos`, etc.) — this is invisible in normal use but will show up in the URL bar if you ever open the built app in a plain browser tab.

## 6. Electron (`main.js`) changes

- Removed the programmatic Next.js server (`require("next")`, `getFreePort`, `nextServer`/`nextPort` state) entirely.
- **Dev mode** (`ELECTRON_DEV_SERVER_URL` set by `npm run dev`): unchanged pattern, just now points at the Vite dev server (`http://localhost:5173`) instead of Next's `http://localhost:3000`.
- **Production / `npm run electron`**: instead of embedding a Next server, Electron now calls `mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))` — the static build produced by `vite build`. This only works because `vite.config.ts` sets `base: './'`, making all asset URLs relative (required under `file://`).
- The Express backend startup logic (`startBackendServer`/`stopBackend`) is untouched.

## 7. `package.json` changes

- **Scripts**: `dev:next` → `dev:vite` (`vite` instead of `next dev --webpack`); `wait-on` now waits on `tcp:5173` instead of `tcp:3000`; `build`/`build:electron` → `vite build`; removed `start`/`start:prod` (no Next server to start in production); added `preview` (`vite preview`).
- **`build.files`** (electron-builder config): `.next/**/*` → `dist/**/*`.
- **Dependencies removed**: `next`, `next-pwa`.
- **Dependencies added**: `@reduxjs/toolkit`, `react-redux`, `react-router-dom`.
- **DevDependencies removed**: `@tailwindcss/postcss`, `eslint-config-next`.
- **DevDependencies added**: `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `@eslint/js`, `globals`, `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`.

## 8. Files deleted

- `app/` (entire Next App Router tree)
- `proxy.ts` (Next 16's renamed middleware)
- `next.config.ts`, `next-env.d.ts`, `next-pwa.d.ts`
- `postcss.config.mjs` (superseded by the `@tailwindcss/vite` plugin)
- `lib/`, `components/` (old root-level copies — now live under `src/`)
- `.next/` build cache, old Next-built `dist/` output
- `tsconfig.tsbuildinfo` (stale Next incremental build cache)
- `public/sw.js`, `public/workbox-4754cb34.js` — the `next-pwa`-generated service worker. It precached `/_next/static/*` chunk URLs that no longer exist. **Important**: see manual step below.

## 9. Other files updated for accuracy

- `tsconfig.json` — rewritten for a plain Vite/React SPA (`moduleResolution: bundler`, `paths: {"@/*": ["./src/*"]}`, no `next` TS plugin).
- `eslint.config.mjs` — rewritten as a standard Vite + React + TypeScript flat config (was `eslint-config-next`).
- `.gitignore` — `.next/`/`/out/` entries replaced with `/dist/`.
- `AGENTS.md` — rewritten to describe the new Vite architecture instead of Next 16's renamed-API warning.
- `README.md` — rewritten from the generic `create-next-app` boilerplate to describe the actual current stack and scripts.

## 10. Manual steps required (must be done on your machine)

1. **Run `npm install`.** The sandbox this migration was built in has no access to the npm registry, so the new packages (`vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `react-router-dom`, and a few devDependencies) could not actually be installed or build-tested here. Everything was validated with a full TypeScript compile (`tsc --noEmit`) against the existing installed packages instead — the entire codebase type-checks cleanly; the only errors reported were "cannot find module" for the four packages awaiting install, nothing else. Run `npm install` in `pos-web/`, then `npm run dev` to bring up Vite + Express + Electron together, exactly like before.
2. **Clear any previously-registered service worker.** The old `next-pwa` service worker (now deleted from `public/`) may still be active in a browser tab or Electron session that loaded the app before this migration. If the app shows a blank screen or stale content after switching to Vite, open DevTools → Application → Service Workers and unregister it (or clear site data), then reload. PWA support was not part of the target stack, so no replacement service worker was added — if you want offline/installable support back later, it would need to be added deliberately for Vite (e.g. `vite-plugin-pwa`).
3. **Verify `.env` if you use `VITE_API_URL` or `VITE_INVOICE_SYNC_ENDPOINT`.** These replace the old `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_INVOICE_SYNC_ENDPOINT` env vars. Neither was actually set in your `.env`/`.env.example` (both were unused optional overrides), so no `.env` change is required unless you were setting them elsewhere.
4. **Functional smoke test** once `npm install` completes: log in, place a POS order, edit/print a sales order, check WhatsApp/customer dues/settings/admin pages, and confirm Electron opens correctly in both `npm run dev` and `npm run electron`. The migration preserved all logic verbatim, but only a static type-check could be run in this environment — a real run is the final confirmation.

## 11. What was intentionally left unchanged

- All backend code (`backend/`) — no changes, still the same Express + Mongoose + MongoDB Atlas API.
- All business logic in `lib/*.ts` (now `src/lib/*.ts`) — copied verbatim, zero edits beyond the two `process.env` → `import.meta.env` fixes in `api.ts`.
- The login lockout system, JWT auth, offline sync (Dexie/IndexedDB), and printing/IPC logic — all untouched.
