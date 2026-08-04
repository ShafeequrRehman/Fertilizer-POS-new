# Deploying the backend to the Ubuntu server

This moves `backend/` off the till and onto the always-on Ubuntu server at
`sybersoc.duckdns.org`, reachable at `https://sybersoc.duckdns.org/pos/`.
nginx there already has a `/pos/` location reserved, proxying to
`localhost:5001` (see `/etc/nginx/sites-enabled/myapp` on that server) -
this deploy just needs something actually listening on 5001.

Once this is live, every till and the mobile app talk to this one URL
instead of a local/LAN backend. Printing and WhatsApp implications are
covered at the bottom - read that before going live for real.

## 1. Copy the code to the server

From PowerShell on the till PC (adjust the path if different):

```powershell
ssh ali-haider@sybersoc.duckdns.org "mkdir -p ~/pos-backend"
scp -r "C:\Users\Ali Haider\Desktop\POS-SYSTEM\pos-web\backend" ali-haider@sybersoc.duckdns.org:~/pos-backend/backend
scp "C:\Users\Ali Haider\Desktop\POS-SYSTEM\pos-web\package.json" ali-haider@sybersoc.duckdns.org:~/pos-backend/package.json
scp "C:\Users\Ali Haider\Desktop\POS-SYSTEM\pos-web\package-lock.json" ali-haider@sybersoc.duckdns.org:~/pos-backend/package-lock.json
```

(Only `backend/` + the two package files are needed - not the whole
`pos-web` folder. `node_modules` is deliberately not copied; it gets
installed fresh on the server below.)

## 2. Install dependencies on the server

SSH in (`ssh ali-haider@sybersoc.duckdns.org`), then:

```bash
cd ~/pos-backend
npm install --omit=dev --ignore-scripts
```

`--omit=dev` skips Electron/Vite/etc. (dev-only, irrelevant on a headless
server). `--ignore-scripts` skips the `postinstall` step
(`electron-builder install-app-deps`) - that step is for preparing a
desktop build and has no business running on this server; without
`--ignore-scripts` it can fail or hang trying to do Electron-related work
that doesn't apply here.

## 3. Create the server's own `.env`

This is separate from the till's `.env` - different `PORT`, and no
`VITE_API_URL` (that variable only matters to the till/mobile clients).

```bash
cat > ~/pos-backend/.env << 'EOF'
MONGO_URI=mongodb://alihaider:oWEyNc5sKeix5Vld@ac-zsqqrry-shard-00-00.kz4tizq.mongodb.net:27017,ac-zsqqrry-shard-00-01.kz4tizq.mongodb.net:27017,ac-zsqqrry-shard-00-02.kz4tizq.mongodb.net:27017/masterpos?ssl=true&authSource=admin&retryWrites=true&w=majority&appName=Cluster23

JWT_SECRET=58c1697eed74916f61d7e8702b294617d3fd414272f9b30ff85244a0a860562d5d764b4e964c60e64855aaad9ec172969295a306e80a014ea0ff6377d5d521d8

PORT=5001
EOF
```

(Same `JWT_SECRET` as the till's `.env` - keeps this a drop-in swap rather
than invalidating every existing login. Same `MONGO_URI` - same database,
nothing about the data itself is changing.)

## 4. Start it with pm2

```bash
cd ~/pos-backend
pm2 start backend/index.js --name pos-backend
pm2 save
```

`pm2 save` persists this alongside the existing `myapp-backend` process so
it survives a server reboot (pm2's startup hook is already configured on
this machine - that's how `myapp-backend` itself stays running).

## 5. Verify

```bash
curl http://localhost:5001/
```
Should print `POS Backend Running ...`. Then from anywhere (even your
phone, off WiFi entirely):
```
https://sybersoc.duckdns.org/pos/
```
should show the same thing in a browser.

## 6. Point the clients at it

- **pos-web (Electron/till):** already done in this codebase -
  `pos-web/.env` now has `VITE_API_URL=https://sybersoc.duckdns.org/pos/api`,
  and `main.js`/`src/lib/api.ts` were updated to use it and skip starting
  a local backend. This only takes effect on the **next rebuild**:
  `npm run electron:build`, then reinstall on each till.
- **pos-mobile:** open the app, go back to the server settings screen
  (or clear app data to see it again), enter
  `https://sybersoc.duckdns.org/pos`.

## Printing - unaffected

Printing (`main.js`'s IPC handlers, `pdf-to-printer`) never went through
the backend API to begin with - the renderer already has the order data
in memory and hands it straight to the Electron main process, which talks
to the printer directly. Moving the backend off the till changes nothing
about printing.

## WhatsApp - needs a one-time re-link

`backend/services/whatsappService.js` stores its session under
`.auth_whatsapp/` next to wherever the backend process runs. That folder
now lives on the server (`~/pos-backend/.auth_whatsapp/`) instead of the
till, so the very first time this runs on the server it has no existing
session - go to WhatsApp settings in the app and scan the QR code once
more. After that it behaves the same as before (see the existing
single-shared-connection limitation noted in `whatsappRoutes.js` - that
limitation is unchanged by this move).

## Rolling back

If anything goes wrong: delete/comment out `VITE_API_URL` in
`pos-web/.env`, rebuild the Electron app, and it goes back to running its
own local backend exactly as before. The server-hosted backend can keep
running in the background either way - nothing about this is destructive
to the existing local-backend setup.
