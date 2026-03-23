const net = require("net");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const Tunnel = require("./tunnel");
const Routes = require("./routes");
const Dns = require("./dns");
const Monitor = require("./monitor");
const { elevatedExec } = require("./elevation");

// Shadowsocks AEAD client — local SOCKS5 proxy tunneling through Outline VPS
// Implements chacha20-ietf-poly1305 and aes-256-gcm AEAD ciphers

const SOCKS_PORT = 1080;
const SOCKS_HOST = "127.0.0.1";

// AEAD cipher specs — maps Shadowsocks names to Node.js crypto names
const CIPHER_INFO = {
  "chacha20-ietf-poly1305": { keyLen: 32, saltLen: 32, nonceLen: 12, tagLen: 16, cipher: "chacha20-poly1305" },
  "aes-256-gcm": { keyLen: 32, saltLen: 32, nonceLen: 12, tagLen: 16, cipher: "aes-256-gcm" },
  "aes-128-gcm": { keyLen: 16, saltLen: 16, nonceLen: 12, tagLen: 16, cipher: "aes-128-gcm" },
};

// Preferred cipher → fallback chain (same key size so they're interchangeable)
const CIPHER_FALLBACK = {
  "chacha20-poly1305": "aes-256-gcm",
};

// Actually test that a cipher works (getCiphers() can lie on some Electron/BoringSSL builds)
function testCipher(nodeCipherName, keyLen, nonceLen, tagLen) {
  try {
    const c = crypto.createCipheriv(nodeCipherName, Buffer.alloc(keyLen), Buffer.alloc(nonceLen), { authTagLength: tagLen });
    c.update(Buffer.alloc(1));
    c.final();
    c.getAuthTag();
    return true;
  } catch {
    return false;
  }
}

// Resolve a working cipher — try the requested one, fall back if needed
function resolveCipher(info) {
  if (testCipher(info.cipher, info.keyLen, info.nonceLen, info.tagLen)) {
    return info.cipher;
  }
  const fallback = CIPHER_FALLBACK[info.cipher];
  if (fallback) {
    const fbInfo = Object.values(CIPHER_INFO).find(c => c.cipher === fallback);
    if (fbInfo && fbInfo.keyLen === info.keyLen && testCipher(fallback, fbInfo.keyLen, fbInfo.nonceLen, fbInfo.tagLen)) {
      console.log(`Cipher ${info.cipher} unavailable, falling back to ${fallback}`);
      return fallback;
    }
  }
  throw new Error(`No supported cipher available (tried ${info.cipher}${fallback ? ', ' + fallback : ''}) — update the app or OS`);
}

// Derive key from password using EVP_BytesToKey (Shadowsocks standard)
function evpBytesToKey(password, keyLen) {
  const passBuf = Buffer.from(password);
  const parts = [];
  let prev = Buffer.alloc(0);
  while (Buffer.concat(parts).length < keyLen) {
    prev = crypto.createHash("md5").update(Buffer.concat([prev, passBuf])).digest();
    parts.push(prev);
  }
  return Buffer.concat(parts).slice(0, keyLen);
}

// HKDF-SHA1 subkey derivation (Shadowsocks AEAD spec)
// Shadowsocks HKDF-SHA1: uses salt as HMAC key (matches Shadowsocks/Outline convention,
// differs from RFC 5869 which uses salt as HMAC key and IKM as data — same result here)
function hkdfSha1(key, salt, info, length) {
  // Extract
  const prk = crypto.createHmac("sha1", salt).update(key).digest();
  // Expand
  let prev = Buffer.alloc(0);
  const output = [];
  for (let i = 1; Buffer.concat(output).length < length; i++) {
    prev = crypto.createHmac("sha1", prk)
      .update(Buffer.concat([prev, Buffer.from(info), Buffer.from([i])]))
      .digest();
    output.push(prev);
  }
  return Buffer.concat(output).slice(0, length);
}

// Increment a little-endian nonce buffer
function incrementNonce(nonce) {
  for (let i = 0; i < nonce.length; i++) {
    nonce[i]++;
    if (nonce[i] !== 0) break;
  }
}

// AEAD encrypt a single chunk: [encrypted_payload_length (2 bytes)][length_tag][encrypted_payload][payload_tag]
function aeadEncrypt(subkey, nonce, plaintext, cipherName, tagLen) {
  // Encrypt the 2-byte length
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(plaintext.length);
  const lenCipher = crypto.createCipheriv(cipherName, subkey, nonce, { authTagLength: tagLen });
  const encLen = Buffer.concat([lenCipher.update(lenBuf), lenCipher.final(), lenCipher.getAuthTag()]);
  incrementNonce(nonce);

  // Encrypt the payload
  const payloadCipher = crypto.createCipheriv(cipherName, subkey, nonce, { authTagLength: tagLen });
  const encPayload = Buffer.concat([payloadCipher.update(plaintext), payloadCipher.final(), payloadCipher.getAuthTag()]);
  incrementNonce(nonce);

  return Buffer.concat([encLen, encPayload]);
}

