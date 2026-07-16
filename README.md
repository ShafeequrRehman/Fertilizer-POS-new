# POS System

Desktop-first restaurant POS built with React 19 (Vite), React Router, Redux Toolkit, Tailwind CSS v4, Electron, Express, and MongoDB Atlas.

## Getting Started

```bash
npm install
npm run dev
```

`npm run dev` starts three processes together (Vite dev server, the Express backend, and Electron attached to both). Electron opens automatically; there is nothing to open manually in a browser unless you want to test outside Electron, in which case use:

```bash
npm run dev:web
```

and open http://localhost:5173.

## Building

```bash
npm run build          # vite build -> dist/
npm run electron:build # build + package the Electron app with electron-builder
```

## Project layout

- `src/` - all application source (pages, components, lib, store, routes)
- `src/App.tsx` - route table (React Router, HashRouter)
- `src/store/` - Redux Toolkit store and auth slice
- `backend/` - Express API server, talks directly to MongoDB Atlas
- `main.js` - Electron main process
