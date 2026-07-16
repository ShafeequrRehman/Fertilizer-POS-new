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
});
