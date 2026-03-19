# Immune System Layers Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 remaining security modules (Sentinel, Canary, Persistence Hardener, Device Monitor) to the Vizoguard Electron desktop app, managed by a lightweight SecurityEngine registry.

**Architecture:** New modules register into a SecurityEngine class that handles lifecycle and event forwarding. Existing modules stay wired directly in main.js. Platform-specific work (credential store, network info) is added to the existing `src/platform/` pattern.

**Tech Stack:** Node.js, Electron, EventEmitter, fs.watch, child_process.spawn, macOS Keychain (security CLI), Windows DPAPI (PowerShell), system_profiler/netsh for network info.

**Spec:** `docs/superpowers/specs/2026-03-19-immune-system-layers-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/core/engine.js` | SecurityEngine — lifecycle registry, event namespace forwarding |
| `src/core/sentinel.js` | Sentinel — heartbeat writer, worker manager, respawn logic |
| `src/core/sentinel-worker.js` | Detached child process — heartbeat reader, crash detector, relauncher |
| `src/core/canary.js` | CanarySystem — decoy file placement, fs.watch monitoring, self-healing |
| `src/core/persistence.js` | PersistenceHardener — state snapshots, validation, restore from backup + credential store |
| `src/core/device-monitor.js` | DeviceMonitor — network polling, trust list, auto-VPN triggering |
| `test/core/engine.test.js` | Tests for SecurityEngine |
| `test/core/sentinel.test.js` | Tests for Sentinel (mocked child_process) |
| `test/core/canary.test.js` | Tests for CanarySystem (mocked fs) |
| `test/core/persistence.test.js` | Tests for PersistenceHardener (mocked platform) |
| `test/core/device-monitor.test.js` | Tests for DeviceMonitor (mocked platform) |

### Modified Files

| File | Change |
|------|--------|
| `package.json` | Add jest devDependency + test script |
| `src/core/index.js` | Add exports for 5 new modules |
| `src/platform/darwin.js` | Add `getNetworkInfo()`, `setCredential()`, `getCredential()`, `deleteCredential()` |
| `src/platform/win32.js` | Add `getNetworkInfo()`, `setCredential()`, `getCredential()`, `deleteCredential()` |
| `main.js` | Create engine, register modules, forward events, new IPC handlers, shutdown |
| `preload.js` | Add IPC bridge methods for device, canary, persistence channels |

---

## Task 1: Test Infrastructure Setup

**Files:**
- Modify: `package.json`
- Create: `test/core/engine.test.js` (placeholder)

- [ ] **Step 1: Install jest**

```bash
cd /root/vizoguard-app && npm install --save-dev jest
```

- [ ] **Step 2: Add test script to package.json**

In `package.json`, add to `"scripts"`:
```json
"test": "jest --verbose",
"test:watch": "jest --watch"
```

- [ ] **Step 3: Create placeholder test to verify jest works**

Create `test/core/engine.test.js`:
```js
describe("SecurityEngine", () => {
  test("placeholder", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4: Run test to verify jest works**

Run: `cd /root/vizoguard-app && npm test`
Expected: 1 test passing

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json test/
git commit -m "chore: add jest test infrastructure"
```

---

## Task 2: SecurityEngine

**Files:**
- Create: `src/core/engine.js`
- Create: `test/core/engine.test.js`
- Modify: `src/core/index.js`

- [ ] **Step 1: Write failing tests for SecurityEngine**

Replace `test/core/engine.test.js` with:
```js
const { EventEmitter } = require("events");
const SecurityEngine = require("../../src/core/engine");

// Helper: minimal module mock
function mockModule(name) {
  const mod = new EventEmitter();
  mod.start = jest.fn();
  mod.stop = jest.fn();
  mod._name = name;
  return mod;
}

describe("SecurityEngine", () => {
  let engine;

  beforeEach(() => {
    engine = new SecurityEngine();
  });

  afterEach(() => {
    engine.stop();
  });

  test("register adds module to registry", () => {
    const mod = mockModule("test");
    engine.register("test", mod);
    expect(engine.modules.size).toBe(1);
  });

  test("start calls start() on all modules in registration order", async () => {
    const order = [];
    const modA = mockModule("a");
    modA.start.mockImplementation(() => order.push("a"));
    const modB = mockModule("b");
    modB.start.mockImplementation(() => order.push("b"));

    engine.register("a", modA);
    engine.register("b", modB);
    await engine.start();

    expect(order).toEqual(["a", "b"]);
  });

  test("start continues if a module throws", async () => {
    const modA = mockModule("a");
    modA.start.mockImplementation(() => { throw new Error("fail"); });
    const modB = mockModule("b");

    engine.register("a", modA);
    engine.register("b", modB);

    const errors = [];
    engine.on("engine:module-error", (data) => errors.push(data));

    await engine.start();

    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe("a");
    expect(modB.start).toHaveBeenCalled();
  });

  test("re-emits module events with namespace prefix", async () => {
    const mod = mockModule("sentinel");
    engine.register("sentinel", mod);
    await engine.start();

    const events = [];
    engine.on("sentinel:alert", (data) => events.push(data));
    mod.emit("alert", { type: "test" });

    expect(events).toEqual([{ type: "test" }]);
  });

  test("stop calls stop() on all modules", async () => {
    const modA = mockModule("a");
    const modB = mockModule("b");
    engine.register("a", modA);
    engine.register("b", modB);
    await engine.start();

    engine.stop();

    expect(modA.stop).toHaveBeenCalled();
    expect(modB.stop).toHaveBeenCalled();
  });

  test("stop removes event listeners from modules", async () => {
    const mod = mockModule("test");
    engine.register("test", mod);
    await engine.start();
    engine.stop();

    const events = [];
    engine.on("test:alert", (data) => events.push(data));
    mod.emit("alert", { type: "test" });

    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/vizoguard-app && npm test -- test/core/engine.test.js`
Expected: FAIL — cannot find module `../../src/core/engine`

- [ ] **Step 3: Implement SecurityEngine**

Create `src/core/engine.js`:
```js
const { EventEmitter } = require("events");

class SecurityEngine extends EventEmitter {
  constructor() {
    super();
    this.modules = new Map();
    this._listeners = new Map(); // name -> Map<event, handler>
  }

  register(name, mod) {
    this.modules.set(name, mod);
  }

  async start() {
    for (const [name, mod] of this.modules) {
      try {
        await mod.start();
      } catch (err) {
        this.emit("engine:module-error", { name, error: err });
        continue;
      }

      // Subscribe to all future events from this module and re-emit with prefix
      const originalEmit = mod.emit.bind(mod);
      const listeners = new Map();

      const patchedEmit = (event, ...args) => {
        originalEmit(event, ...args);
        if (event !== "newListener" && event !== "removeListener") {
          this.emit(`${name}:${event}`, ...args);
        }
      };

      // Monkey-patch emit to forward events
      mod.emit = patchedEmit;
      this._listeners.set(name, { originalEmit });
    }
  }

  stop() {
    for (const [name, mod] of this.modules) {
      try {
        mod.stop();
      } catch { /* ignore stop errors */ }

      // Restore original emit
      const saved = this._listeners.get(name);
      if (saved) {
        mod.emit = saved.originalEmit;
      }
    }
    this._listeners.clear();
  }
}

module.exports = SecurityEngine;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/vizoguard-app && npm test -- test/core/engine.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Run all tests**

Run: `cd /root/vizoguard-app && npm test`
Expected: All tests PASS

Note: `src/core/index.js` is not updated yet — all new exports will be added together in Task 9 after all modules exist.

- [ ] **Step 6: Commit**

```bash
git add src/core/engine.js test/core/engine.test.js
git commit -m "feat: add SecurityEngine lifecycle registry"
```

---

## Task 3: Platform Functions — Credential Store

**Files:**
- Modify: `src/platform/darwin.js`
- Modify: `src/platform/win32.js`

- [ ] **Step 1: Add credential store functions to darwin.js**

Append to `src/platform/darwin.js` before `module.exports`:
```js
async function setCredential(service, account, value) {
  // -U flag updates if exists, creates if not — no need to delete first
  await execFileAsync("/usr/bin/security", [
    "add-generic-password", "-s", service, "-a", account, "-w", value, "-U",
  ]);
}

