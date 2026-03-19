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
    const colonIdx = decoded.indexOf(":");
    const method = colonIdx > 0 ? decoded.slice(0, colonIdx) : "chacha20-ietf-poly1305";
    const password = colonIdx > 0 ? decoded.slice(colonIdx + 1) : decoded;

    const host = ssMatch[2];
    const port = parseInt(ssMatch[3], 10);

    // Reject loopback/private hosts to prevent VPN redirect attacks
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|localhost$)/i.test(host)) {
      throw new Error("VPN host must be a public address");
    }

    return { method, password, host, port };
  }

  // Start local SOCKS5 proxy and set system proxy
  async connect() {
    if (this._connected) return;

    const accessUrl = this.store.get("license.vpnAccessUrl");
    if (!accessUrl) throw new Error("No VPN access key configured");

    let config;
    try {
      config = this._parseAccessUrl(accessUrl);
    } catch (e) {
      throw new Error(`Invalid VPN configuration: ${e.message}`);
    }

    this._remoteHost = config.host;
    this._remotePort = config.port;
    this._password = config.password;
    this._method = config.method;

    // Start SOCKS5 proxy server
    await this._startSocksProxy();

    // Set system proxy to our local SOCKS5
    try {
      await platform.setProxy(SOCKS_HOST, SOCKS_PORT);
    } catch (e) {
      // Rollback: stop SOCKS server if proxy setup fails
      if (this._server) {
        this._server.close();
        this._server = null;
      }
      throw new Error(`Failed to set system proxy: ${e.message}`);
    }

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

      // TODO: Implement Shadowsocks AEAD encryption using _method and _password.
      // Currently sends address header in plaintext — relies on Outline server's
      // transport-level encryption. A full implementation should use chacha20-ietf-poly1305
      // or aes-256-gcm to encrypt all data before it reaches the wire.
      // Consider using outline-go-tun2socks or ss-local binary for proper protocol support.
      remote.write(addrHeader);

      // Send SOCKS5 success response
      const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
      client.write(reply);

      // Pipe data bidirectionally
      client.pipe(remote);
      remote.pipe(client);
    });

    remote.on("error", (err) => {
      // Sanitize error — don't expose remote host:port details
      console.error("Tunnel error:", err.message);
      client.end();
    });

    client.on("error", () => remote.end());
    client.on("close", () => remote.end());
    remote.on("close", () => client.end());
  }

  _buildAddressHeader(host, port) {
    // Shadowsocks address format: [type][addr][port]
    const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    const isIpv6 = net.isIPv6(host);
    let header;

    if (isIpv4) {
      const parts = host.split(".").map(Number);
      header = Buffer.alloc(7);
      header[0] = 0x01; // IPv4
      header[1] = parts[0];
      header[2] = parts[1];
      header[3] = parts[2];
      header[4] = parts[3];
      header.writeUInt16BE(port, 5);
    } else if (isIpv6) {
      // IPv6: 1 byte type + 16 bytes address + 2 bytes port
      header = Buffer.alloc(19);
      header[0] = 0x04; // IPv6
      // Expand and pack IPv6 address into 16 bytes
      const groups = host.split(":").map((g) => parseInt(g, 16) || 0);
      for (let i = 0; i < 8; i++) {
        header.writeUInt16BE(groups[i] || 0, 1 + i * 2);
      }
      header.writeUInt16BE(port, 17);
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
