# Immune System Layers — Design Spec

**Date:** 2026-03-19
**Scope:** 4 new security modules for vizoguard-app + lightweight engine registry
**Status:** Approved

## Overview

Vizoguard's security architecture mirrors a biological immune system. Four layers are implemented (Proxy, Connection Monitor, Threat Checker, Immune System). This spec adds the remaining four:

| Module | Bio Analogy | Purpose |
|--------|-------------|---------|
| Sentinel | Independent cell lineage | Watchdog child process — survives main app crashes |
| Canary Files | Tripwires | Ransomware detection via decoy files in user directories |
| Persistence Hardener | Regeneration layer | Snapshots + restores critical state after corruption |
| Device Monitor | Antigen detection | Network awareness + auto-VPN on untrusted networks |

## Architecture Decision: Lightweight Registry

New modules register into a `SecurityEngine` class (`src/core/engine.js`). Existing modules stay wired directly in `main.js` — no refactoring of working code.

The engine handles lifecycle (`start()`/`stop()`) and event forwarding with namespace prefixes (e.g., `sentinel:crash-detected`). Migration of existing modules is optional and deferred.

## Module Conventions

All modules follow the existing pattern:
- Extend `EventEmitter`
- Implement `start()` and `stop()`
- Emit events consumed by `main.js` and forwarded to renderer via IPC
- Platform-specific work delegated to `src/platform/`

---

## 1. SecurityEngine

**File:** `src/core/engine.js`

Lightweight lifecycle manager for the 4 new modules.

```
class SecurityEngine extends EventEmitter {
  modules: Map<name, module>

  register(name, module)    // adds module to registry
  start()                   // calls start() on all in order, subscribes to events
  stop()                    // calls stop() on all, cleans up listeners
}
```

- Re-emits all module events with namespace prefix: `sentinel:crash-detected`, `canary:triggered`, etc.
- Start order is enforced: Persistence Hardener → Sentinel → Canary → Device Monitor
- `main.js` adds ~15 lines to create engine, register modules, and forward events

---

## 2. Sentinel (Independent Watchdog)

**Files:** `src/core/sentinel.js` (main-process class), `src/core/sentinel-worker.js` (detached child process)

### Mechanism

- Main process spawns `sentinel-worker.js` via `child_process.fork()` with `detached: true`
- Main process writes heartbeat timestamp to `{userData}/data/heartbeat.json` every 10 seconds
- Worker reads heartbeat every 15 seconds. If timestamp is >30s stale AND parent PID is not running → crash detected

### On Crash Detection

1. Send OS notification via lightweight native notifier
2. Write crash event to `{userData}/data/crash-log.json` (timestamp, last PID, stale duration)
3. Attempt to relaunch Electron app via `child_process.spawn()` with app executable path
4. Exit (newly launched app spawns fresh sentinel)

### On Clean Shutdown

- `main.js` sends `shutdown` message to sentinel worker before exiting
- Worker receives it, cleans up, exits gracefully
- Heartbeat file gets `cleanShutdown: true` flag

### Interface

```
class Sentinel extends EventEmitter {
  constructor(appPath, userDataPath)
  start()                // forks sentinel-worker.js, starts heartbeat writes
  stop()                 // sends shutdown message to worker, stops heartbeat
  wasCleanShutdown()     // reads heartbeat file, returns boolean
}
```

**Events:** `started`, `crash-detected`, `relaunch-attempted`

**Permissions:** None required. `fork()` + `detached: true` is standard Node.js.

---

## 3. Canary Files (Ransomware Tripwires)

**File:** `src/core/canary.js`

### Mechanism

- On first run, creates hidden decoy files in common ransomware target directories:
  - `~/Documents/.vizoguard-canary`
  - `~/Desktop/.vizoguard-canary`
  - `~/Downloads/.vizoguard-canary`
- Each file contains random content generated once. SHA-256 hash stored in electron-store.
- Uses `fs.watch()` for real-time filesystem notifications (not polling)

