# VizoGuard Desktop App

## Stack
- Electron app (`main.js` entry, `preload.js` bridge)
- Cross-platform: `src/platform/` — darwin.js, win32.js, index.js (auto-selects)
- Core modules: `src/core/` — threat-checker, immune-system, connection-monitor, proxy (barrel export: `src/core/index.js`)
- VPN client: `src/vpn.js` — Shadowsocks/Outline protocol via `ss://` URLs
- Transport layer: `src/connection-manager.js` (auto/direct/obfuscated mode selection), `src/transports/direct.js` (SS+tun2socks), `src/transports/obfuscated.js` (sing-box VLESS+WS+TLS)
- License management: `src/license.js`
- Auto-updater: `src/updater.js` — GitHub Releases feed (HTTPS)
- API client: `src/api.js` — all backend calls, base URL: `https://vizoguard.com/api`, exponential backoff retry (2 retries, 1s/2s for 5xx/network errors)
- Persistent storage: `electron-store` (user preferences, license data)
- System tray: `src/tray.js`
- UI: `ui/` — dashboard, activate, expired pages
- Build config: `electron-builder.yml`
- Entitlements: `build/entitlements.mac.plist` (macOS code signing)
- CI/CD: `.github/workflows/build.yml`

## App Config
- appId: `com.vizoguard.app` (version in `package.json`)
- Window: 480x780, frameless, not resizable (minHeight 700)
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

## Architectural Rules
- `vpn:connect` IPC validates license with server before every connection — cached state never trusted
- VPN access URL cleared from electron-store on suspension/expiry and re-fetched on recovery
- Tray and dashboard default to "Checking..." not "Protected" — state driven by validation, never defaults
- `ss://` credential URL stripped from `license:status` IPC response — never exposed to renderer
- License key masked in IPC (`VIZO-****-****-****-XXXX`) — full key never sent to renderer
- System proxy cleared on startup, SIGTERM, SIGINT (crash recovery)
- Proxy reapplied with explicit host:port after sleep/resume via powerMonitor
- Disconnect sets `_connected=false` atomically before async ops (prevents concurrent race)
- Single threat counter source: `securityProxy.threatsBlocked` (not threatChecker)
- `window.vizoguard` access guarded with null check in all HTML pages
- Windows proxy: WinInet (registry) + WinHTTP (netsh) — Firefox uses own settings (documented in UI toast)

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

## Code Signing

### macOS (required for Gatekeeper)
Add these GitHub Actions secrets:
- `MAC_CERTIFICATE_P12_BASE64` — Developer ID Application certificate (base64)
- `MAC_CERTIFICATE_PASSWORD` — Certificate password
- `APPLE_ID` — Apple Developer account email
- `APPLE_APP_SPECIFIC_PASSWORD` — App-specific password for notarization
- `APPLE_TEAM_ID` — Apple Developer Team ID

Generate certificate: Apple Developer > Certificates > Developer ID Application
Export as .p12, base64 encode: `base64 -i cert.p12 | pbcopy`

### Windows (required for SmartScreen)
Add these GitHub Actions secrets:
- `WIN_CERTIFICATE_P12_BASE64` — Authenticode certificate (base64)
- `WIN_CERTIFICATE_PASSWORD` — Certificate password

Options:
- **EV certificate** ($200-400/yr) — eliminates SmartScreen immediately
- **OV certificate** ($100-200/yr) — builds reputation over time
- Recommended providers: DigiCert, Sectigo, GlobalSign

### Without certificates
Apps will show:
- macOS: "cannot be opened because the developer cannot be verified" (right-click > Open to bypass)
- Windows: SmartScreen "Windows protected your PC" (click "More info" > "Run anyway")

## IPC Channels
- `license:activate`, `license:status` — license management
- `vpn:connect`, `vpn:disconnect`, `vpn:status`, `vpn:copyKey` — VPN control
- `security:stats` — threat/connection counts
- `update:install` — install pending update
- `app:openExternal`, `app:minimize`, `app:close` — window controls

