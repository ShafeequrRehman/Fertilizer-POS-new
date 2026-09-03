import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Vite config for the POS desktop app.
//
// - `base: './'` is required so the production build's asset URLs are
//   relative. Electron loads the packaged app from a `file://` URL, and
//   absolute `/assets/...` URLs (Vite's default) do not resolve under
//   `file://`.
// - The dev server listens on a fixed port (5173) so `main.js` and the
//   `wait-on`/`concurrently` scripts in package.json can rely on it.
// - The `@` alias points at `src/`, matching the previous Next.js
//   `"@/*": ["./*"]` path mapping (previously rooted at the project root,
//   now rooted at `src/` since all app code lives under `src/`).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // @react-pdf/renderer (used from src/lib/pdf-export.tsx) pulls in
      // js-md5 as a transitive dependency, which does
      // `require('buffer').Buffer` at module-load time. Vite/esbuild's
      // dependency pre-bundler treats a bare 'buffer' specifier as an
      // unresolved Node built-in for the browser platform rather than
      // resolving it to the actual npm `buffer` polyfill package already
      // installed here, so that require() call returns an object with no
      // `.Buffer`, and `Buffer.from` throws `Cannot read properties of
      // undefined (reading 'from')` - this crashed the whole app at
      // startup once pdf-export was on the static import graph. This
      // alias forces the bare specifier to resolve to the real polyfill.
      buffer: path.resolve(__dirname, 'node_modules/buffer/index.js'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // The WhatsApp integration (backend/services/whatsappService.js) writes
    // its session/credential files to `.auth_whatsapp/` at the project
    // root every time it re-keys (roughly once a minute while connected).
    // Vite's dev watcher was picking those writes up as project file
    // changes and forcing a full page reload each time ("[vite] page
    // reload .auth_whatsapp/creds.json" in the terminal) - which wiped out
    // whatever the user was typing into a form. `backend/**` is excluded
    // too since backend source changes don't require a frontend reload.
    watch: {
      ignored: ['**/.auth_whatsapp/**', '**/backend/**'],
    },
    // Replaces the old next.config.ts `rewrites()` proxy. lib/api.ts calls
    // relative `/api/pos/*` and `/api/system/*` paths when running as a
    // plain browser tab (not inside Electron, e.g. `npm run dev:web`) -
    // Electron itself always talks to `http://localhost:5000` directly and
    // doesn't need this proxy.
    proxy: {
      '/api/pos': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (requestPath: string) => requestPath.replace(/^\/api\/pos/, '/api'),
      },
      '/api/system': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (requestPath: string) => requestPath.replace(/^\/api\/system/, '/api'),
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  optimizeDeps: {
    // Force the `buffer` alias above into the dependency pre-bundle
    // upfront rather than waiting for Vite to discover it lazily on first
    // use (Download PDF is behind a dynamic import, so a lazy discovery
    // would otherwise trigger a dev-server reload mid-download the first
    // time it's clicked in a fresh session).
    include: ['buffer'],
    esbuildOptions: {
      // A couple of Node-oriented libraries in this dependency tree
      // (reached only through @react-pdf/renderer) reference the bare
      // `global` identifier, which doesn't exist in a browser bundle.
      // Standard companion polyfill alongside the `buffer` alias above.
      define: { global: 'globalThis' },
    },
  },
});