### Detection Triggers

- **File modified** (hash mismatch) — ransomware encryption signal
- **File deleted** — intrusion cleanup
- **File renamed** — ransomware extension appending (`.locked`, `.encrypted`)

All triggers are severity **critical** — canary files should never change under normal use.

### Self-Healing

- Deleted canary: recreated after alert emitted
- Modified canary: original content restored after alert
- Ensures continuous monitoring even after an event

### Interface

```
class CanarySystem extends EventEmitter {
  constructor(store, userHome)
  start()          // creates canary files if missing, starts fs.watch() on each
  stop()           // closes all watchers
  getStatus()      // returns { active: bool, files: [...], events: [...] }
}
```

**Events:** `started`, `triggered`, `restored`

### False Positive Analysis

- macOS Spotlight / Windows Search: read-only on hidden dotfiles — no false positive
- Antivirus: reads but doesn't modify — no false positive
- User manual deletion: unlikely (dotfile), triggers alert + recreation

---

## 4. Persistence Hardener (Regeneration Layer)

**File:** `src/core/persistence.js`

### What It Protects

| Data | Storage | Backup Location |
|------|---------|-----------------|
| License key | electron-store | OS credential store |
| VPN access URL | electron-store | OS credential store |
| Preferences, config | electron-store | `{userData}/recovery/config-backup.json` |
| Blocklist path | filesystem | `{userData}/recovery/config-backup.json` |
| Trusted networks list | electron-store | `{userData}/recovery/config-backup.json` |

### Snapshot (on healthy state)

- After license activation or VPN key fetch: snapshot secrets to OS credential store
- After config change: write backup to `{userData}/recovery/config-backup.json`
- Debounced: max once per 30 seconds

### Validation (on startup)

1. Check `heartbeat.json` for `cleanShutdown` flag (from Sentinel)
2. If unclean shutdown: validate electron-store integrity (readable? required keys present?)
3. If corrupt/missing: restore from backup file + OS credential store
4. Clean up orphaned OS proxy settings via `platform.clearProxy()`

### OS Credential Store Access

No npm dependency — shell out to OS tools (same pattern as `src/platform/`):

- **macOS:** Keychain via `security` CLI (`find-generic-password` / `add-generic-password`)
- **Windows:** Credential Manager via `cmdkey` CLI
- Service name: `com.vizoguard.app`
- Account names: `license-key`, `vpn-access-url`

### Interface

```
class PersistenceHardener extends EventEmitter {
  constructor(store, userDataPath, platform)
  start()              // validates state, restores if needed, starts watching
  stop()               // final snapshot before shutdown
  snapshot()           // manual trigger, debounced
  restore()            // reads from backup + credential store, writes to electron-store
  wasCorrupted()       // returns boolean from last startup check
}
```

**Events:** `started`, `snapshot-saved`, `corruption-detected`, `state-restored`, `proxy-cleaned`

### Integration with Sentinel

On startup, checks `sentinel.wasCleanShutdown()`. If false → full validation + restore. If true → fresh snapshot only.

---

## 5. Device Monitor (Network Awareness)

**File:** `src/core/device-monitor.js`

### Mechanism

- Polls current network info every 30 seconds via platform commands:
  - **macOS:** `networksetup -getairportnetwork en0` (SSID) + `ifconfig en0` (gateway/IP)
  - **Windows:** `netsh wlan show interfaces` (SSID, signal, auth) + `ipconfig` (gateway)
- Network fingerprint: `SHA-256(SSID + gateway IP + subnet)` — uniquely identifies a network without storing raw name
- Compares against trust list in electron-store

### Trust Model

- First network seen after activation: auto-trusted (likely home network)
- New unknown networks: emit `untrusted-network` event
- User trusts/untrusts via IPC from dashboard
- Trust list in electron-store: `{ hash, label, trustedAt }` — label is user-provided ("Home", "Office")

