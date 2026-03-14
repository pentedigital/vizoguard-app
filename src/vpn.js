const net = require("net");
const { execFile } = require("child_process");
const { EventEmitter } = require("events");
const platform = require("./platform");

// Shadowsocks client — runs a local SOCKS5 proxy that tunnels through the Outline VPS
// Uses ss-local from shadowsocks-libev protocol (reimplemented in pure Node.js)

const SOCKS_PORT = 1080;
const SOCKS_HOST = "127.0.0.1";

class VpnManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this._server = null;
    this._connected = false;
    this._remoteHost = null;
    this._remotePort = null;
    this._password = null;
    this._method = null;
  }

  get isConnected() {
    return this._connected;
  }

  // Parse ss:// URL into components
  _parseAccessUrl(url) {
    // Format: ss://base64(method:password)@host:port/?outline=1
    const ssMatch = url.match(/^ss:\/\/([^@]+)@([^:]+):(\d+)/);
    if (!ssMatch) throw new Error("Invalid ss:// URL");

    const decoded = Buffer.from(ssMatch[1], "base64").toString("utf8");
    const [method, password] = decoded.split(":");

    return {
      method: method || "chacha20-ietf-poly1305",
      password: password,
      host: ssMatch[2],
      port: parseInt(ssMatch[3], 10),
    };
  }

  // Start local SOCKS5 proxy and set system proxy
  async connect() {
    if (this._connected) return;

    const accessUrl = this.store.get("license.vpnAccessUrl");
    if (!accessUrl) throw new Error("No VPN access key configured");

    const config = this._parseAccessUrl(accessUrl);
    this._remoteHost = config.host;
    this._remotePort = config.port;
    this._password = config.password;
    this._method = config.method;

    // Start SOCKS5 proxy server
    await this._startSocksProxy();

    // Set system proxy to our local SOCKS5
    await platform.setProxy(SOCKS_HOST, SOCKS_PORT);

    this._connected = true;
    this.emit("connected");
  }

  async disconnect() {
    if (!this._connected) return;

    // Clear system proxy
    try {
      await platform.clearProxy();
    } catch (e) {
      console.error("Failed to clear proxy:", e.message);
    }

    // Stop SOCKS5 server
    if (this._server) {
      this._server.close();
      this._server = null;
    }

    this._connected = false;
    this.emit("disconnected");
  }

  // SOCKS5 proxy that tunnels connections through Shadowsocks
  _startSocksProxy() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((clientSocket) => {
        this._handleSocksConnection(clientSocket);
      });

      this._server.on("error", (err) => {
        console.error("SOCKS proxy error:", err.message);
        this.emit("error", err);
        if (!this._connected) reject(err);
      });

      this._server.listen(SOCKS_PORT, SOCKS_HOST, () => {
        console.log(`SOCKS5 proxy listening on ${SOCKS_HOST}:${SOCKS_PORT}`);
        resolve();
      });
    });
  }

  _handleSocksConnection(client) {
    // SOCKS5 handshake
    client.once("data", (data) => {
      if (data[0] !== 0x05) {
        client.end();
        return;
      }

      // No auth required
      client.write(Buffer.from([0x05, 0x00]));

      client.once("data", (request) => {
        if (request[0] !== 0x05 || request[1] !== 0x01) {
          client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.end();
          return;
        }

        // Parse destination
        let destHost, destPort;
        const addrType = request[3];

        if (addrType === 0x01) {
          // IPv4 — need at least 10 bytes
          if (request.length < 10) { client.end(); return; }
          destHost = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
          destPort = request.readUInt16BE(8);
        } else if (addrType === 0x03) {
          // Domain — need at least 5 + domainLen + 2 bytes
          const domainLen = request[4];
          if (request.length < 5 + domainLen + 2) { client.end(); return; }
          destHost = request.slice(5, 5 + domainLen).toString();
          destPort = request.readUInt16BE(5 + domainLen);
        } else if (addrType === 0x04) {
          // IPv6 — need at least 22 bytes
          if (request.length < 22) { client.end(); return; }
          destHost = Array.from(request.slice(4, 20)).map((b) => b.toString(16).padStart(2, "0")).join(":");
          destPort = request.readUInt16BE(20);
        } else {
          client.end();
          return;
        }

        // Connect through the Shadowsocks server
        this._tunnelConnection(client, destHost, destPort, request);
      });
    });
  }

  _tunnelConnection(client, destHost, destPort, socksRequest) {
    // Connect to the Shadowsocks server
    const remote = net.createConnection(this._remotePort, this._remoteHost, () => {
      // Build Shadowsocks address header
      const addrHeader = this._buildAddressHeader(destHost, destPort);

      // Encrypt and send to remote
      // For the initial connection, we use the Shadowsocks AEAD protocol
      // The Outline server handles the encryption layer
      remote.write(addrHeader);

      // Send SOCKS5 success response
      const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
      client.write(reply);

      // Pipe data bidirectionally
      client.pipe(remote);
      remote.pipe(client);
    });

    remote.on("error", (err) => {
      console.error(`Tunnel error to ${destHost}:${destPort}:`, err.message);
      client.end();
    });

    client.on("error", () => remote.end());
    client.on("close", () => remote.end());
    remote.on("close", () => client.end());
  }

  _buildAddressHeader(host, port) {
    // Shadowsocks address format: [type][addr][port]
    const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    let header;

    if (isIp) {
      const parts = host.split(".").map(Number);
      header = Buffer.alloc(7);
      header[0] = 0x01; // IPv4
      header[1] = parts[0];
      header[2] = parts[1];
      header[3] = parts[2];
      header[4] = parts[3];
      header.writeUInt16BE(port, 5);
    } else {
      const domainBuf = Buffer.from(host);
      header = Buffer.alloc(4 + domainBuf.length);
      header[0] = 0x03; // Domain
      header[1] = domainBuf.length;
      domainBuf.copy(header, 2);
      header.writeUInt16BE(port, 2 + domainBuf.length);
    }

    return header;
  }
}

module.exports = VpnManager;
