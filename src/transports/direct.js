// Direct transport — existing SOCKS + tun2socks stack
// Used in non-censored networks for maximum speed

const { EventEmitter } = require("events");

class DirectTransport extends EventEmitter {
  constructor(vpnManager) {
    super();
    this._vpn = vpnManager;
    this._running = false;

    // Forward events from vpn manager
    this._vpn.on("connected", () => this.emit("connected"));
    this._vpn.on("disconnected", () => {
      this._running = false;
      this.emit("disconnected");
    });
    this._vpn.on("error", (err) => this.emit("error", err));
  }

  get isRunning() {
    return this._running;
  }

  get name() {
    return "direct";
  }

  async start() {
    await this._vpn.connect();
    this._running = this._vpn.isConnected;
  }

  async stop() {
    await this._vpn.disconnect();
    this._running = false;
  }

  // Quick probe: can we reach the SS server directly?
  async test(timeout = 5000) {
    const net = require("net");
    const host = this._vpn._remoteHost || this._vpn.store.get("license.vpnAccessUrl", "").match(/@([^:]+):/)?.[1];
    const port = this._vpn._remotePort || 19285;

    if (!host) return false;

    return new Promise((resolve) => {
      const sock = net.createConnection(port, host);
      const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeout);

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

module.exports = DirectTransport;
