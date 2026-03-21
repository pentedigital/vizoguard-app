# VizoGuard Desktop App

## Stack
- Electron app (`main.js` entry, `preload.js` bridge)
- Cross-platform: `src/platform/` — darwin.js, win32.js, index.js (auto-selects)
- Core modules: `src/core/` — threat-checker, immune-system, connection-monitor, proxy (barrel export: `src/core/index.js`)
- VPN client: `src/vpn.js` — Shadowsocks/Outline protocol via `ss://` URLs
- License management: `src/license.js`
- Auto-updater: `src/updater.js` — GitHub Releases feed (HTTPS)
- API client: `src/api.js` — all backend calls, base URL: `https://vizoguard.com/api`
- Persistent storage: `electron-store` (user preferences, license data)
- System tray: `src/tray.js`
- UI: `ui/` — dashboard, activate, expired pages
- Build config: `electron-builder.yml`
- Entitlements: `build/entitlements.mac.plist` (macOS code signing)
- CI/CD: `.github/workflows/build.yml`

## App Config
- appId: `com.vizoguard.app` (version in `package.json`)
- Window: 420x700, frameless, not resizable
- Single-instance enforced — second launch focuses existing window
- macOS: dock hidden, tray-only
- Publish: GitHub Releases (owner: pentedigital, repo: vizoguard-app)
- Mac targets: DMG (x64 + arm64) | Win target: NSIS installer (x64)

## Ports
- Security proxy: `127.0.0.1:8888` (HTTP/HTTPS filtering)
- SOCKS5 VPN proxy: `127.0.0.1:1080`

## Threat Detection
- 8 analysis vectors in `src/core/threat-checker.js`: blocklist, suspicious TLDs, brand impersonation, IP-in-URL, excessive subdomains, dangerous downloads, homoglyphs, phishing keywords
- LRU cache: 10k entries, 1hr TTL
- Risk levels: critical > high > medium > low

## Security Rules
- Context isolation enforced — all renderer communication via preload.js IPC bridge
- IPC event listeners cleaned up on page load (`removeAllListeners` before `on`) to prevent accumulation
- VPN access URLs contain auth credentials — never log or expose
- `openExternal` restricted to vizoguard.com, getoutline.org, and exact `mailto:support@vizoguard.com`
- CONNECT tunnel port-whitelisted to 80/443 only — loopback/private IPs blocked to prevent SSRF
- VPN host validated on connect — rejects loopback/private IP ranges

## Commands
- `npm install` — install dependencies
- `npm start` — run in dev mode (see `package.json` scripts)
- To test against local backend: temporarily change `API_BASE` in `src/api.js` to `http://localhost:3000/api` — **do not commit this change**
- `npm run build:mac` / `npm run build:win` — build installers

## Deploy
- Push to `main` triggers GitHub Actions: builds Mac DMG + Win EXE (deploy step fails — Hostinger blocks GitHub IPs)
- Manual deploy: `gh run download <RUN_ID> --repo pentedigital/vizoguard-app -D /tmp/build && cp /tmp/build/mac-dmg/*.dmg /var/www/vizoguard/downloads/ && cp /tmp/build/win-exe/*.exe /var/www/vizoguard/downloads/`
- Installers served at `vizoguard.com/downloads/Vizoguard-latest.dmg` and `.exe`
- Deploy SSH key: ed25519, stored as `VPS_SSH_PRIVATE_KEY` GitHub secret

## IPC Channels
- `license:activate`, `license:status` — license management
- `vpn:connect`, `vpn:disconnect`, `vpn:status`, `vpn:getKey` — VPN control
- `security:stats` — threat/connection counts
- `update:install` — install pending update
- `app:openExternal`, `app:minimize`, `app:close` — window controls

## Testing
- Framework: jest (`npm test` for full suite, `npx jest test/core/<module>.test.js` for single module)
- Test files: `test/core/` — mirrors `src/core/` structure
- Hook: editing `src/core/*.js` auto-runs the matching test file

## Gotchas
- User-Agent in `src/api.js` is hardcoded (`Vizoguard/X.X.X`) — must match version in `package.json` on every bump
- Desktop UI loads fonts from `fonts.gstatic.com` via `@font-face` in `ui/assets/style.css` (Outfit + JetBrains Mono) — CSP allows this in all HTML files
- Blocklist file at `{userData}/data/malicious-domains.txt` — loaded once at startup, never auto-updated
- SOCKS5 VPN tunnel uses Shadowsocks AEAD encryption (chacha20-ietf-poly1305) — implemented in `src/vpn.js` with Node.js crypto. Supports aes-256-gcm and aes-128-gcm as well.
- Grace period: 7 days offline tolerance before license shows expired
- Single-instance lock: `app.requestSingleInstanceLock()` in `main.js` — second launch quits immediately and focuses existing window
- macOS entitlements (`build/entitlements.mac.plist`) required for code signing — missing entitlements will cause notarization failure
- `electron-store` data lives in OS-specific `userData` path — not portable between machines
- `src/api.js` rejects with `{ httpStatus, ...json }` — use `err.httpStatus` for HTTP code (not `err.status` which is the JSON body's status field like "expired"/"suspended")
- `vpn:getKey` IPC tries `/vpn/get` first (with device_id), falls back to `/vpn/create` on 404 — both require `device_id` in params
- `vpn.connect()` uses `_connecting` flag with `try/finally` to ensure cleanup on any error — never remove the finally block
- `vpn._licenseValid` is set by `main.js` license status handler — connect() checks it after completing to auto-disconnect if license expired during setup
- `startSecurityEngine()` is guarded by `_engineStarted` flag — reset to `false` when license becomes invalid so engine can restart on revalidation
- `new Store()` is wrapped in try/catch — corrupted JSON auto-resets the store file
- `autoUpdater.autoDownload = false` — user controls update downloads to prevent partial/corrupted installs
- AeadDecryptor: BOTH catch blocks (length + payload) must set `_failed = true` — missing it causes corrupted state processing
- `SecurityProxy.stop()` destroys all tracked sockets (`_sockets` Set) before `server.close()` — prevents EADDRINUSE on restart
- `_handleConnect` uses regex for host:port parsing — supports IPv6 `[addr]:port` format, not simple `split(":")`
- `vpn.disconnect()` only emits `"disconnected"` when `wasConnected` is true — prevents false state changes when cancelling a connection attempt

## Immune System v2 (Planned)
- Design spec: `docs/superpowers/specs/2026-03-19-immune-system-layers-design.md`
- Implementation plan: `docs/superpowers/plans/2026-03-19-immune-system-layers.md`
- New modules: SecurityEngine (`engine.js`), Sentinel (`sentinel.js` + `sentinel-worker.js`), CanarySystem (`canary.js`), PersistenceHardener (`persistence.js`), DeviceMonitor (`device-monitor.js`)
- New IPC channels: `device:status`, `device:trust`, `device:untrust`, `canary:alert`, `device:alert`, `persistence:restored`

## Related Repos
- Backend/API: `pentedigital/vizoguard` (Node.js server, lives at `/root/vizoguard`)
- API base: `https://vizoguard.com/api` — endpoints in `src/api.js`
