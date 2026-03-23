# Adaptive Transport with sing-box Integration — Design Spec

## Problem

UAE and other censorship ISPs use DPI to block raw Shadowsocks traffic on port 19285.
TCP connects but encrypted payloads are silently dropped. Direct mode cannot work in
these networks regardless of app-side fixes.

## Solution

Dual-transport architecture with automatic fallback:
- **Direct mode**: existing SOCKS + tun2socks stack (fast, low overhead)
- **Obfuscated mode**: sing-box binary with Shadowsocks over WebSocket + TLS on port 443

Connection manager tries direct first, falls back to obfuscated if blocked,
caches the working mode per network.

## Traffic Flow

### Direct Mode (non-censored networks)
```
App → tun2socks → SOCKS (1080) → Shadowsocks → 187.77.131.31:19285
```

### Obfuscated Mode (censored networks)
```
App → sing-box (TUN + SS + WS + TLS) → nginx (443) /ws → sing-box server → Internet
```

To DPI, obfuscated mode looks like normal HTTPS WebSocket traffic to vizoguard.com.

## Connection Manager Logic

```
User clicks Connect
  → Check cached mode for this network (gateway IP hash)
  → If cached → use cached mode
  → If no cache → try direct (5s timeout)
    → Works → use direct, cache "direct"
    → Fails → try obfuscated (sing-box)
      → Works → use obfuscated, cache "obfuscated"
      → Both fail → error: "Network may be blocking VPN traffic"
```

Cache key: `SHA256(gateway_ip)`, TTL: 7 days, stored in electron-store.

## Module Structure

```
src/
  connection-manager.js    NEW: mode selection, fallback, cache
  transports/
    direct.js              NEW: wraps vpn.js + tun2socks + routes + dns + monitor
    obfuscated.js          NEW: sing-box config gen, process lifecycle
  vpn.js                   KEEP: Shadowsocks SOCKS proxy (direct mode)
  tunnel.js                KEEP: tun2socks lifecycle (direct mode)
  routes.js                KEEP: direct mode only
  dns.js                   KEEP: direct mode only
  elevation.js             KEEP: both modes
  monitor.js               KEEP: direct mode only

bin/
  darwin-amd64/tun2socks, sing-box
  darwin-arm64/tun2socks, sing-box
  win-amd64/tun2socks.exe, sing-box.exe, wintun.dll
```

## Module Responsibilities

| Module | Does | Doesn't |
|--------|------|---------|
| connection-manager.js | Mode selection, fallback, cache, start/stop active transport | Know transport internals |
| transports/direct.js | Wraps vpn.js + tun2socks + routes + dns + monitor as one unit | Know about sing-box |
| transports/obfuscated.js | Generates sing-box config, spawns/kills process, detects TUN | Know about SOCKS or tun2socks |

## sing-box Client Config (generated at connect time)

```json
{
  "log": { "level": "warn" },
  "inbounds": [{
    "type": "tun",
    "interface_name": "vizoguard",
    "inet4_address": "10.0.85.1/30",
    "auto_route": true,
    "strict_route": true,
    "sniff": true,
    "stack": "system"
  }],
  "outbounds": [{
    "type": "shadowsocks",
    "server": "vizoguard.com",
    "server_port": 443,
    "method": "chacha20-ietf-poly1305",
    "password": "<from license vpnAccessUrl>",
    "transport": {
      "type": "ws",
      "path": "/ws"
    },
    "tls": {
      "enabled": true,
      "server_name": "vizoguard.com"
    }
  }],
  "dns": {
    "servers": [
      { "address": "9.9.9.9" },
      { "address": "1.1.1.1" }
    ]
  }
}
```

sing-box handles TUN, routing, DNS, encryption, and obfuscation in one process.
Password extracted from existing ss:// access URL stored in electron-store.

## Server Side

### sing-box server (runs on VPS, listens on 127.0.0.1:8388)

Accepts Shadowsocks over WebSocket inbound, routes to internet.

### nginx addition (vizoguard.conf)

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8388;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;
}
```

Same IP, same TLS cert, same port 443. Website + API unaffected.

## Connect Sequences

### Direct mode (existing — no changes)
1. Start SOCKS proxy
2. Verify tunnel (non-fatal)
3. Start tun2socks (elevated)
4. Configure routes
5. Configure DNS
6. Start watchdog

### Obfuscated mode (new)
1. Parse ss:// URL for password
2. Generate sing-box JSON config
3. Write config to temp file
4. Elevate privileges
5. Spawn sing-box binary with --config flag
6. Wait for TUN interface (poll or watch stdout)
7. Connected

### Disconnect (either mode)
connection-manager calls active transport's stop():
- Direct: monitor → DNS → routes → tun2socks → SOCKS
- Obfuscated: kill sing-box (auto-cleans TUN + routes)

## main.js Changes

```js
// Before:
await vpn.connect()
// After:
await connectionManager.connect(vpnAccessUrl)
```

UI unchanged. Same IPC channels, same events.

## Settings: Manual Mode Override

Users can override auto-detection in settings:
- Auto (default — try direct, fallback to obfuscated)
- Direct only
- Obfuscated only

Stored in electron-store as `connectionMode`.

## What Stays the Same

- UI (dashboard, animations, engine monitor)
- License system
- Auto-updater
- Tray
- All IPC channels
- Backend API
