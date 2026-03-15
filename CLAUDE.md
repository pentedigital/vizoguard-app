# VizoGuard Desktop App

## Stack
- Electron app (`main.js` entry, `preload.js` bridge)
- Cross-platform: `src/platform/` — darwin.js, win32.js
- Core modules: `src/core/` — threat-checker, immune-system, connection-monitor, proxy
- VPN client: `src/vpn.js` — Shadowsocks/Outline protocol via `ss://` URLs
- License management: `src/license.js`
- Auto-updater: `src/updater.js`
- API client: `src/api.js`
- System tray: `src/tray.js`
- UI: `ui/` — dashboard, activate, expired pages
- Build config: `electron-builder.yml`
- CI/CD: `.github/workflows/build.yml`

## App Config
- Version: 1.1.0, appId: `com.vizoguard.app`
- Window: 420x700, frameless, not resizable
- Single-instance enforced — second launch focuses existing window
- macOS: dock hidden, tray-only
- Publish: GitHub Releases (owner: pentedigital, repo: vizoguard-app)

## Ports
- Security proxy: `127.0.0.1:8888` (HTTP/HTTPS filtering)
- SOCKS5 VPN proxy: `127.0.0.1:1080`

## Threat Detection
- 8 analysis vectors in `src/core/threat-checker.js`: blocklist, suspicious TLDs, brand impersonation, IP-in-URL, excessive subdomains, dangerous downloads, homoglyphs, phishing keywords
- LRU cache: 10k entries, 1hr TTL
- Risk levels: critical > high > medium > low

## Security Rules
- Context isolation enforced — all renderer communication via preload.js IPC bridge
- VPN access URLs contain auth credentials — never log or expose
- `openExternal` restricted to vizoguard.com and getoutline.org hostnames

## Commands
- `npm install` — install dependencies
- `npm start` — run in dev mode (see `package.json` scripts)
- `npm run build:mac` / `npm run build:win` — build installers

## Deploy
- Push to `main` triggers GitHub Actions: build Mac DMG + Win EXE → deploy to VPS (187.77.131.31)
- Installers served at `vizoguard.com/downloads/Vizoguard-latest.dmg` and `.exe`
- Deploy SSH key: ed25519, stored as `VPS_SSH_PRIVATE_KEY` GitHub secret

## IPC Channels
- `license:activate`, `license:status` — license management
- `vpn:connect`, `vpn:disconnect`, `vpn:status`, `vpn:getKey` — VPN control
- `security:stats` — threat/connection counts
- `update:install` — install pending update
- `app:openExternal`, `app:minimize`, `app:close` — window controls

## Testing
- No test suite exists yet

## Gotchas
- Blocklist file at `{userData}/data/malicious-domains.txt` — loaded once at startup, never auto-updated
- SOCKS5 proxy has no Shadowsocks encryption — relies on Outline server handling it
- Grace period: 7 days offline tolerance before license shows expired

## Related Repos
- Backend/API: `pentedigital/vizoguard` (Node.js server, lives at `/root/vizoguard`)
- API base: `https://vizoguard.com/api` — endpoints in `src/api.js`
