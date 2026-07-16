<!-- BEGIN:vite-agent-rules -->
# This app is React + Vite, not Next.js

This project was migrated off Next.js (App Router) to a plain React 19 + Vite SPA, with React Router (HashRouter), Redux Toolkit, and Tailwind CSS v4 via `@tailwindcss/vite`. There is no App Router, no server components, no `next/*` imports, and no Next.js build step anywhere in this app. All source lives under `src/`; routes are defined explicitly in `src/App.tsx` instead of the filesystem. Do not reintroduce `next/link`, `next/navigation`, `next/image`, or similar - use `react-router-dom` and plain `<img>` instead.
<!-- END:vite-agent-rules -->
