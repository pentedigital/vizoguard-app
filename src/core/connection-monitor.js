const { EventEmitter } = require("events");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const platform = require("../platform");

const SCAN_INTERVAL = 2000; // 2 seconds
const STAGGER_MS = 400; // ~400ms between commands

class ConnectionMonitor extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._known = new Map(); // pid:address -> last seen
    this.activeConnections = 0;
    this.totalScanned = 0;
    this._isRunning = new Map(); // command name -> boolean
    this._batchConnections = [];
    this._batchProcessed = false;
    this._commands = this._buildCommands();
  }

  start() {
    if (this._timer) return;
    this._scan();
    this._timer = setInterval(() => this._scan(), SCAN_INTERVAL);
    console.log("Connection monitor started");
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _buildCommands() {
    if (process.platform === "darwin") {
      return [
        { name: "lsof", run: () => platform.getConnections() },
        { name: "netstat", run: () => this._runNetstatDarwin() },
        { name: "route", run: () => this._runRouteDarwin() },
        { name: "ifconfig", run: () => this._runIfconfigDarwin() },
        { name: "ss", run: () => this._runSsDarwin() },
      ];
    }
    return [
      { name: "netstat", run: () => platform.getConnections() },
      { name: "route", run: () => this._runRouteWin() },
      { name: "ipconfig", run: () => this._runIpconfigWin() },
      { name: "netsh", run: () => this._runNetshWin() },
      { name: "tasklist", run: () => this._runTasklistWin() },
    ];
  }

  async _runNetstatDarwin() {
    try {
      const { stdout } = await execFileAsync("netstat", ["-anv"]);
      const lines = stdout.split("\n").filter((l) => l.includes("ESTABLISHED"));
      return lines.map((line) => {
        const parts = line.trim().split(/\s+/);
        return { process: parts[0] || "unknown", pid: parts[8] || "", address: parts[3] || "" };
      });
    } catch {
      return [];
    }
  }

  async _runRouteDarwin() {
    try {
      const { stdout } = await execFileAsync("/sbin/route", ["-n", "get", "default"]);
      const match = stdout.match(/gateway:\s*(\S+)/);
      return match ? [{ process: "route", pid: "0", address: match[1] || "" }] : [];
    } catch {
      return [];
    }
  }

  async _runIfconfigDarwin() {
    try {
      const { stdout } = await execFileAsync("ifconfig", ["-a"]);
      const interfaces = stdout.split("\n").filter(l => l.match(/^\w/)).map(l => l.split(":")[0]);
      return interfaces.map(name => ({ process: "ifconfig", pid: "0", address: name }));
    } catch {
      return [];
    }
  }

  async _runSsDarwin() {
    try {
      const { stdout } = await execFileAsync("ss", ["-tan", "state", "established"]);
      const lines = stdout.split("\n").slice(1).filter(Boolean);
      return lines.map((line) => {
        const parts = line.trim().split(/\s+/);
        return { process: parts[0] || "unknown", pid: "", address: parts[4] || "" };
      });
    } catch {
      return [];
    }
  }

  async _runRouteWin() {
    try {
      const { stdout } = await execFileAsync("route", ["print", "0.0.0.0"]);
      const lines = stdout.split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === "0.0.0.0" && parts[1] === "0.0.0.0") {
          return [{ process: "route", pid: "0", address: parts[2] || "" }];
        }
      }
      return [];
    } catch {
      return [];
    }
  }

  async _runIpconfigWin() {
    try {
      const { stdout } = await execFileAsync("ipconfig", ["/all"]);
      const lines = stdout.split("\n");
      const addrs = [];
      for (const line of lines) {
        const match = line.match(/IPv4 Address.*:\s+(\S+)/);
        if (match) addrs.push({ process: "ipconfig", pid: "0", address: match[1] });
      }
      return addrs;
    } catch {
      return [];
    }
  }

  async _runNetshWin() {
    try {
      const { stdout } = await execFileAsync("netsh", ["interface", "show", "interface"]);
      const lines = stdout.split("\n");
      const addrs = [];
      for (const line of lines) {
        const m = line.match(/(\S+\s+\S+.*\s+Connected)/);
        if (m) addrs.push({ process: "netsh", pid: "0", address: m[1] });
      }
      return addrs;
    } catch {
      return [];
    }
  }

  async _runTasklistWin() {
    try {
      await execFileAsync("tasklist", ["/fo", "csv"]);
      return [];
    } catch {
      return [];
    }
  }

  async _scan() {
    try {
      // Cap known connections map to prevent memory growth under extreme churn
      if (this._known.size > 10000) this._known.clear();

      this._batchConnections = [];
      this._batchProcessed = false;

      for (let i = 0; i < this._commands.length; i++) {
        setTimeout(() => this._runSingleCommand(i), i * STAGGER_MS);
      }

      // Process merged results near the end of the window
      setTimeout(() => this._processBatch(), SCAN_INTERVAL - 100);
    } catch (e) {
      console.error("Connection scan error:", e.message);
      this.emit("scan", {
        active: this.activeConnections,
        total: this.totalScanned,
      });
    }
  }

  async _runSingleCommand(index) {
    const cmd = this._commands[index];
    if (this._isRunning.get(cmd.name)) return; // throttling
    this._isRunning.set(cmd.name, true);
    try {
      const connections = await cmd.run();
      this._batchConnections.push(...connections);
    } catch (e) {
      console.error(`Connection scan error (${cmd.name}):`, e.message);
    } finally {
      this._isRunning.set(cmd.name, false);
    }
  }

  _processBatch() {
    if (this._batchProcessed) return;
    this._batchProcessed = true;

    // Deduplicate by pid:address
    const merged = [];
    const seen = new Set();
    for (const conn of this._batchConnections) {
      const key = `${conn.pid}:${conn.address}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(conn);
      }
    }

    this.activeConnections = merged.length;
    this.totalScanned++;

    // Detect new connections
    const currentKeys = new Set();
    for (const conn of merged) {
      const key = `${conn.pid}:${conn.address}`;
      currentKeys.add(key);

      if (!this._known.has(key)) {
        this._known.set(key, Date.now());
        this.emit("new-connection", conn);
      }
    }

    // Clean up stale entries
    for (const [key] of this._known) {
      if (!currentKeys.has(key)) {
        this._known.delete(key);
      }
    }

    this.emit("scan", {
      active: this.activeConnections,
      total: this.totalScanned,
    });
  }
}

module.exports = ConnectionMonitor;