### Auto-VPN Behavior

- Untrusted network detected + VPN not connected → auto-connect VPN + notify renderer
- Return to trusted network → emit `trusted-network`, no VPN action (user may want to stay connected)
- User can disable auto-VPN via preference flag in electron-store

### Interface

```
class DeviceMonitor extends EventEmitter {
  constructor(store, platform)
  start()                     // begins polling, loads trust list
  stop()                      // stops polling
  trustCurrent(label)         // adds current network to trust list
  untrustCurrent()            // removes current network from trust list
  getStatus()                 // { currentNetwork, trusted, knownNetworks }
}
```

**Events:** `started`, `network-changed`, `untrusted-network`, `trusted-network`

### New Platform Functions

Added to `src/platform/darwin.js` and `win32.js`:
- `getNetworkInfo()` — returns `{ ssid, gateway, subnet }` or `null` if wired/disconnected

---

## 6. Integration

### Changes to `main.js` (~15 lines)

```js
const { SecurityEngine, Sentinel, CanarySystem, PersistenceHardener, DeviceMonitor } = require("./src/core");

// Inside startSecurityEngine(), after existing module starts:
const engine = new SecurityEngine();
engine.register("persistence", new PersistenceHardener(store, userDataPath, platform));
engine.register("sentinel", new Sentinel(appPath, userDataPath));
engine.register("canary", new CanarySystem(store, os.homedir()));
engine.register("device", new DeviceMonitor(store, platform));
engine.start();
```

### Event Forwarding

- `canary:triggered` → `sendToRenderer("canary:alert", data)`
- `device:untrusted-network` → auto-connect VPN + `sendToRenderer("device:alert", data)`
- `persistence:state-restored` → `sendToRenderer("persistence:restored", data)`
- `sentinel:crash-detected` → handled by sentinel worker (main process is dead)

### Startup Order

1. **Persistence Hardener** — validates/restores state before anything reads it
2. **Sentinel** — begins heartbeat
3. **Canary** — places/verifies decoy files
4. **Device Monitor** — begins network polling, may trigger VPN auto-connect

### Shutdown

In `trayCallbacks.quit()`: call `engine.stop()` before existing shutdown sequence.
In `license.onStatusChange()` when invalid: call `engine.stop()`.

### New IPC Channels

- `device:status` — current network info + trust state
- `device:trust` — trust current network (with label)
- `device:untrust` — remove current network from trust list
- `security:stats` — updated to include canary and device monitor data

### Updated Exports (`src/core/index.js`)

Add: `SecurityEngine`, `Sentinel`, `CanarySystem`, `PersistenceHardener`, `DeviceMonitor`

### New Platform Functions (`src/platform/darwin.js` + `win32.js`)

- `getNetworkInfo()` — returns `{ ssid, gateway, subnet }`
- `setCredential(service, account, value)` — store in OS credential manager
- `getCredential(service, account)` — retrieve from OS credential manager
- `deleteCredential(service, account)` — remove from OS credential manager

### No UI Changes

Dashboard already displays immune events. New events flow through the same IPC pattern. UI enhancements are a separate spec.

---

## New Files Summary

| File | Purpose |
|------|---------|
| `src/core/engine.js` | SecurityEngine registry |
| `src/core/sentinel.js` | Sentinel main-process class |
| `src/core/sentinel-worker.js` | Sentinel detached child process |
| `src/core/canary.js` | CanarySystem |
| `src/core/persistence.js` | PersistenceHardener |
| `src/core/device-monitor.js` | DeviceMonitor |

## Modified Files Summary

| File | Change |
|------|--------|
| `src/core/index.js` | Add new exports |
| `src/platform/darwin.js` | Add `getNetworkInfo()`, credential store functions |
| `src/platform/win32.js` | Add `getNetworkInfo()`, credential store functions |
| `main.js` | ~15 lines: create engine, register modules, forward events, new IPC handlers |
