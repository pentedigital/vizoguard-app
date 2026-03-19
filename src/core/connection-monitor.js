const { EventEmitter } = require("events");
const platform = require("../platform");

const SCAN_INTERVAL = 5000; // 5 seconds

class ConnectionMonitor extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._known = new Map(); // pid:address -> last seen
    this.activeConnections = 0;
    this.totalScanned = 0;
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

  async _scan() {
    try {
      // Cap known connections map to prevent memory growth under extreme churn
      if (this._known.size > 10000) this._known.clear();

      const connections = await platform.getConnections();
      this.activeConnections = connections.length;
      this.totalScanned++;

      // Detect new connections
      const currentKeys = new Set();
      for (const conn of connections) {
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
    } catch (e) {
      console.error("Connection scan error:", e.message);
      // Emit scan with last known data so UI doesn't stall
      this.emit("scan", {
        active: this.activeConnections,
        total: this.totalScanned,
      });
    }
  }
}

module.exports = ConnectionMonitor;
