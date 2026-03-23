const net = require("net");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { EventEmitter } = require("events");

const CHECK_INTERVAL = 2000; // 2 seconds

class Monitor extends EventEmitter {
  constructor(tunnel, routes, dns, tunGateway) {
    super();
    this._tunnel = tunnel;
    this._routes = routes;
    this._dns = dns;
    this._tunGateway = tunGateway;
    this._interval = null;
    this._running = false;
    this._consecutiveFailures = 0;
    this._savedGateway = routes.originalGateway;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._consecutiveFailures = 0;

    this._interval = setInterval(() => this._check(), CHECK_INTERVAL);
    console.log("VPN watchdog started");
  }

  stop() {
    this._running = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    console.log("VPN watchdog stopped");
  }

  async _check() {
    if (!this._running) return;

    // 1. Check tun2socks process
    if (!this._tunnel.isAlive()) {
      console.error("Watchdog: tun2socks process died");
      this.emit("emergency", "VPN tunnel process died");
      return;
    }

    // 2. Check SOCKS proxy is responding
    const socksOk = await this._probeSocks();
    if (!socksOk) {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= 3) {
        console.error("Watchdog: SOCKS proxy unresponsive (3 consecutive failures)");
        this.emit("emergency", "VPN proxy stopped responding");
        return;
      }
    } else {
      this._consecutiveFailures = 0;
    }

    // 3. Check routes
    const routesOk = await this._routes.isIntact(this._tunGateway);
    if (!routesOk) {
      console.error("Watchdog: default route changed — TUN route missing");
      this.emit("emergency", "VPN route was removed");
      return;
    }

    // 4. Check DNS (self-healing — reapply if drifted)
    const dnsOk = await this._dns.isIntact();
    if (!dnsOk && this._dns.isApplied) {
      console.warn("Watchdog: DNS drifted, reapplying");
      try {
        await this._dns.apply();
      } catch (e) {
        console.error("Watchdog: DNS reapply failed:", e.message);
      }
    }

    // 5. Check for network change (WiFi switch, cable plug/unplug)
    if (this._savedGateway) {
      const currentGw = await this._getCurrentGateway();
      if (currentGw && currentGw !== this._savedGateway && currentGw !== this._tunGateway) {
        console.error(`Watchdog: network changed (gateway ${this._savedGateway} → ${currentGw})`);
        this.emit("emergency", "Network changed — VPN disconnected");
        return;
      }
    }
  }

  // Detect current physical gateway (ignoring TUN gateway)
  async _getCurrentGateway() {
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("/sbin/route", ["-n", "get", "default"]);
        const match = stdout.match(/gateway:\s*(\S+)/);
        return match ? match[1] : null;
      } else {
        const { stdout } = await execFileAsync("route", ["print", "0.0.0.0"]);
        const lines = stdout.split("\n");
        // Find the non-TUN default route (highest metric = original)
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts[0] === "0.0.0.0" && parts[1] === "0.0.0.0" && parts[2] !== this._tunGateway) {
            return parts[2];
          }
        }
        return null;
      }
    } catch {
      return null;
    }
  }

  // Quick TCP probe to SOCKS port
  _probeSocks() {
    return new Promise((resolve) => {
      const sock = net.createConnection(1080, "127.0.0.1");
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 1500);

      sock.on("connect", () => {
        clearTimeout(timer);
        sock.destroy();
        resolve(true);
      });

      sock.on("error", () => {
        clearTimeout(timer);
        sock.destroy();
        resolve(false);
      });
    });
  }
}

module.exports = Monitor;
