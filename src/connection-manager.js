// Connection Manager — adaptive transport selection with fallback
// Tries direct Shadowsocks first, falls back to obfuscated (sing-box VLESS+WS+TLS)
// Caches working mode per network (gateway IP hash)
// Integrates kill switch (firewall) and auto-reconnection

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

// Auto-reconnect config
const RECONNECT_BASE_DELAY = 1000;  // 1s
const RECONNECT_MAX_DELAY = 30000;  // 30s cap
const RECONNECT_MAX_ATTEMPTS = 5;

class ConnectionManager extends EventEmitter {
  constructor(directTransport, obfuscatedTransport, store, firewall) {
    super();
    this._direct = directTransport;
    this._obfuscated = obfuscatedTransport;
    this._store = store;
    this._firewall = firewall || null;
    this._active = null; // currently active transport
    this._connecting = false;
    this._aborted = false;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._reconnectInFlight = false; // guards against double-timer race
    this._vpnServerIp = null;
    // Kill switch UI state — single source of truth, emitted to renderer
    this._killSwitchState = { active: false, error: null, lastChangeAt: null };
  }

  // Snapshot of kill switch state for IPC consumers
  getKillSwitchState() {
    return Object.assign({}, this._killSwitchState);
  }

  _setKillSwitchState(patch) {
    this._killSwitchState = Object.assign({}, this._killSwitchState, patch, {
      lastChangeAt: new Date().toISOString(),
    });
    this.emit("kill-switch:state", this.getKillSwitchState());
  }

  get isConnected() {
    return this._active !== null && this._active.isRunning;
  }

  get activeMode() {
    return this._active ? this._active.name : null;
  }

  get isReconnecting() {
    return this._reconnecting;
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
    this._cancelReconnect();

    if (this._active) {
      const transport = this._active;
      this._active = null;
      await transport.stop();
    }

    // Deactivate kill switch on intentional disconnect
    await this._deactivateFirewall();
  }

  // Emergency rollback — force-stop everything
  async emergencyStop() {
    this._cancelReconnect();
    try { await this._direct.stop(); } catch {}
    try { await this._obfuscated.stop(); } catch {}
    this._active = null;
    await this._deactivateFirewall();
  }

  // ── Kill Switch ────────────────────────────────

  async _activateFirewall() {
    if (!this._firewall || !this._vpnServerIp) return;
    const killSwitchEnabled = this._store.get("killSwitch", true);
    if (!killSwitchEnabled) {
      this._setKillSwitchState({ active: false, error: null });
      return;
    }

    try {
      await this._firewall.activate(this._vpnServerIp);
      this._setKillSwitchState({ active: true, error: null });
    } catch (e) {
      console.error("Kill switch activation failed:", e.message);
      this.emit("warning", `Kill switch unavailable: ${e.message}`);
      this._setKillSwitchState({ active: false, error: e.message });
    }
  }

  async _deactivateFirewall() {
    if (!this._firewall || !this._firewall.isActive) {
      // Already off — ensure state reflects reality
      if (this._killSwitchState.active) {
        this._setKillSwitchState({ active: false, error: null });
      }
      return;
    }

    try {
      await this._firewall.deactivate();
      this._setKillSwitchState({ active: false, error: null });
    } catch (e) {
      console.error("Kill switch deactivation failed:", e.message);
      this._setKillSwitchState({ active: this._firewall.isActive, error: e.message });
    }
  }

  // Panic-off — explicit user request to drop kill switch regardless of VPN state.
  // Returns { success, error? }. Does NOT disconnect the VPN; if the tunnel is
  // still alive, traffic continues over it.
  async deactivateKillSwitch() {
    if (!this._firewall) return { success: false, error: "Kill switch not available on this platform" };
    if (!this._killSwitchState.active && !this._firewall.isActive) {
      return { success: true };
    }
    try {
      await this._firewall.deactivate();
      this._setKillSwitchState({ active: false, error: null });
      return { success: true };
    } catch (e) {
      this._setKillSwitchState({ active: this._firewall.isActive, error: e.message });
      return { success: false, error: e.message };
    }
  }

  // ── Auto-Reconnect ─────────────────────────────

  _scheduleReconnect() {
    if (this._aborted || this._reconnecting || this._reconnectInFlight) return;
    if (this._reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      console.log(`Auto-reconnect: max attempts (${RECONNECT_MAX_ATTEMPTS}) reached — giving up`);
      this._reconnecting = false;
      this._reconnectAttempt = 0;
      this.emit("reconnect-failed");
      // Deactivate kill switch since we can't reconnect
      this._deactivateFirewall().catch(() => {});
      return;
    }

    this._reconnecting = true;
    this._reconnectAttempt++;
    // Exponential backoff with jitter: delay * 2^attempt + random(0-500ms)
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this._reconnectAttempt - 1),
      RECONNECT_MAX_DELAY
    ) + Math.random() * 500;

    console.log(`Auto-reconnect: attempt ${this._reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay)}ms`);
    this.emit("reconnecting", { attempt: this._reconnectAttempt, maxAttempts: RECONNECT_MAX_ATTEMPTS, delay });

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      this._reconnectInFlight = true; // prevent _scheduleReconnect re-entry during connect()
      if (this._aborted) {
        this._reconnecting = false;
        this._reconnectInFlight = false;
        return;
      }

      try {
        await this.connect();
        this._reconnectInFlight = false;
        if (this.isConnected) {
          console.log(`Auto-reconnect: succeeded on attempt ${this._reconnectAttempt}`);
          this._reconnecting = false;
          this._reconnectAttempt = 0;
          this.emit("reconnected");
        } else {
          this._reconnecting = false;
          this._scheduleReconnect();
        }
      } catch (e) {
        this._reconnectInFlight = false;
        console.log(`Auto-reconnect: attempt ${this._reconnectAttempt} failed: ${e.message}`);
        this._reconnecting = false;
        this._scheduleReconnect();
      }
    }, delay);
  }

  _cancelReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reconnectInFlight = false;
  }

  // ── Transport Management ──────────────────────

  async _startTransport(transport) {
    // Wire up events
    const onError = (err) => this.emit("error", err);
    const onDisconnected = () => {
      this._active = null;
      transport.removeListener("error", onError);
      transport.removeListener("disconnected", onDisconnected);

      // If not intentionally aborted, attempt auto-reconnect
      // Keep kill switch active during reconnect to prevent leaks
      if (!this._aborted) {
        this.emit("disconnected");
        this._scheduleReconnect();
      } else {
        this.emit("disconnected");
      }
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

      // Extract VPN server IP for kill switch
      this._vpnServerIp = this._extractVpnServerIp();

      // Activate kill switch after successful connection
      await this._activateFirewall();

      // Reset reconnect counter on successful connect
      this._reconnectAttempt = 0;
      this._reconnecting = false;

      this.emit("connected", { mode: transport.name });
    } catch (e) {
      transport.removeListener("error", onError);
      transport.removeListener("disconnected", onDisconnected);
      throw e;
    }
  }

  _extractVpnServerIp() {
    const accessUrl = this._store.get("license.vpnAccessUrl") || "";
    const match = accessUrl.match(/@([^:]+):/);
    return match ? match[1] : null;
  }

  async _getNetworkCacheKey() {
    try {
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
