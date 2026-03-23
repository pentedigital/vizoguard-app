# TUN-based VPN Integration — Design Spec

## Problem

The desktop app uses a SOCKS5 system proxy to route traffic through Shadowsocks. This is not a real VPN:
- Only routes apps that respect system proxy settings
- No DNS protection (DNS leaks)
- TCP only (no UDP)
- Requires admin for WinHTTP, silently fails without
- macOS `networksetup` may require auth prompt users never see

## Solution

Replace system proxy with **tun2socks** — a binary that creates a real TUN network interface and routes ALL system traffic through the existing SOCKS5 Shadowsocks proxy.

## Architecture

```
All system traffic → TUN (utun/Wintun) → tun2socks → 127.0.0.1:1080 (SOCKS5) → Shadowsocks → VPN server → Internet
```

Three independent layers:
1. **Shadowsocks SOCKS5 proxy** (existing `src/vpn.js`) — unchanged
2. **tun2socks binary** (new child process) — creates TUN, forwards to SOCKS
3. **Route/DNS manager** (new platform commands) — routes traffic into TUN

## Connect Sequence

1. Elevate privileges (sudo/UAC) — fail early if user cancels
2. Start SOCKS5 proxy on 127.0.0.1:1080
3. Verify Shadowsocks tunnel works (`_verifyTunnel()`)
4. Start tun2socks → creates TUN interface
5. Configure DNS → 1.1.1.1 (save originals first)
6. Change default route → TUN gateway (save originals first) — **always last**
7. Start watchdog monitor
8. Mark connected

Route change is always LAST. If routes change before tun2socks is ready, user loses internet.

## Disconnect Sequence

1. Stop watchdog monitor
2. Restore original routes — **always first, before killing tun2socks**
3. Restore original DNS
4. Kill tun2socks process
5. Stop SOCKS5 proxy
6. Mark disconnected

Routes restored BEFORE killing tun2socks. Otherwise default route points to dead TUN → no internet until reboot.

## Failure Rollback

If any connect step fails, rollback in reverse order:
- Step 6 fails → restore DNS, kill tun2socks, stop SOCKS
- Step 5 fails → kill tun2socks, stop SOCKS
- Step 4 fails → stop SOCKS
- Step 3 fails → stop SOCKS
- Step 2 fails → nothing to clean up
- Step 1 fails → nothing to clean up (user cancelled)

## Module Structure

```
src/
  vpn.js          — orchestrator (connect/disconnect sequence)
  tunnel.js       — tun2socks process lifecycle (spawn, monitor, kill)
  routes.js       — route save/set/restore per platform
  dns.js          — DNS save/set/restore per platform
  elevation.js    — sudo (mac) / UAC (win) wrapper
  monitor.js      — watchdog (2s interval, 4 health checks)
  platform/
    darwin.js     — utun + mac route/DNS commands
    win32.js      — wintun + win route/DNS commands

bin/
  darwin-amd64/tun2socks
  darwin-arm64/tun2socks
  win-amd64/tun2socks.exe
  win-amd64/wintun.dll
```

## Module Responsibilities

| Module | Does | Doesn't |
|--------|------|---------|
| `vpn.js` | Orchestrates connect/disconnect, owns SOCKS5 proxy | Touch TUN, routes, or DNS directly |
| `tunnel.js` | Spawns tun2socks, monitors process, kills on disconnect | Know about Shadowsocks or routes |
| `routes.js` | Saves current routes, sets TUN gateway, restores on disconnect | Know about tun2socks or DNS |
| `dns.js` | Saves current DNS, sets tunnel DNS, restores on disconnect | Know about routes or tun2socks |
| `elevation.js` | Wraps sudo-prompt for mac/win, returns elevated exec function | Know what commands it's elevating |
| `monitor.js` | Watchdog: checks process/route/DNS health every 2s | Make decisions about connect/disconnect logic |

## Watchdog Monitor

Runs every 2 seconds while connected:

| Check | Method | On failure |
|-------|--------|------------|
| tun2socks alive | `process.kill(pid, 0)` | Emergency disconnect |
| SOCKS proxy alive | TCP probe 127.0.0.1:1080 | Emergency disconnect |
| Default route intact | Parse route table output | Emergency disconnect |
| DNS intact | Parse DNS config | Reapply DNS silently |

DNS drift is self-healing (macOS resets DNS on network changes). All other failures trigger emergency disconnect.

## Platform: macOS

- **TUN:** utun (built-in, no driver needed)
- **Launch:** `sudo tun2socks -device utun -proxy socks5://127.0.0.1:1080`
- **Routes:** `route add/delete default`, preserve VPN server route through original gateway
- **DNS:** `networksetup -setdnsservers <service> 1.1.1.1 1.0.0.1`
- **Elevation:** `sudo-prompt` npm package (native auth dialog)

## Platform: Windows

- **TUN:** Wintun (bundled `wintun.dll`)
- **Launch:** `tun2socks.exe -device tun://vizoguard -proxy socks5://127.0.0.1:1080`
- **Routes:** `route add/delete`, set TUN route with low metric
- **DNS:** `netsh interface ip set dns` on TUN interface
- **Elevation:** `sudo-prompt` (UAC dialog)

## TUN IP Assignment

- TUN IP: `10.0.85.2/24`
- Gateway: `10.0.85.1`
- Private range unlikely to collide with user LAN

## Bundled Binaries

Source: `xjasonlyu/tun2socks` releases (pre-built) or compiled from `outline-go-tun2socks`.

```
bin/darwin-amd64/tun2socks    ~6MB
bin/darwin-arm64/tun2socks    ~6MB
bin/win-amd64/tun2socks.exe   ~6MB
bin/win-amd64/wintun.dll      ~400KB
```

electron-builder excludes from asar:
```yaml
asarUnpack: ["bin/**/*"]
```

## Changes to Existing Code

### vpn.js
- **Keeps:** All Shadowsocks crypto, SOCKS5 proxy, URL parsing, tunnel verification
- **Removes:** `platform.setProxy()` / `platform.clearProxy()` calls, proxy on SIGTERM/SIGINT, sleep/resume proxy
- **Adds:** Orchestration using tunnel.js, routes.js, dns.js, elevation.js, monitor.js

### platform/darwin.js, platform/win32.js
- **Removes:** `setProxy()`, `clearProxy()`
- **Keeps:** `getDeviceId()`, `getConnections()`

### main.js
- **Removes:** Proxy cleanup on startup/signals, sleep/resume proxy reapply
- **Adds:** Route/DNS restore on startup (crash recovery), SIGTERM route/DNS restore

### package.json
- **Adds:** `sudo-prompt` dependency

### electron-builder.yml
- **Adds:** `asarUnpack` for bin directory

### UI
- **No changes.** Renderer receives same `vpn:state` and `vpn:error` events.