async function getCredential(service, account) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password", "-s", service, "-a", account, "-w",
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function deleteCredential(service, account) {
  try {
    await execFileAsync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account]);
  } catch { /* not found, ok */ }
}
```

Update `module.exports` to include the new functions:
```js
module.exports = { getDeviceId, setProxy, clearProxy, getConnections, setCredential, getCredential, deleteCredential };
```

- [ ] **Step 2: Add credential store functions to win32.js**

Append to `src/platform/win32.js` before `module.exports`:
```js
const credFs = require("fs");
const credPath = require("path");
const credOs = require("os");

function _credFilePath(account) {
  const credDir = credPath.join(credOs.homedir(), ".vizoguard-creds");
  if (!credFs.existsSync(credDir)) credFs.mkdirSync(credDir, { recursive: true });
  // Sanitize account name to safe filename
  const safe = account.replace(/[^a-zA-Z0-9_-]/g, "_");
  return credPath.join(credDir, safe);
}

async function setCredential(service, account, value) {
  const filePath = _credFilePath(account);
  // Write plaintext value to temp file, then encrypt via DPAPI
  const tmpPath = filePath + ".tmp";
  credFs.writeFileSync(tmpPath, value, "utf8");
  const script = [
    "Add-Type -AssemblyName System.Security;",
    `$bytes = [System.IO.File]::ReadAllBytes('${tmpPath.replace(/'/g, "''")}');`,
    "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser');",
    `[System.IO.File]::WriteAllBytes('${filePath.replace(/'/g, "''")}', $enc);`,
    `Remove-Item -Path '${tmpPath.replace(/'/g, "''")}' -ErrorAction SilentlyContinue;`,
  ].join(" ");
  await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
}