## Testing
- Core tests: `test/core/` — mirrors `src/core/` structure, uses jest (`npx jest test/core/<module>.test.js`)
- Transport/route/DNS tests: `test/*.test.js` — uses Node built-in test runner (`node --test test/*.test.js`)
- Electron mock: tests needing `require("electron")` use `Module._resolveFilename` override (`mock.module` needs Node 22+, we're on 20)
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
- `src/api.js` retries 5xx and network errors (max 2 retries, 1s/2s backoff) — 4xx errors throw immediately
- License key regex is uppercase hex only (`/^VIZO-[0-9A-F]{4}(-[0-9A-F]{4}){3}$/`) — must match server validation
- `vpn.connect()` uses `_connecting` flag with `try/finally` to ensure cleanup on any error — never remove the finally block
- `vpn._licenseValid` is set by `main.js` license status handler — connect() checks it after completing to auto-disconnect if license expired during setup
- `startSecurityEngine()` is guarded by `_engineStarted` flag — reset to `false` when license becomes invalid so engine can restart on revalidation
- `new Store()` is wrapped in try/catch — corrupted JSON auto-resets the store file
- `autoUpdater.autoDownload = true` — updates download automatically when available; `autoInstallOnAppQuit = true` installs on next quit
- AeadDecryptor: BOTH catch blocks (length + payload) must set `_failed = true` — missing it causes corrupted state processing
- `SecurityProxy.stop()` destroys all tracked sockets (`_sockets` Set) before `server.close()` — prevents EADDRINUSE on restart
- `_handleConnect` uses regex for host:port parsing — supports IPv6 `[addr]:port` format, not simple `split(":")`
- `vpn.disconnect()` only emits `"disconnected"` when `wasConnected` is true — prevents false state changes when cancelling a connection attempt
- `proxyReq.on("error")` must check `res.headersSent` before writing 502 — partial upstream response triggers double-header crash
- CONNECT tunnel `serverSocket` is tracked in `_sockets` Set for clean shutdown — without this, outbound connections leak on stop()
- SOCKS server post-connect crash auto-calls `disconnect()` — prevents broken network state where system proxy points at dead port
- sing-box `auto_detect_interface` is unreliable — always add explicit server IP bypass route rules + private network bypass in config
- sing-box `auto_route` may not clean up on SIGKILL/crash — `_ensureRouteRestored()` verifies and fixes OS routes after stop
- Windows `Start-Process -RedirectStandardOutput` and `-RedirectStandardError` cannot point to the same file — use separate `.log` and `.err` files
- Obfuscated transport must resolve VLESS server DNS before launching sing-box — DNS queries get trapped by TUN once `auto_route` is active
- `connection-manager.js` `emergencyStop()` kills both transports but only direct has route rollback via `vpn._rollback()` — obfuscated has its own `_ensureRouteRestored()`

## Immune System v2 (Planned)
- Design spec: `docs/superpowers/specs/2026-03-19-immune-system-layers-design.md`
- Implementation plan: `docs/superpowers/plans/2026-03-19-immune-system-layers.md`
- New modules: SecurityEngine (`engine.js`), Sentinel (`sentinel.js` + `sentinel-worker.js`), CanarySystem (`canary.js`), PersistenceHardener (`persistence.js`), DeviceMonitor (`device-monitor.js`)
- New IPC channels: `device:status`, `device:trust`, `device:untrust`, `canary:alert`, `device:alert`, `persistence:restored`

## UI Design (Premium Glass-Morphism Redesign)
- Theme: dark glass-morphism (`backdrop-filter: blur(12px)`, `rgba(255,255,255,0.06)` surfaces)
- Window: 480x780 frameless, minHeight 700
- Connect button: 180px circle, 5 states (idle/connecting/connected/error/reconnecting) with animated glow, pulse, shake, shimmer
- Engine view: collapsible glass panel — VPN tunnel info + security engine metrics + immune system layers + "What Just Happened?" message rotation
- Settings: right-side slide-over panel (320px, glass background), toggles + license + version + quit
- CSS/JS only — no frameworks, no build step
- Animation files: `ui/js/animations.js` (button states, timer), `ui/js/engine-monitor.js` (engine view, live metrics)
- New IPC: `engine:metrics`, `engine:subscribe`/`unsubscribe`, `settings:get`/`settings:set`
- Colors: --teal (connected), --amber (connecting), --red (error), --accent (action buttons)

## Related Repos
- Backend/API: `pentedigital/vizoguard` (Node.js server, lives at `/root/vizoguard`)
- API base: `https://vizoguard.com/api` — endpoints in `src/api.js`
