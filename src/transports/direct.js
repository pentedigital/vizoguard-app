// Direct transport — existing SOCKS + tun2socks stack
// Used in non-censored networks for maximum speed

const { EventEmitter } = require("events");

class DirectTransport extends EventEmitter {
  constructor(vpnManager) {
    super();
    this._vpn = vpnManager;
    this._running = false;
    this._onConnected = null;
    this._onDisconnected = null;
    this._onError = null;
  }

  get isRunning() {
    return this._running;
  }

  get name() {
    return "direct";
  }

  async start() {
    // Wire up event forwarding (attached on start, removed on stop)
    this._onConnected = () => this.emit("connected");
    this._onDisconnected = () => {
      this._running = false;
      this._removeVpnListeners();
      this.emit("disconnected");
    };
    this._onError = (err) => this.emit("error", err);

    this._vpn.on("connected", this._onConnected);
    this._vpn.on("disconnected", this._onDisconnected);
    this._vpn.on("error", this._onError);

    await this._vpn.connect();
    this._running = this._vpn.isConnected;
  }

  async stop() {
    this._removeVpnListeners();
    await this._vpn.disconnect();
    this._running = false;
  }

  _removeVpnListeners() {
    if (this._onConnected) { this._vpn.removeListener("connected", this._onConnected); this._onConnected = null; }
    if (this._onDisconnected) { this._vpn.removeListener("disconnected", this._onDisconnected); this._onDisconnected = null; }
    if (this._onError) { this._vpn.removeListener("error", this._onError); this._onError = null; }
  }

  // Quick probe: can we reach the SS server directly?
  async test(timeout = 5000) {
    const net = require("net");
    const accessUrl = this._vpn.store.get("license.vpnAccessUrl") || "";
    const match = accessUrl.match(/@([^:]+):(\d+)/);
    const host = match ? match[1] : null;
    const port = match ? parseInt(match[2], 10) : 19285;

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