async function getCredential(service, account) {
  const filePath = _credFilePath(account);
  if (!credFs.existsSync(filePath)) return null;
  const script = [
    "Add-Type -AssemblyName System.Security;",
    `$enc = [System.IO.File]::ReadAllBytes('${filePath.replace(/'/g, "''")}');`,
    "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser');",
    "[System.Text.Encoding]::UTF8.GetString($bytes)",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function deleteCredential(service, account) {
  const filePath = _credFilePath(account);
  try { credFs.unlinkSync(filePath); } catch { /* not found, ok */ }
}
```

Update `module.exports`:
```js
module.exports = { getDeviceId, setProxy, clearProxy, getConnections, setCredential, getCredential, deleteCredential };
```

- [ ] **Step 3: Verify syntax**

Run: `node -c src/platform/darwin.js && node -c src/platform/win32.js`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/platform/darwin.js src/platform/win32.js
git commit -m "feat: add OS credential store functions (macOS Keychain, Windows DPAPI)"
```

---

## Task 4: Platform Functions — Network Info

**Files:**
- Modify: `src/platform/darwin.js`
- Modify: `src/platform/win32.js`

- [ ] **Step 1: Add getNetworkInfo to darwin.js**

Append to `src/platform/darwin.js` before `module.exports`:
```js
async function getNetworkInfo() {
  try {
    // Get SSID via system_profiler (interface-agnostic, works on all Macs)
    let ssid = null;
    try {
      const { stdout: spOut } = await execFileAsync("/usr/sbin/system_profiler", ["SPAirPortDataType", "-json"]);
      const data = JSON.parse(spOut);
      const interfaces = data?.SPAirPortDataType?.[0]?.spairport_airport_interfaces;
      if (interfaces) {
        for (const iface of interfaces) {
          const current = iface?.spairport_current_network_information;
          if (current?.["_name"]) {
            ssid = current["_name"];
            break;
          }
        }
      }
    } catch { /* no Wi-Fi or command failed */ }

    // Get gateway + subnet via route + ifconfig
    let gateway = null;
    let subnet = null;
    try {
      const { stdout: routeOut } = await execFileAsync("/usr/sbin/netstat", ["-rn"]);
      const defaultLine = routeOut.split("\n").find((l) => l.startsWith("default"));
      if (defaultLine) {
        gateway = defaultLine.split(/\s+/)[1];
      }
    } catch { /* no route */ }

    try {
      const { stdout: ifOut } = await execFileAsync("/sbin/ifconfig");
      // Match all inet lines, skip loopback (127.x.x.x)
      const inetMatches = [...ifOut.matchAll(/inet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-f]+)/g)];
      const inetMatch = inetMatches.find((m) => !m[1].startsWith("127."));
      if (inetMatch) {
        // Convert hex netmask to dotted notation
        const hex = inetMatch[2].replace("0x", "");
        subnet = [
          parseInt(hex.substring(0, 2), 16),
          parseInt(hex.substring(2, 4), 16),
          parseInt(hex.substring(4, 6), 16),
          parseInt(hex.substring(6, 8), 16),
        ].join(".");
      }
    } catch { /* no interface */ }

    if (!gateway && !subnet) return null;
    return { ssid, gateway, subnet };
  } catch {
    return null;
  }
}
```

Update `module.exports`:
```js
module.exports = { getDeviceId, setProxy, clearProxy, getConnections, setCredential, getCredential, deleteCredential, getNetworkInfo };
```

- [ ] **Step 2: Add getNetworkInfo to win32.js**

Append to `src/platform/win32.js` before `module.exports`:
```js
async function getNetworkInfo() {
  try {
    let ssid = null;
    try {
      const { stdout: wlanOut } = await execFileAsync("netsh", ["wlan", "show", "interfaces"]);
      const ssidMatch = wlanOut.match(/^\s*SSID\s*:\s*(.+)$/m);
      if (ssidMatch) ssid = ssidMatch[1].trim();
    } catch { /* no Wi-Fi adapter or not connected */ }

    let gateway = null;
    let subnet = null;
    try {
      const { stdout: ipOut } = await execFileAsync("ipconfig");
      const gwMatch = ipOut.match(/Default Gateway[\s.]*:\s*(\d+\.\d+\.\d+\.\d+)/);
      if (gwMatch) gateway = gwMatch[1];
      const maskMatch = ipOut.match(/Subnet Mask[\s.]*:\s*(\d+\.\d+\.\d+\.\d+)/);
      if (maskMatch) subnet = maskMatch[1];
    } catch { /* no network */ }

    if (!gateway && !subnet) return null;
    return { ssid, gateway, subnet };
  } catch {
    return null;
  }
}
```

Update `module.exports`:
```js
module.exports = { getDeviceId, setProxy, clearProxy, getConnections, setCredential, getCredential, deleteCredential, getNetworkInfo };
```

- [ ] **Step 3: Verify syntax**

Run: `node -c src/platform/darwin.js && node -c src/platform/win32.js`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/platform/darwin.js src/platform/win32.js
git commit -m "feat: add getNetworkInfo() platform functions for device monitor"
```

---

## Task 5: Sentinel Module

**Files:**
- Create: `src/core/sentinel.js`
- Create: `src/core/sentinel-worker.js`
- Create: `test/core/sentinel.test.js`

- [ ] **Step 1: Write failing tests for Sentinel**

Create `test/core/sentinel.test.js`:
```js
const path = require("path");
const fs = require("fs");
const os = require("os");

// Mock child_process BEFORE requiring Sentinel (sentinel.js destructures spawn at load time)
const mockChild = {
  on: jest.fn(),
  unref: jest.fn(),
  pid: 9999,
  connected: true,
  send: jest.fn(),
  kill: jest.fn(),
};
jest.mock("child_process", () => ({
  spawn: jest.fn(() => mockChild),
}));

const Sentinel = require("../../src/core/sentinel");

describe("Sentinel", () => {
  let tmpDir;
  let sentinel;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-test-"));
    fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
    sentinel = new Sentinel("/fake/app/path", tmpDir);
    jest.clearAllMocks();
    mockChild.on.mockReset();
    mockChild.send.mockReset();
    mockChild.connected = true;
  });

  afterEach(() => {
    sentinel.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("wasCleanShutdown returns true when heartbeat has cleanShutdown flag", () => {
    const hbPath = path.join(tmpDir, "data", "heartbeat.json");
    fs.writeFileSync(hbPath, JSON.stringify({ cleanShutdown: true, timestamp: Date.now(), pid: 1234 }));
    expect(sentinel.wasCleanShutdown()).toBe(true);
  });

  test("wasCleanShutdown returns false when heartbeat has no cleanShutdown flag", () => {
    const hbPath = path.join(tmpDir, "data", "heartbeat.json");
    fs.writeFileSync(hbPath, JSON.stringify({ timestamp: Date.now(), pid: 1234 }));
    expect(sentinel.wasCleanShutdown()).toBe(false);
  });

  test("wasCleanShutdown returns false when heartbeat file does not exist", () => {
    expect(sentinel.wasCleanShutdown()).toBe(false);
  });

  test("start writes heartbeat file and spawns worker", async () => {
    await sentinel.start();

    const hbPath = path.join(tmpDir, "data", "heartbeat.json");
    expect(fs.existsSync(hbPath)).toBe(true);
    const hb = JSON.parse(fs.readFileSync(hbPath, "utf8"));
    expect(hb.pid).toBeDefined();
    expect(hb.timestamp).toBeDefined();
    expect(hb.cleanShutdown).toBe(false);

    const { spawn } = require("child_process");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("stop writes cleanShutdown flag to heartbeat", async () => {
    await sentinel.start();
    sentinel.stop();

    const hbPath = path.join(tmpDir, "data", "heartbeat.json");
    const hb = JSON.parse(fs.readFileSync(hbPath, "utf8"));
    expect(hb.cleanShutdown).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/vizoguard-app && npm test -- test/core/sentinel.test.js`
Expected: FAIL — cannot find module `../../src/core/sentinel`

- [ ] **Step 3: Implement sentinel.js**

Create `src/core/sentinel.js`:
```js
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const HEARTBEAT_INTERVAL = 10000; // 10 seconds
const MAX_RESPAWN_ATTEMPTS = 3;
const RESPAWN_BACKOFF = [1000, 2000, 4000];

class Sentinel extends EventEmitter {
  constructor(appPath, userDataPath) {
    super();
    this.appPath = appPath;
    this.userDataPath = userDataPath;
    this._heartbeatPath = path.join(userDataPath, "data", "heartbeat.json");
    this._logPath = path.join(userDataPath, "data", "sentinel.log");
    this._worker = null;
    this._heartbeatTimer = null;
    this._respawnCount = 0;
  }

  wasCleanShutdown() {
    try {
      const data = JSON.parse(fs.readFileSync(this._heartbeatPath, "utf8"));
      return data.cleanShutdown === true;
    } catch {
      return false;
    }
  }

  async start() {
    // Ensure data directory exists
    const dataDir = path.dirname(this._heartbeatPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // Write initial heartbeat
    this._writeHeartbeat(false);

    // Start heartbeat timer
    this._heartbeatTimer = setInterval(() => this._writeHeartbeat(false), HEARTBEAT_INTERVAL);

    // Spawn worker
    this._spawnWorker();

    this.emit("started");
  }

  stop() {
    // Stop heartbeat
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    // Write clean shutdown flag
    this._writeHeartbeat(true);

    // Tell worker to shut down
    if (this._worker) {
      try {
        if (this._worker.connected) {
          this._worker.send({ type: "shutdown" });
        }
      } catch { /* worker may already be gone */ }
      this._worker = null;
    }

    this._respawnCount = 0;
  }

  _writeHeartbeat(cleanShutdown) {
    try {
      const data = { timestamp: Date.now(), pid: process.pid, cleanShutdown };
      fs.writeFileSync(this._heartbeatPath, JSON.stringify(data));
    } catch { /* best effort */ }
  }

  _spawnWorker() {
    const workerPath = path.join(__dirname, "sentinel-worker.js");

    // Truncate log file if > 1MB
    try {
      const stats = fs.statSync(this._logPath);
      if (stats.size > 1024 * 1024) fs.writeFileSync(this._logPath, "");
    } catch { /* file may not exist */ }

    const logFd = fs.openSync(this._logPath, "a");

    this._worker = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        SENTINEL_HEARTBEAT_PATH: this._heartbeatPath,
        SENTINEL_APP_PATH: this.appPath,
        SENTINEL_USER_DATA_PATH: this.userDataPath,
      },
      detached: true,
      stdio: ["ignore", logFd, logFd, "ipc"],
    });

    fs.closeSync(logFd);

    this._worker.on("error", (err) => {
      this.emit("worker-error", { error: err, fatal: false });
      this._attemptRespawn();
    });

    this._worker.on("exit", (code) => {
      // code null means killed, 0 means clean exit (shutdown message received)
      if (code !== 0 && code !== null && this._heartbeatTimer) {
        this.emit("worker-error", { code, fatal: false });
        this._attemptRespawn();
      }
    });

    this._worker.unref();
  }

  _attemptRespawn() {
    if (this._respawnCount >= MAX_RESPAWN_ATTEMPTS) {
      this.emit("worker-error", { fatal: true });
      return;
    }

    const delay = RESPAWN_BACKOFF[this._respawnCount] || 4000;
    this._respawnCount++;

    setTimeout(() => {
      if (this._heartbeatTimer) { // only respawn if we haven't been stopped
        this._spawnWorker();
        this.emit("worker-restarted", { attempt: this._respawnCount });
      }
    }, delay);
  }
}

module.exports = Sentinel;
```

- [ ] **Step 4: Implement sentinel-worker.js**

Create `src/core/sentinel-worker.js`:
```js
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HEARTBEAT_PATH = process.env.SENTINEL_HEARTBEAT_PATH;
const APP_PATH = process.env.SENTINEL_APP_PATH;
const USER_DATA_PATH = process.env.SENTINEL_USER_DATA_PATH;
const CHECK_INTERVAL = 15000; // 15 seconds
const STALE_THRESHOLD = 30000; // 30 seconds

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] sentinel: ${msg}\n`);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeCrashLog(heartbeat, staleDuration) {
  const crashLogPath = path.join(path.dirname(HEARTBEAT_PATH), "crash-log.json");
  try {
    let crashes = [];
    try {
      crashes = JSON.parse(fs.readFileSync(crashLogPath, "utf8"));
    } catch { /* new file */ }

    crashes.push({
      timestamp: new Date().toISOString(),
      lastPid: heartbeat.pid,
      staleDuration,
    });

    // Keep last 50 entries
    if (crashes.length > 50) crashes = crashes.slice(-50);

    fs.writeFileSync(crashLogPath, JSON.stringify(crashes, null, 2));
  } catch (e) {
    log(`Failed to write crash log: ${e.message}`);
  }
}

function relaunchApp() {
  log("Attempting to relaunch app...");
  try {
    const child = spawn(APP_PATH, [], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log("Relaunch spawned");
  } catch (e) {
    log(`Relaunch failed: ${e.message}`);
  }
}

function check() {
  const heartbeat = readHeartbeat();
  if (!heartbeat) {
    log("No heartbeat file found");
    return;
  }

  if (heartbeat.cleanShutdown) {
    log("Clean shutdown detected, exiting");
    process.exit(0);
  }

  const staleDuration = Date.now() - heartbeat.timestamp;
  if (staleDuration > STALE_THRESHOLD) {
    // Heartbeat is stale — check if process is actually dead
    if (!isProcessRunning(heartbeat.pid)) {
      log(`Crash detected: PID ${heartbeat.pid} not running, stale for ${staleDuration}ms`);
      writeCrashLog(heartbeat, staleDuration);
      relaunchApp();
      process.exit(0);
    }
  }
}

// Listen for shutdown message from parent
process.on("message", (msg) => {
  if (msg && msg.type === "shutdown") {
    log("Shutdown message received, exiting");
    process.exit(0);
  }
});

// Handle IPC disconnect (parent died without sending shutdown)
process.on("disconnect", () => {
  log("IPC disconnected from parent");
  // Don't exit — continue monitoring heartbeat file
});

log("Sentinel worker started");
const timer = setInterval(check, CHECK_INTERVAL);

// Initial check after a brief delay
setTimeout(check, 5000);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /root/vizoguard-app && npm test -- test/core/sentinel.test.js`
Expected: All 5 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/sentinel.js src/core/sentinel-worker.js test/core/sentinel.test.js
git commit -m "feat: add Sentinel watchdog module with worker process"
```

---

## Task 6: Canary System Module

**Files:**
- Create: `src/core/canary.js`
- Create: `test/core/canary.test.js`

- [ ] **Step 1: Write failing tests for CanarySystem**

Create `test/core/canary.test.js`:
```js
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const CanarySystem = require("../../src/core/canary");

// Mock store
function mockStore() {
  const data = {};
  return {
    get: (key) => data[key],
    set: (key, val) => { data[key] = val; },
    delete: (key) => { delete data[key]; },
    _data: data,
  };
}

describe("CanarySystem", () => {
  let tmpDir, store, canary;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-test-"));
    // Create target directories
    fs.mkdirSync(path.join(tmpDir, "Documents"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "Desktop"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "Downloads"), { recursive: true });
    store = mockStore();
    canary = new CanarySystem(store, tmpDir);
  });

  afterEach(() => {
    canary.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("start creates canary files in target directories", async () => {
    await canary.start();

    expect(fs.existsSync(path.join(tmpDir, "Documents", ".vizoguard-canary"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "Desktop", ".vizoguard-canary"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "Downloads", ".vizoguard-canary"))).toBe(true);
  });

  test("start stores hashes in store", async () => {
    await canary.start();
    expect(store.get("canary.hashes")).toBeDefined();
    expect(Object.keys(store.get("canary.hashes")).length).toBe(3);
  });

  test("start reuses existing canary files if hashes match", async () => {
    await canary.start();
    const content1 = fs.readFileSync(path.join(tmpDir, "Documents", ".vizoguard-canary"));
    canary.stop();

    // Start again
    canary = new CanarySystem(store, tmpDir);
    await canary.start();
    const content2 = fs.readFileSync(path.join(tmpDir, "Documents", ".vizoguard-canary"));

    expect(content1.equals(content2)).toBe(true);
  });

  test("getStatus returns active state and file list", async () => {
    await canary.start();
    const status = canary.getStatus();

    expect(status.active).toBe(true);
    expect(status.files).toHaveLength(3);
    expect(status.events).toEqual([]);
  });

  test("detects modified canary file", async () => {
    await canary.start();

    const events = [];
    canary.on("triggered", (data) => events.push(data));

    // Modify a canary file
    const canaryPath = path.join(tmpDir, "Documents", ".vizoguard-canary");
    fs.writeFileSync(canaryPath, "ransomware-encrypted-content");

    // Wait for debounce (500ms) + buffer
    await new Promise((r) => setTimeout(r, 1500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("modified");
  });

  test("self-heals deleted canary file", async () => {
    await canary.start();

    const events = [];
    canary.on("restored", (data) => events.push(data));

    // Delete a canary file
    const canaryPath = path.join(tmpDir, "Documents", ".vizoguard-canary");
    fs.unlinkSync(canaryPath);

    // Wait for debounce + restore
    await new Promise((r) => setTimeout(r, 2000));

    expect(fs.existsSync(canaryPath)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test("stop closes all watchers", async () => {
    await canary.start();
    canary.stop();
    expect(canary.getStatus().active).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/vizoguard-app && npm test -- test/core/canary.test.js`
Expected: FAIL — cannot find module `../../src/core/canary`

- [ ] **Step 3: Implement CanarySystem**

Create `src/core/canary.js`:
```js
const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CANARY_FILENAME = ".vizoguard-canary";
const CANARY_DIRS = ["Documents", "Desktop", "Downloads"];
const DEBOUNCE_MS = 500;

class CanarySystem extends EventEmitter {
  constructor(store, userHome) {
    super();
    this.store = store;
    this.userHome = userHome;
    this._watchers = [];
    this._debounceTimers = new Map();
    this._active = false;
    this.events = [];
  }

  async start() {
    const hashes = this.store.get("canary.hashes") || {};
    const newHashes = {};

    for (const dir of CANARY_DIRS) {
      const dirPath = path.join(this.userHome, dir);
      const filePath = path.join(dirPath, CANARY_FILENAME);

      if (!fs.existsSync(dirPath)) continue;

      // Create or verify canary file
      if (fs.existsSync(filePath) && hashes[filePath]) {
        const currentHash = this._hashFile(filePath);
        if (currentHash === hashes[filePath]) {
          newHashes[filePath] = currentHash;
        } else {
          // File was tampered with while app was off — restore it
          this._createCanaryFile(filePath);
          newHashes[filePath] = this._hashFile(filePath);
        }
      } else {
        this._createCanaryFile(filePath);
        newHashes[filePath] = this._hashFile(filePath);
      }

      // Watch the canary file
      this._watchFile(filePath);
    }

    this.store.set("canary.hashes", newHashes);
    this._active = true;
    this.emit("started", { files: Object.keys(newHashes).length });
  }

  stop() {
    for (const watcher of this._watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    this._watchers = [];

    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    this._active = false;
  }

  getStatus() {
    const hashes = this.store.get("canary.hashes") || {};
    return {
      active: this._active,
      files: Object.keys(hashes),
      events: this.events,
    };
  }

  _createCanaryFile(filePath) {
    const content = crypto.randomBytes(256);
    fs.writeFileSync(filePath, content);
  }

  _hashFile(filePath) {
    try {
      const data = fs.readFileSync(filePath);
      return crypto.createHash("sha256").update(data).digest("hex");
    } catch {
      return null;
    }
  }

  _watchFile(filePath) {
    try {
      const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
        this._debouncedCheck(filePath, eventType);
      });
      watcher.on("error", () => { /* file may have been deleted — directory watcher handles it */ });

      // Also watch the parent directory for deletion/rename detection
      const dirWatcher = fs.watch(path.dirname(filePath), { persistent: false }, (eventType, filename) => {
        if (filename === CANARY_FILENAME) {
          this._debouncedCheck(filePath, eventType);
        }
      });
      dirWatcher.on("error", (e) => console.error(`Canary dir watch error: ${e.message}`));

      this._watchers.push(watcher, dirWatcher);
    } catch (e) {
      console.error(`Canary watch failed for ${filePath}: ${e.message}`);
    }
  }

  _debouncedCheck(filePath, eventType) {
    // Clear existing debounce timer for this file
    if (this._debounceTimers.has(filePath)) {
      clearTimeout(this._debounceTimers.get(filePath));
    }

    this._debounceTimers.set(filePath, setTimeout(() => {
      this._debounceTimers.delete(filePath);
      this._verifyFile(filePath);
    }, DEBOUNCE_MS));
  }

  _verifyFile(filePath) {
    const hashes = this.store.get("canary.hashes") || {};
    const expectedHash = hashes[filePath];

    if (!fs.existsSync(filePath)) {
      // File was deleted
      const event = { type: "deleted", file: filePath, time: new Date().toISOString() };
      this.events.push(event);
      this.emit("triggered", event);

      // Self-heal: recreate
      this._createCanaryFile(filePath);
      hashes[filePath] = this._hashFile(filePath);
      this.store.set("canary.hashes", hashes);
      this.emit("restored", { file: filePath, time: new Date().toISOString() });

      // Re-watch the new file
      this._watchFile(filePath);
      return;
    }

    const currentHash = this._hashFile(filePath);
    if (expectedHash && currentHash !== expectedHash) {
      // File was modified
      const event = { type: "modified", file: filePath, time: new Date().toISOString() };
      this.events.push(event);
      this.emit("triggered", event);

      // Self-heal: restore original content
      this._createCanaryFile(filePath);
      hashes[filePath] = this._hashFile(filePath);
      this.store.set("canary.hashes", hashes);
      this.emit("restored", { file: filePath, time: new Date().toISOString() });
    }
  }
}

module.exports = CanarySystem;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/vizoguard-app && npm test -- test/core/canary.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/canary.js test/core/canary.test.js
git commit -m "feat: add CanarySystem ransomware tripwire module"
```

---

## Task 7: Persistence Hardener Module

**Files:**
- Create: `src/core/persistence.js`
- Create: `test/core/persistence.test.js`

- [ ] **Step 1: Write failing tests for PersistenceHardener**

Create `test/core/persistence.test.js`:
```js
const path = require("path");
const fs = require("fs");
const os = require("os");
const PersistenceHardener = require("../../src/core/persistence");

function mockStore(initialData = {}) {
  const data = { ...initialData };
  return {
    get: (key) => data[key],
    set: (key, val) => { data[key] = val; },
    delete: (key) => { delete data[key]; },
    _data: data,
    path: "/fake/store/path.json",
  };
}

function mockPlatform() {
  return {
    setCredential: jest.fn().mockResolvedValue(undefined),
    getCredential: jest.fn().mockResolvedValue(null),
    deleteCredential: jest.fn().mockResolvedValue(undefined),
    clearProxy: jest.fn().mockResolvedValue(undefined),
  };
}

describe("PersistenceHardener", () => {
  let tmpDir, store, platform, hardener;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-test-"));
    fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
    store = mockStore({ "license.key": "TEST-KEY-123", "license.vpnAccessUrl": "ss://test-url" });
    platform = mockPlatform();
    hardener = new PersistenceHardener(store, tmpDir, platform);
  });

  afterEach(() => {
    hardener.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("start takes initial snapshot on clean shutdown", async () => {
    // Write clean heartbeat
    fs.writeFileSync(path.join(tmpDir, "data", "heartbeat.json"), JSON.stringify({ cleanShutdown: true }));

    const events = [];
    hardener.on("snapshot-saved", () => events.push("snapshot"));
    await hardener.start();

    // Should have saved credentials
    expect(platform.setCredential).toHaveBeenCalledWith("com.vizoguard.app", "license-key", "TEST-KEY-123");
    expect(platform.setCredential).toHaveBeenCalledWith("com.vizoguard.app", "vpn-access-url", "ss://test-url");

    // Should have written config backup
    const backupPath = path.join(tmpDir, "recovery", "config-backup.json");
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  test("start runs full validation on unclean shutdown", async () => {
    // Write unclean heartbeat
    fs.writeFileSync(path.join(tmpDir, "data", "heartbeat.json"), JSON.stringify({ cleanShutdown: false }));

    await hardener.start();
    // Should still snapshot since store is readable
    expect(platform.setCredential).toHaveBeenCalled();
  });

  test("wasCorrupted returns false when store is healthy", async () => {
    fs.writeFileSync(path.join(tmpDir, "data", "heartbeat.json"), JSON.stringify({ cleanShutdown: true }));
    await hardener.start();
    expect(hardener.wasCorrupted()).toBe(false);
  });

  test("restore recovers license key from credential store", async () => {
    const emptyStore = mockStore({});
    platform.getCredential.mockImplementation((service, account) => {
      if (account === "license-key") return Promise.resolve("RESTORED-KEY");
      if (account === "vpn-access-url") return Promise.resolve("ss://restored");
      return Promise.resolve(null);
    });

    const h = new PersistenceHardener(emptyStore, tmpDir, platform);

    // Write config backup
    fs.mkdirSync(path.join(tmpDir, "recovery"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "recovery", "config-backup.json"), JSON.stringify({ "some.pref": "value" }));

    await h.restore();

    expect(emptyStore._data["license.key"]).toBe("RESTORED-KEY");
    expect(emptyStore._data["license.vpnAccessUrl"]).toBe("ss://restored");
    expect(emptyStore._data["some.pref"]).toBe("value");
    h.stop();
  });

  test("stop takes final snapshot", async () => {
    fs.writeFileSync(path.join(tmpDir, "data", "heartbeat.json"), JSON.stringify({ cleanShutdown: true }));
    await hardener.start();

    platform.setCredential.mockClear();
    hardener.stop();

    expect(platform.setCredential).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/vizoguard-app && npm test -- test/core/persistence.test.js`
Expected: FAIL — cannot find module `../../src/core/persistence`

- [ ] **Step 3: Implement PersistenceHardener**

Create `src/core/persistence.js`:
```js
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const DEBOUNCE_MS = 30000; // 30 seconds
const SERVICE_NAME = "com.vizoguard.app";
const SECRET_KEYS = [
  { storeKey: "license.key", credAccount: "license-key" },
  { storeKey: "license.vpnAccessUrl", credAccount: "vpn-access-url" },
];

class PersistenceHardener extends EventEmitter {
  constructor(store, userDataPath, platform) {
    super();
    this.store = store;
    this.userDataPath = userDataPath;
    this.platform = platform;
    this._heartbeatPath = path.join(userDataPath, "data", "heartbeat.json");
    this._backupPath = path.join(userDataPath, "recovery", "config-backup.json");
    this._corrupted = false;
    this._snapshotTimer = null;
    this._lastSnapshot = 0;
  }

  async start() {
    // Check if last shutdown was clean
    const cleanShutdown = this._readCleanShutdown();

    if (!cleanShutdown) {
      // Validate store integrity
      const storeHealthy = this._validateStore();

      if (!storeHealthy) {
        this._corrupted = true;
        this.emit("corruption-detected");
        await this.restore();
      }

      // Clean up orphaned proxy settings
      try {
        await this.platform.clearProxy();
        this.emit("proxy-cleaned");
      } catch { /* best effort */ }
    }

    // Take initial snapshot
    await this.snapshot();

    this.emit("started");
  }

  stop() {
    if (this._snapshotTimer) {
      clearTimeout(this._snapshotTimer);
      this._snapshotTimer = null;
    }

    // Synchronous final snapshot — write config backup file only.
    // Credential store was already saved by the last periodic snapshot.
    // Async credential store calls are skipped here to avoid race with app.exit().
    this._doSyncSnapshot();
  }

  _doSyncSnapshot() {
    try {
      const recoveryDir = path.dirname(this._backupPath);
      if (!fs.existsSync(recoveryDir)) fs.mkdirSync(recoveryDir, { recursive: true });

      const config = {};
      const configKeys = ["canary.hashes", "device.trustedNetworks", "device.autoVpn"];
      for (const key of configKeys) {
        const val = this.store.get(key);
        if (val !== undefined) config[key] = val;
      }
      fs.writeFileSync(this._backupPath, JSON.stringify(config, null, 2));
    } catch { /* best effort */ }

    this.emit("snapshot-saved");
  }

  async snapshot() {
    const now = Date.now();
    if (now - this._lastSnapshot < DEBOUNCE_MS) return;
    await this._doSnapshot();
  }

  async restore() {
    // Restore secrets from OS credential store
    for (const { storeKey, credAccount } of SECRET_KEYS) {
      try {
        const value = await this.platform.getCredential(SERVICE_NAME, credAccount);
        if (value) {
          this.store.set(storeKey, value);
        }
      } catch { /* credential not found */ }
    }

    // Restore config from backup file
    try {
      if (fs.existsSync(this._backupPath)) {
        const backup = JSON.parse(fs.readFileSync(this._backupPath, "utf8"));
        for (const [key, value] of Object.entries(backup)) {
          this.store.set(key, value);
        }
      }
    } catch { /* backup file corrupt or missing */ }

    this.emit("state-restored");
  }

  wasCorrupted() {
    return this._corrupted;
  }

  _readCleanShutdown() {
    try {
      const data = JSON.parse(fs.readFileSync(this._heartbeatPath, "utf8"));
      return data.cleanShutdown === true;
    } catch {
      return false;
    }
  }

  _validateStore() {
    try {
      // Check that the store is readable and has at least a license key
      const key = this.store.get("license.key");
      return typeof key === "string" && key.length > 0;
    } catch {
      return false;
    }
  }

  async _doSnapshot() {
    this._lastSnapshot = Date.now();

    // Snapshot secrets to OS credential store
    for (const { storeKey, credAccount } of SECRET_KEYS) {
      const value = this.store.get(storeKey);
      if (value) {
        try {
          await this.platform.setCredential(SERVICE_NAME, credAccount, value);
        } catch { /* best effort */ }
      }
    }

    // Snapshot config to backup file
    try {
      const recoveryDir = path.dirname(this._backupPath);
      if (!fs.existsSync(recoveryDir)) fs.mkdirSync(recoveryDir, { recursive: true });

      // Snapshot non-secret config keys
      const config = {};
      const secretKeys = new Set(SECRET_KEYS.map((s) => s.storeKey));
      // We snapshot known config keys that aren't secrets
      const configKeys = ["canary.hashes", "device.trustedNetworks", "device.autoVpn"];
      for (const key of configKeys) {
        const val = this.store.get(key);
        if (val !== undefined) config[key] = val;
      }

      fs.writeFileSync(this._backupPath, JSON.stringify(config, null, 2));
    } catch { /* best effort */ }

    this.emit("snapshot-saved");
  }
}

module.exports = PersistenceHardener;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/vizoguard-app && npm test -- test/core/persistence.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/persistence.js test/core/persistence.test.js
git commit -m "feat: add PersistenceHardener state recovery module"
```

---

## Task 8: Device Monitor Module

**Files:**
- Create: `src/core/device-monitor.js`
- Create: `test/core/device-monitor.test.js`

- [ ] **Step 1: Write failing tests for DeviceMonitor**

Create `test/core/device-monitor.test.js`:
```js
const DeviceMonitor = require("../../src/core/device-monitor");

function mockStore(initialData = {}) {
  const data = { ...initialData };
  return {
    get: (key) => data[key],
    set: (key, val) => { data[key] = val; },
    delete: (key) => { delete data[key]; },
    _data: data,
  };
}

function mockPlatform(networkInfo = { ssid: "HomeWiFi", gateway: "192.168.1.1", subnet: "255.255.255.0" }) {
  return {
    getNetworkInfo: jest.fn().mockResolvedValue(networkInfo),
  };
}

describe("DeviceMonitor", () => {
  let store, platform, monitor;

  beforeEach(() => {
    store = mockStore({});
    platform = mockPlatform();
    monitor = new DeviceMonitor(store, platform);
  });

  afterEach(() => {
    monitor.stop();
  });

  test("start emits first-network on first ever network seen", async () => {
    // Ensure no hasSeenFirstNetwork flag
    expect(store.get("device.hasSeenFirstNetwork")).toBeUndefined();

    const events = [];
    monitor.on("first-network", (data) => events.push(data));

    await monitor.start();

    // Wait for first poll
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toHaveLength(1);
    expect(events[0].ssid).toBe("HomeWiFi");
    // Flag should now be persisted
    expect(store.get("device.hasSeenFirstNetwork")).toBe(true);
  });

  test("does not emit first-network on restart", async () => {
    store.set("device.hasSeenFirstNetwork", true);

    const events = [];
    monitor.on("first-network", (data) => events.push(data));

    await monitor.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toHaveLength(0);
  });

  test("known trusted network emits trusted-network", async () => {
    store.set("device.hasSeenFirstNetwork", true);
    // Pre-populate trust list with the network hash
    const crypto = require("crypto");
    const fingerprint = crypto.createHash("sha256").update("HomeWiFi192.168.1.1255.255.255.0").digest("hex");
    store.set("device.trustedNetworks", [{ hash: fingerprint, label: "Home", trustedAt: Date.now() }]);

    const events = [];
    monitor.on("trusted-network", (data) => events.push(data));

    await monitor.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toHaveLength(1);
  });

  test("unknown network emits untrusted-network", async () => {
    store.set("device.hasSeenFirstNetwork", true);
    // Trust list has a different network
    store.set("device.trustedNetworks", [{ hash: "different-hash", label: "Office", trustedAt: Date.now() }]);

    const events = [];
    monitor.on("untrusted-network", (data) => events.push(data));

    await monitor.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toHaveLength(1);
  });

  test("trustCurrent adds current network to trust list", async () => {
    await monitor.start();
    await new Promise((r) => setTimeout(r, 100));

    monitor.trustCurrent("Home");

    const networks = store.get("device.trustedNetworks");
    expect(networks).toHaveLength(1);
    expect(networks[0].label).toBe("Home");
  });

  test("untrustCurrent removes current network from trust list", async () => {
    const crypto = require("crypto");
    const fingerprint = crypto.createHash("sha256").update("HomeWiFi192.168.1.1255.255.255.0").digest("hex");
    store.set("device.trustedNetworks", [{ hash: fingerprint, label: "Home", trustedAt: Date.now() }]);

    await monitor.start();
    await new Promise((r) => setTimeout(r, 100));

    monitor.untrustCurrent();

    const networks = store.get("device.trustedNetworks");
    expect(networks).toHaveLength(0);
  });

  test("getStatus returns current network info", async () => {
    await monitor.start();
    await new Promise((r) => setTimeout(r, 100));

    const status = monitor.getStatus();
    expect(status.currentNetwork).toBeDefined();
    expect(status.currentNetwork.ssid).toBe("HomeWiFi");
  });

  test("network change emits network-changed", async () => {
    await monitor.start();
    await new Promise((r) => setTimeout(r, 100));

    const events = [];
    monitor.on("network-changed", (data) => events.push(data));

    // Change network
    platform.getNetworkInfo.mockResolvedValue({ ssid: "CoffeeShop", gateway: "10.0.0.1", subnet: "255.255.255.0" });

    // Trigger a poll manually
    await monitor._poll();

    expect(events).toHaveLength(1);
    expect(events[0].ssid).toBe("CoffeeShop");
  });

  test("wired connection uses gateway+subnet only for fingerprint", async () => {
    platform.getNetworkInfo.mockResolvedValue({ ssid: null, gateway: "192.168.1.1", subnet: "255.255.255.0" });

    await monitor.start();
    await new Promise((r) => setTimeout(r, 100));

    const status = monitor.getStatus();
    expect(status.currentNetwork.ssid).toBeNull();
    expect(status.currentNetwork.gateway).toBe("192.168.1.1");
  });

  test("stop clears polling interval", async () => {
    await monitor.start();
    monitor.stop();
    // Verify no more polls happen
    platform.getNetworkInfo.mockClear();
    await new Promise((r) => setTimeout(r, 200));
    expect(platform.getNetworkInfo).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/vizoguard-app && npm test -- test/core/device-monitor.test.js`
Expected: FAIL — cannot find module `../../src/core/device-monitor`

- [ ] **Step 3: Implement DeviceMonitor**

Create `src/core/device-monitor.js`:
```js
const { EventEmitter } = require("events");
const crypto = require("crypto");

const POLL_INTERVAL = 30000; // 30 seconds

class DeviceMonitor extends EventEmitter {
  constructor(store, platform) {
    super();
    this.store = store;
    this.platform = platform;
    this._timer = null;
    this._currentNetwork = null;
    this._currentFingerprint = null;
    this._firstPoll = true;
  }

  async start() {
    this._firstPoll = !this.store.get("device.hasSeenFirstNetwork");

    // Initial poll
    await this._poll();

    // Start periodic polling
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL);

    this.emit("started");
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  trustCurrent(label) {
    if (!this._currentFingerprint) return;

    const networks = this.store.get("device.trustedNetworks") || [];
    // Don't duplicate
    if (networks.some((n) => n.hash === this._currentFingerprint)) return;

    networks.push({
      hash: this._currentFingerprint,
      label,
      trustedAt: Date.now(),
    });
    this.store.set("device.trustedNetworks", networks);
  }

  untrustCurrent() {
    if (!this._currentFingerprint) return;

    const networks = this.store.get("device.trustedNetworks") || [];
    const filtered = networks.filter((n) => n.hash !== this._currentFingerprint);
    this.store.set("device.trustedNetworks", filtered);
  }

  getStatus() {
    const networks = this.store.get("device.trustedNetworks") || [];
    return {
      currentNetwork: this._currentNetwork,
      trusted: this._isTrusted(),
      knownNetworks: networks,
    };
  }

  async _poll() {
    let info;
    try {
      info = await this.platform.getNetworkInfo();
    } catch {
      return; // offline or error
    }

    if (!info) return; // disconnected

    const fingerprint = this._fingerprint(info);

    // Detect network change
    if (this._currentFingerprint && fingerprint !== this._currentFingerprint) {
      this.emit("network-changed", info);
    }

    this._currentNetwork = info;
    this._currentFingerprint = fingerprint;

    // First network ever seen — prompt user to confirm trust
    if (this._firstPoll) {
      this._firstPoll = false;
      this.store.set("device.hasSeenFirstNetwork", true);
      this.emit("first-network", info);
      return;
    }

    // Check trust status
    if (this._isTrusted()) {
      this.emit("trusted-network", info);
    } else {
      this.emit("untrusted-network", info);
    }
  }

  _fingerprint(info) {
    // For wired (no SSID), use gateway + subnet only
    const parts = [info.ssid || "", info.gateway || "", info.subnet || ""];
    return crypto.createHash("sha256").update(parts.join("")).digest("hex");
  }

  _isTrusted() {
    if (!this._currentFingerprint) return false;
    const networks = this.store.get("device.trustedNetworks") || [];
    return networks.some((n) => n.hash === this._currentFingerprint);
  }
}

module.exports = DeviceMonitor;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/vizoguard-app && npm test -- test/core/device-monitor.test.js`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/device-monitor.js test/core/device-monitor.test.js
git commit -m "feat: add DeviceMonitor network awareness module"
```

---

## Task 9: Update Core Exports

**Files:**
- Modify: `src/core/index.js`

- [ ] **Step 1: Update index.js with all new exports**

Replace `src/core/index.js` with:
```js
const ThreatChecker = require("./threat-checker");
const ConnectionMonitor = require("./connection-monitor");
const SecurityProxy = require("./proxy");
const ImmuneSystem = require("./immune-system");
const SecurityEngine = require("./engine");
const Sentinel = require("./sentinel");
const CanarySystem = require("./canary");
const PersistenceHardener = require("./persistence");
const DeviceMonitor = require("./device-monitor");

module.exports = {
  ThreatChecker,
  ConnectionMonitor,
  SecurityProxy,
  ImmuneSystem,
  SecurityEngine,
  Sentinel,
  CanarySystem,
  PersistenceHardener,
  DeviceMonitor,
};
```

- [ ] **Step 2: Verify syntax and require resolves**

Run: `node -e "require('./src/core')"`
Expected: No errors (all modules load)

- [ ] **Step 3: Run all tests**

Run: `cd /root/vizoguard-app && npm test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/index.js
git commit -m "feat: export all immune system modules from core index"
```

---

## Task 10: Integration — main.js

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add engine imports and module-level variable**

At the top of `main.js`, update the core import (where `require("./src/core")` is):
```js
const { ThreatChecker, ConnectionMonitor, SecurityProxy, ImmuneSystem, SecurityEngine, Sentinel, CanarySystem, PersistenceHardener, DeviceMonitor } = require("./src/core");
```

Add `os` and `platform` requires near the other requires:
```js
const os = require("os");
const platform = require("./src/platform");
```

After the existing module initialization (after `const updater = new Updater();`), add a module-level variable:
```js
let engine = null;
```

**Note:** The engine is instantiated inside `startSecurityEngine()` (not at module level) because `app.getPath()` requires `app.whenReady()` to have resolved first.

- [ ] **Step 2: Add engine start to startSecurityEngine()**

In `startSecurityEngine()` function (after `console.log("Security engine started")`), add:
```js
  // Initialize and start immune system v2
  const userDataPath = app.isPackaged ? app.getPath("userData") : __dirname;
  const appPath = app.isPackaged ? app.getPath("exe") : process.execPath;
  engine = new SecurityEngine();
  engine.register("persistence", new PersistenceHardener(store, userDataPath, platform));
  engine.register("sentinel", new Sentinel(appPath, userDataPath));
  engine.register("canary", new CanarySystem(store, os.homedir()));
  engine.register("device", new DeviceMonitor(store, platform));
  try {
    await engine.start();
    console.log("Immune system v2 started");
  } catch (e) {
    console.error("Engine start error:", e.message);
  }
```

- [ ] **Step 3: Add engine event forwarding**

After the existing `immuneSystem.on("alert", ...)` block (after line 133), add:
```js
// Immune system v2 events
engine.on("canary:triggered", (data) => {
  sendToRenderer("canary:alert", data);
});

engine.on("device:untrusted-network", async (data) => {
  sendToRenderer("device:alert", data);
  // Auto-connect VPN if preference allows and VPN is not connected
  const autoVpn = store.get("device.autoVpn") !== false; // default: on
  if (autoVpn && !vpn.isConnected) {
    try {
      await vpn.connect();
    } catch { /* VPN connect failed, user will see the alert */ }
  }
});

engine.on("device:first-network", (data) => {
  sendToRenderer("device:first-network", data);
});

engine.on("persistence:state-restored", (data) => {
  sendToRenderer("persistence:restored", data);
});

engine.on("engine:module-error", (data) => {
  console.error(`Module ${data.name} failed:`, data.error?.message);
});
```

- [ ] **Step 4: Add engine stop to shutdown and license invalidation**

In `trayCallbacks.quit()` (before `license.stopPeriodicCheck()` at line 96), add:
```js
    engine.stop();
```

In `license.onStatusChange()` (after `immuneSystem.stop()` at line 279), add:
```js
    engine.stop();
```

- [ ] **Step 5: Add new IPC handlers**

After the existing `app:close` handler (after line 252), add:
```js
ipcMain.handle("device:status", () => {
  const device = engine.modules.get("device");
  return device ? device.getStatus() : null;
});

ipcMain.handle("device:trust", (_event, label) => {
  const device = engine.modules.get("device");
  if (device) device.trustCurrent(label);
  return { success: true };
});

ipcMain.handle("device:untrust", () => {
  const device = engine.modules.get("device");
  if (device) device.untrustCurrent();
  return { success: true };
});
```

Update the existing `security:stats` handler to include new data:
```js
ipcMain.handle("security:stats", () => {
  const canary = engine.modules.get("canary");
  const device = engine.modules.get("device");
  const deviceStatus = device ? device.getStatus() : {};
  return {
    threatsBlocked: securityProxy.threatsBlocked + threatChecker.threatsBlocked,
    requestsScanned: securityProxy.requestsScanned,
    activeConnections: connectionMonitor.activeConnections,
    immuneEvents: immuneSystem.events.length,
    proxyRunning: !!securityProxy._server,
    vpnConnected: vpn.isConnected,
    canaryActive: canary ? canary.getStatus().active : false,
    canaryEvents: canary ? canary.events.length : 0,
    networkTrusted: deviceStatus.trusted || false,
    currentNetwork: deviceStatus.currentNetwork?.ssid || null,
  };
});
```

- [ ] **Step 6: Verify syntax**

Run: `node -c main.js`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "feat: integrate immune system v2 engine into main process"
```

---

## Task 11: Integration — preload.js

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Add new IPC bridge methods**

In `preload.js`, add new methods inside the `contextBridge.exposeInMainWorld("vizoguard", { ... })` block:

After the security section (after `getSecurityStats`), add:
```js
  // Device Monitor
  getDeviceStatus: () => ipcRenderer.invoke("device:status"),
  trustNetwork: (label) => ipcRenderer.invoke("device:trust", label),
  untrustNetwork: () => ipcRenderer.invoke("device:untrust"),
```

After the existing event listeners (after `onSecurityError`), add:
```js
  onCanaryAlert: (cb) => ipcRenderer.on("canary:alert", (_e, d) => cb(d)),
  onDeviceAlert: (cb) => ipcRenderer.on("device:alert", (_e, d) => cb(d)),
  onDeviceFirstNetwork: (cb) => ipcRenderer.on("device:first-network", (_e, d) => cb(d)),
  onPersistenceRestored: (cb) => ipcRenderer.on("persistence:restored", (_e, d) => cb(d)),
```

- [ ] **Step 2: Verify syntax**

Run: `node -c preload.js`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat: add IPC bridge methods for immune system v2 modules"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Run all tests**

Run: `cd /root/vizoguard-app && npm test`
Expected: All tests PASS (engine: 6, sentinel: 5, canary: 7, persistence: 5, device-monitor: 10 = 33 tests)

- [ ] **Step 2: Verify all files load without errors**

Run: `node -e "require('./src/core'); console.log('Core modules loaded')"`
Expected: "Core modules loaded"

Note: `preload.js` cannot be verified via `node -e require()` since it depends on Electron's `contextBridge`. Syntax check (`node -c`) in Step 3 covers it.

- [ ] **Step 3: Verify syntax of all new/modified files**

Run: `node -c src/core/engine.js && node -c src/core/sentinel.js && node -c src/core/sentinel-worker.js && node -c src/core/canary.js && node -c src/core/persistence.js && node -c src/core/device-monitor.js && node -c main.js`
Expected: No errors

- [ ] **Step 4: Commit any final fixes if needed**

- [ ] **Step 5: Update CLAUDE.md**

Add the new modules to `vizoguard-app/CLAUDE.md` under the Stack section:
```
- Security Engine v2: `src/core/engine.js` — lifecycle registry for new modules
- Sentinel: `src/core/sentinel.js` + `sentinel-worker.js` — watchdog child process
- Canary System: `src/core/canary.js` — ransomware tripwire files
- Persistence Hardener: `src/core/persistence.js` — state backup/restore via OS credential store
- Device Monitor: `src/core/device-monitor.js` — network trust + auto-VPN
```

- [ ] **Step 6: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with immune system v2 modules"
```
