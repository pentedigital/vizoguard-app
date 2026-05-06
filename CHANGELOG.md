# Changelog

All notable changes to the Vizoguard desktop app are documented in this file.

## [1.3.4] — 2026-05-06

### Security
- Replace runtime code-signing detection with build-time flag (prevents signature-stripping bypass)
- Add Electron fuses: disable `RunAsNode`, `EnableNodeCliInspectArguments`, `EnableNodeOptionsEnvironmentVariable`
- Enable ASAR integrity validation (`EnableEmbeddedAsarIntegrityValidation`) and `OnlyLoadAppFromAsar`
- Add HMAC-signed license responses with replay protection (nonce + timestamp)
- Add temp file cleanup and log rotation on startup (handles crash/force-quit leaks)
- Fix semver parsing in updater downgrade protection
- Pin all GitHub Actions by SHA (supply-chain hardening)

### Fixed
- Fix electron-store ESM crash (downgrade to v10)
- Fix macOS binary paths (`darwin-amd64` → `darwin-x64`)
- Fix Windows packaging bloat (macOS binaries no longer copied into Windows builds)

## [1.3.3] — 2026-03-23

### Security
- Add certificate pinning to auto-updater
- Add minimum version downgrade protection
- Add WebRTC IP leak prevention (`disable_non_proxied_udp`)
- Add real CSP via session webRequest
- Enable explicit sandbox in BrowserWindow
- Add log redaction for license keys, VPN URLs, UUIDs, IPs

### Changed
- Improve VPN transport selection logic

## [1.3.0] — 2026-03-23

### Added
- Obfuscated VPN transport (VLESS + WebSocket + TLS)
- Privacy Autopilot local threat scoring

### Security
- Add `FLAG_SECURE` screenshot prevention (Android)
- Block IPv6 at VpnService level (Android)
- Remove `allowBypass()` (Android)

## [1.2.0] — 2026-03-23

### Added
- In-app update checker for Android with SHA-256 verification
- Clock skew detection and monotonic timestamp defense (Android)

### Changed
- Upgrade Electron to 41.2.1

## [1.1.0] — 2026-03-22

### Added
- Initial public release
- macOS and Windows desktop clients
- Shadowsocks VPN with tun2socks
- System tray integration
- Auto-updater via electron-updater