// AEAD decryptor state machine — handles streaming decryption of Shadowsocks chunks
class AeadDecryptor {
  constructor(subkey, cipherName, tagLen) {
    this._subkey = subkey;
    this._cipherName = cipherName;
    this._tagLen = tagLen;
    this._nonce = Buffer.alloc(12);
    this._buffer = Buffer.alloc(0);
    this._waitingForPayload = false;
    this._payloadLen = 0;
    this._failed = false;
  }

  // Feed encrypted data, returns array of decrypted plaintext chunks
  update(data) {
    if (this._failed) return [];
    this._buffer = Buffer.concat([this._buffer, data]);
    const chunks = [];

    while (true) {
      if (!this._waitingForPayload) {
        // Need 2 + tagLen bytes for the encrypted length
        const lenChunkSize = 2 + this._tagLen;
        if (this._buffer.length < lenChunkSize) break;

        const encLenBuf = this._buffer.slice(0, lenChunkSize);
        this._buffer = this._buffer.slice(lenChunkSize);

        try {
          const decipher = crypto.createDecipheriv(this._cipherName, this._subkey, this._nonce, { authTagLength: this._tagLen });
          decipher.setAuthTag(encLenBuf.slice(2, 2 + this._tagLen));
          const lenBuf = Buffer.concat([decipher.update(encLenBuf.slice(0, 2)), decipher.final()]);
          this._payloadLen = lenBuf.readUInt16BE(0);
          incrementNonce(this._nonce);
          this._waitingForPayload = true;
        } catch {
          // Decryption failed — mark as failed to prevent processing garbage data
          this._failed = true;
          return chunks;
        }
      }

      if (this._waitingForPayload) {
        const payloadChunkSize = this._payloadLen + this._tagLen;
        if (this._buffer.length < payloadChunkSize) break;

        const encPayloadBuf = this._buffer.slice(0, payloadChunkSize);
        this._buffer = this._buffer.slice(payloadChunkSize);

        try {
          const decipher = crypto.createDecipheriv(this._cipherName, this._subkey, this._nonce, { authTagLength: this._tagLen });
          decipher.setAuthTag(encPayloadBuf.slice(this._payloadLen, this._payloadLen + this._tagLen));
          const payload = Buffer.concat([decipher.update(encPayloadBuf.slice(0, this._payloadLen)), decipher.final()]);
          incrementNonce(this._nonce);
          chunks.push(payload);
          this._waitingForPayload = false;
        } catch {
          this._failed = true;
          return chunks;
        }
      }
    }

    return chunks;
  }
}

class VpnManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this._server = null;
    this._state = "disconnected"; // disconnected | connecting | connected | disconnecting | error
    this._licenseValid = true;
    this._remoteHost = null;
    this._remotePort = null;
    this._password = null;
    this._method = null;
    this._masterKey = null;
    this._cipherInfo = null;
    this._sockets = new Set();
    this._tunnelFailures = 0;
    this._tunnelHealthInterval = null;
    this._tunnel = new Tunnel();
    this._routes = new Routes();
    this._dns = new Dns();
    this._monitor = null;
  }

  get isConnected() {
    return this._state === "connected";
  }

  get state() {
    return this._state;
  }

  getServerHost() {
    return this._remoteHost || null;
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

    if (!CIPHER_INFO[method]) {
      throw new Error(`Unsupported cipher: ${method}`);
    }

    return { method, password, host, port };
  }

  // Start local SOCKS5 proxy and set system proxy
  async connect() {
    if (this._state !== "disconnected" && this._state !== "error") return;
    this._state = "connecting";

    // 15-second guard for entire connect flow
    let connectTimeoutId;
    const connectTimeout = new Promise((_, reject) => {
      connectTimeoutId = setTimeout(() => reject(new Error("Connection timed out — could not establish VPN")), 15000);
    });

    try {
      await Promise.race([this._connectInner(), connectTimeout]);
    } catch (e) {
      await this._rollback();
      throw e;
    } finally {
      clearTimeout(connectTimeoutId);
      if (this._state === "connecting") this._state = "disconnected";
    }

    // Check if license was invalidated during connect (#26)
    if (this._licenseValid === false) {
      await this._rollback();
      throw new Error("License expired during connection");
    }

    // Server errored during setup — disconnect already called, clean up proxy
    if (!this._server) {
      await this._rollback();
      return;
    }

    this._state = "connected";  // Set AFTER license check passes
    this._tunnelFailures = 0;

    // Start watchdog monitor
    this._monitor = new Monitor(this._tunnel, this._routes, this._dns, Tunnel.TUN_GW);
    this._monitor.on("emergency", (reason) => {
      console.error("Watchdog emergency disconnect:", reason);
      this.emit("error", new Error(reason));
      this.disconnect().catch(() => {});
    });
    this._monitor.start();

    // Listen for tun2socks process death
    this._tunnel.on("died", (err) => {
      console.error("tun2socks died:", err.message);
      this.emit("error", new Error("VPN tunnel process died — disconnected to restore internet"));
      this.disconnect().catch(() => {});
    });

    this.emit("connected");
  }

  async _connectInner() {
    const accessUrl = this.store.get("license.vpnAccessUrl");
    if (!accessUrl) throw new Error("No VPN access key configured");

    let config;
    try {
      config = this._parseAccessUrl(accessUrl);
    } catch (e) {
      throw new Error("Invalid VPN configuration");  // Don't include e.message (may contain credentials)
    }

    this._remoteHost = config.host;
    this._remotePort = config.port;
    this._password = config.password;
    this._method = config.method;
    this._cipherInfo = { ...CIPHER_INFO[config.method] };
    this._cipherInfo.cipher = resolveCipher(this._cipherInfo);
    this._masterKey = evpBytesToKey(config.password, this._cipherInfo.keyLen);

    // Step 1: Elevate privileges (fail early if user cancels)
    await elevatedExec("echo vizoguard-vpn-auth");

    // Step 2: Start SOCKS5 proxy
    await this._startSocksProxy();

    // Step 3: Verify Shadowsocks tunnel works
    await this._verifyTunnel();

    // Step 4: Start tun2socks → creates TUN interface
    await this._tunnel.start(SOCKS_PORT);

    // Step 5: Save originals and switch routes to TUN (before DNS to prevent leaks)
    await this._routes.save();
    await this._dns.save();
    await this._routes.apply(Tunnel.TUN_GW, this._remoteHost);

    // Step 6: Set DNS (after routes — prevents DNS leak outside tunnel)
    await this._dns.apply();
  }

  // Single rollback — reverse of connect: DNS first, then routes, then kill tunnel, then stop SOCKS
  // Routes restored BEFORE killing tun2socks (otherwise default route points to dead TUN)
  async _rollback() {
    // 1. Stop watchdog
    if (this._monitor) {
      this._monitor.stop();
      this._monitor.removeAllListeners();
      this._monitor = null;
    }
    this._stopTunnelHealthCheck();
    this._tunnel.removeAllListeners();

    // 2. Restore DNS (reverse of connect step 6)
    try { await this._dns.restore(); } catch (e) { console.error("Rollback DNS:", e.message); }

    // 3. Restore routes (reverse of connect step 5, BEFORE killing tun2socks)
    try { await this._routes.restore(); } catch (e) { console.error("Rollback routes:", e.message); }

    // 4. Kill tun2socks
    this._tunnel.stop();

    // 5. Destroy SOCKS sockets and server
    if (this._sockets) {
      this._sockets.forEach(s => s.destroy());
      this._sockets.clear();
    }
    if (this._server) {
      const srv = this._server;
      this._server = null;
      await new Promise(resolve => {
        const t = setTimeout(resolve, 3000);
        srv.close(() => { clearTimeout(t); resolve(); });
      });
    }

    // 6. Clear credentials
    this._remoteHost = null;
    this._remotePort = null;
    this._password = null;
    this._masterKey = null;
    this._cipherInfo = null;
    this._method = null;
  }

  async disconnect() {
    const wasState = this._state;
    if (wasState === "disconnected" || wasState === "disconnecting") return;
    this._state = "disconnecting";

    await this._rollback();
    this._state = "disconnected";

    if (wasState === "connected") this.emit("disconnected");
  }

  // Kill switch — detect dead tunnel and auto-disconnect to restore internet
  _startTunnelHealthCheck() {
    this._stopTunnelHealthCheck();
    this._tunnelFailures = 0;

    this._tunnelHealthInterval = setInterval(() => {
      if (this._state !== "connected") return;

      // Probe: TCP connect to VPN server (lightweight, no AEAD)
      const probe = net.createConnection(this._remotePort, this._remoteHost);
      const timer = setTimeout(() => {
        probe.destroy();
        this._onTunnelProbeFailure();
      }, 5000);

      probe.on("connect", () => {
        clearTimeout(timer);
        probe.destroy();
        this._tunnelFailures = 0; // reset on success
      });

      probe.on("error", () => {
        clearTimeout(timer);
        probe.destroy();
        this._onTunnelProbeFailure();
      });
    }, 30000); // check every 30s
  }

  _stopTunnelHealthCheck() {
    if (this._tunnelHealthInterval) {
      clearInterval(this._tunnelHealthInterval);
      this._tunnelHealthInterval = null;
    }
  }

  _onTunnelProbeFailure() {
    this._tunnelFailures++;
    console.error(`Tunnel health check failed (${this._tunnelFailures}/3)`);
    if (this._tunnelFailures >= 3) {
      // 3 consecutive failures = tunnel is dead, kill switch
      console.error("Tunnel dead — disconnecting to restore internet");
      this.emit("error", new Error("VPN tunnel lost — disconnected to restore internet"));
      this.disconnect().catch(() => {});
    }
  }

  // SOCKS5 proxy that tunnels connections through Shadowsocks
  _startSocksProxy() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((clientSocket) => {
        this._handleSocksConnection(clientSocket);
      });

      this._server.on("error", (err) => {
        console.error("SOCKS proxy error:", err.message);
        if (this._state === "connected") {
          // Post-connect error: emit and disconnect (kill switch)
          this.emit("error", err);
          this.disconnect().catch(() => {});
        } else if (this._state === "connecting") {
          // During setup: reject the startup promise
          reject(err);
        }
      });

      this._server.listen(SOCKS_PORT, SOCKS_HOST, () => {
        console.log(`SOCKS5 proxy listening on ${SOCKS_HOST}:${SOCKS_PORT}`);
        resolve();
      });
    });
  }

  _handleSocksConnection(client) {
    // Track socket for clean shutdown
    this._sockets.add(client);
    client.on('close', () => this._sockets.delete(client));
    client.on('error', () => client.destroy());

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
          const groups = [];
          for (let i = 4; i < 20; i += 2) {
            groups.push(((request[i] << 8) | request[i + 1]).toString(16));
          }
          destHost = groups.join(':');
          destPort = request.readUInt16BE(20);
        } else {
          client.end();
          return;
        }

        // Pause client to avoid dropping data between handshake and tunnel setup
        client.pause();

        // Connect through the Shadowsocks server
        this._tunnelConnection(client, destHost, destPort);
      });
    });
  }

  _tunnelConnection(client, destHost, destPort) {
    const info = this._cipherInfo;
    if (!info) { client.end(); return; }

    // Generate random salt for this connection
    const salt = crypto.randomBytes(info.saltLen);

    // Derive subkey: HKDF-SHA1(master_key, salt, "ss-subkey", key_length)
    const subkey = hkdfSha1(this._masterKey, salt, "ss-subkey", info.keyLen);
    const encNonce = Buffer.alloc(info.nonceLen);

    // Connect to the Shadowsocks server
    const remote = net.createConnection(this._remotePort, this._remoteHost);
    this._sockets.add(remote);
    remote.on('close', () => this._sockets.delete(remote));

    // Register client data handler immediately (before remote connects) to capture buffered data
    client.on("data", (chunk) => {
      try {
        // Split into max 0x3FFF byte chunks per Shadowsocks spec
        let offset = 0;
        while (offset < chunk.length) {
          const size = Math.min(chunk.length - offset, 0x3FFF);
          const encrypted = aeadEncrypt(subkey, encNonce, chunk.slice(offset, offset + size), info.cipher, info.tagLen);
          remote.write(encrypted);
          offset += size;
        }
      } catch (e) {
        console.error("Encrypt error:", e.message);
        remote.destroy();
        client.end();
      }
    });

    remote.on('connect', () => {
      try {
        // Build Shadowsocks address header
        const addrHeader = this._buildAddressHeader(destHost, destPort);

        // Send salt + encrypted address header as the first message
        const encryptedHeader = aeadEncrypt(subkey, encNonce, addrHeader, info.cipher, info.tagLen);
        remote.write(Buffer.concat([salt, encryptedHeader]));
      } catch (e) {
        console.error("Tunnel setup error:", e.message);
        remote.destroy();
        client.end();
        return;
      }

      // Send SOCKS5 success response
      const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
      client.write(reply);

      // Resume client now that data handler is registered
      client.resume();

      // Decrypt remote -> client
      // Derive server's subkey from server salt (first saltLen bytes of response)
      let serverSaltReceived = false;
      let serverDecryptor = null;
      let initialBuffer = Buffer.alloc(0);

      remote.on("data", (chunk) => {
        try {
          if (!serverSaltReceived) {
            initialBuffer = Buffer.concat([initialBuffer, chunk]);
            if (initialBuffer.length < info.saltLen) return;

            const serverSalt = initialBuffer.slice(0, info.saltLen);
            const remaining = initialBuffer.slice(info.saltLen);
            const serverSubkey = hkdfSha1(this._masterKey, serverSalt, "ss-subkey", info.keyLen);
            serverDecryptor = new AeadDecryptor(serverSubkey, info.cipher, info.tagLen);
            serverSaltReceived = true;

            if (remaining.length > 0) {
              const decrypted = serverDecryptor.update(remaining);
              for (const buf of decrypted) client.write(buf);
            }
          } else {
            const decrypted = serverDecryptor.update(chunk);
            for (const buf of decrypted) client.write(buf);
          }
        } catch (e) {
          console.error("Decrypt error:", e.message);
          remote.destroy();
          client.end();
        }
      });
    });

    remote.on("error", (err) => {
      console.error("Tunnel error:", err.message);
      this._tunnelFailures++;
      remote.destroy();
      client.end();
    });

    client.on("error", () => remote.end());
    client.on("close", () => remote.end());
    remote.on("close", () => client.end());
  }

  // Verify VPN server is reachable and Shadowsocks handshake succeeds before setting system proxy
  _verifyTunnel() {
    return new Promise((resolve, reject) => {
      let dataTimeout = null;

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("VPN server unreachable — connection timed out"));
      }, 8000);

      const sock = net.createConnection(this._remotePort, this._remoteHost);
      this._sockets.add(sock);

      const cleanup = () => {
        this._sockets.delete(sock);
        clearTimeout(timeout);
        if (dataTimeout) clearTimeout(dataTimeout);
        sock.destroy();
      };

      sock.on("connect", () => {
        // TCP connect succeeded — verify Shadowsocks handshake by sending
        // an address header + HTTP request to 1.1.1.1:80 through the tunnel.
        // The server only responds after the target sends data back, so we must
        // send actual payload (not just the address header).
        try {
          const info = this._cipherInfo;
          const salt = crypto.randomBytes(info.saltLen);
          const subkey = hkdfSha1(this._masterKey, salt, "ss-subkey", info.keyLen);
          const nonce = Buffer.alloc(info.nonceLen);

          // Send address header (1.1.1.1:80)
          const addrHeader = this._buildAddressHeader("1.1.1.1", 80);
          const encHeader = aeadEncrypt(subkey, nonce, addrHeader, info.cipher, info.tagLen);
          sock.write(Buffer.concat([salt, encHeader]));

          // Send HTTP request so the target responds and the server relays data back
          const httpReq = Buffer.from("GET / HTTP/1.0\r\nHost: 1.1.1.1\r\n\r\n");
          const encPayload = aeadEncrypt(subkey, nonce, httpReq, info.cipher, info.tagLen);
          sock.write(encPayload);
        } catch (e) {
          cleanup();
          reject(new Error(`Cipher error: ${e.message}`));
          return;
        }

        // If server responds (even a few bytes), tunnel works
        dataTimeout = setTimeout(() => {
          cleanup();
          reject(new Error("VPN server did not respond — check credentials or server status"));
        }, 5000);

        sock.once("data", () => {
          cleanup();
          resolve();
        });
      });

      sock.on("error", (err) => {
        cleanup();
        const msg = err.code === "ECONNREFUSED"
          ? "VPN server refused connection"
          : err.code === "ETIMEDOUT"
          ? "VPN server unreachable — connection timed out"
          : `VPN server error: ${err.code || err.message}`;
        reject(new Error(msg));
      });
    });
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
      header = Buffer.alloc(19);
      header[0] = 0x04; // IPv6
      // Expand compressed IPv6 (e.g., ::1 → 0:0:0:0:0:0:0:1)
      const full = host.includes('::') ? (() => {
        const [left, right] = host.split('::');
        const l = left ? left.split(':') : [];
        const r = right ? right.split(':') : [];
        const fill = Array(8 - l.length - r.length).fill('0');
        return [...l, ...fill, ...r];
      })() : host.split(':');
      for (let i = 0; i < 8; i++) {
        header.writeUInt16BE(parseInt(full[i] || '0', 16), 1 + i * 2);
      }
      header.writeUInt16BE(port, 17);
    } else {
      const domainBuf = Buffer.from(host);
      if (domainBuf.length > 255) throw new Error('Domain name too long for SOCKS5');
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
