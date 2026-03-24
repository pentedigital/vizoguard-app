// Connection Manager — adaptive transport selection with fallback
// Tries direct Shadowsocks first, falls back to obfuscated (sing-box VLESS+WS+TLS)
// Caches working mode per network (gateway IP hash)

const crypto = require("crypto");
const { EventEmitter } = require("events");

class ConnectionManager extends EventEmitter {
  constructor(directTransport, obfuscatedTransport, store) {
    super();
    this._direct = directTransport;
    this._obfuscated = obfuscatedTransport;
    this._store = store;
    this._active = null; // currently active transport
    this._connecting = false;
    this._aborted = false;
  }

  get isConnected() {
    return this._active !== null && this._active.isRunning;
  }

  get activeMode() {
    return this._active ? this._active.name : null;
  }

  // Main connect — try direct, fallback to obfuscated, cache result
  async connect() {
    if (this._connecting || this.isConnected) return;
    this._connecting = true;
    this._aborted = false;

    try {
      const mode = this._store.get("connectionMode", "auto");

      if (mode === "direct") {
        await this._startTransport(this._direct);
        return;
      }

      if (mode === "obfuscated") {
        await this._startTransport(this._obfuscated);
        return;
      }

      // Auto mode: check cache, then try/fallback
      const cacheKey = await this._getNetworkCacheKey();
      const cached = cacheKey ? this._store.get(`transportCache.${cacheKey}`) : null;

      if (cached && cached.mode && (Date.now() - new Date(cached.ts).getTime()) < 7 * 24 * 60 * 60 * 1000) {
        console.log(`Using cached transport mode: ${cached.mode} (network ${cacheKey})`);
        const transport = cached.mode === "obfuscated" ? this._obfuscated : this._direct;
        try {
          await this._startTransport(transport);
          return;
        } catch {
          console.log("Cached mode failed, falling through to auto-detect");
        }
      }

      // Try direct first (5s TCP probe)
      if (this._aborted) return;
      console.log("Auto mode: testing direct connection...");
      const directOk = await this._direct.test(5000);

      if (this._aborted) return;
      if (directOk) {
        console.log("Direct connection available — using direct mode");
        try {
          await this._startTransport(this._direct);
          if (cacheKey) this._cacheMode(cacheKey, "direct");
          return;
        } catch (e) {
          console.log("Direct transport failed after probe:", e.message);
        }
      }

      if (this._aborted) return;
      // Fallback to obfuscated
      console.log("Direct blocked — switching to obfuscated mode (VLESS+WS+TLS)");
      try {
        await this._startTransport(this._obfuscated);
        if (cacheKey) this._cacheMode(cacheKey, "obfuscated");
        return;
      } catch (e) {
        throw new Error(`Both transport modes failed. Direct: connection blocked. Obfuscated: ${e.message}`);
      }
    } finally {
      this._connecting = false;
    }
  }

  async disconnect() {
    this._aborted = true; // cancel any in-progress connect
    if (this._active) {
      const transport = this._active;
      this._active = null;
      await transport.stop();
    }
  }

  // Emergency rollback — force-stop everything
  async emergencyStop() {
    try { await this._direct.stop(); } catch {}
    try { await this._obfuscated.stop(); } catch {}
    this._active = null;
  }

  async _startTransport(transport) {
    // Wire up events
    const onError = (err) => this.emit("error", err);
    const onDisconnected = () => {
      this._active = null;
      transport.removeListener("error", onError);
      transport.removeListener("disconnected", onDisconnected);
      this.emit("disconnected");
    };

    transport.on("error", onError);
    transport.on("disconnected", onDisconnected);

    try {
      await transport.start();
      // If disconnect was called while transport.start() was in-flight, tear down
      if (this._aborted) {
        try { await transport.stop(); } catch {}
        transport.removeListener("error", onError);
        transport.removeListener("disconnected", onDisconnected);
        return;
      }
      this._active = transport;
      this.emit("connected", { mode: transport.name });
    } catch (e) {
      transport.removeListener("error", onError);
      transport.removeListener("disconnected", onDisconnected);
      throw e;
    }
  }

  async _getNetworkCacheKey() {
    try {
      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFile);

      let gateway = null;
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("/sbin/route", ["-n", "get", "default"]);
        const match = stdout.match(/gateway:\s*(\S+)/);
        gateway = match ? match[1] : null;
      } else {
        const { stdout } = await execFileAsync("route", ["print", "0.0.0.0"]);
        const lines = stdout.split("\n");
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts[0] === "0.0.0.0" && parts[1] === "0.0.0.0") {
            gateway = parts[2];
            break;
          }
        }
      }

      if (!gateway) return null;
      return crypto.createHash("sha256").update(gateway).digest("hex").slice(0, 12);
    } catch {
      return null;
    }
  }

  _cacheMode(cacheKey, mode) {
    this._store.set(`transportCache.${cacheKey}`, { mode, ts: new Date().toISOString() });
    console.log(`Cached transport mode: ${mode} for network ${cacheKey}`);
  }
}

module.exports = ConnectionManager;
