const http = require("http");
const net = require("net");
const { URL } = require("url");
const { EventEmitter } = require("events");

const PROXY_PORT = 8888;
const PROXY_HOST = "127.0.0.1";

class SecurityProxy extends EventEmitter {
  constructor(threatChecker) {
    super();
    this.threatChecker = threatChecker;
    this._server = null;
    this.requestsScanned = 0;
    this.threatsBlocked = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this._sockets = new Set();
      this._server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      this._server.on("connection", (socket) => {
        this._sockets.add(socket);
        socket.on("close", () => this._sockets.delete(socket));
      });

      this._server.on("connect", (req, clientSocket, head) => {
        this._handleConnect(req, clientSocket, head);
      });

      this._server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.error(`Port ${PROXY_PORT} already in use`);
          this._server = null;
          this.emit("error", new Error(`Security proxy failed: port ${PROXY_PORT} already in use`));
          reject(err);
        } else {
          reject(err);
        }
      });

      this._server.listen(PROXY_PORT, PROXY_HOST, () => {
        console.log(`Security proxy on ${PROXY_HOST}:${PROXY_PORT}`);
        resolve();
      });
    });
  }

  stop() {
    if (this._server) {
      // Destroy active keep-alive connections so port is freed immediately
      if (this._sockets) {
        for (const s of this._sockets) s.destroy();
        this._sockets.clear();
      }
      this._server.close();
      this._server = null;
    }
  }

  async _handleRequest(req, res) {
    this.requestsScanned++;
    const url = req.url;

    try {
      const result = await this.threatChecker.checkUrl(url);

      if (result.risk === "critical" || result.risk === "high") {
        this.threatsBlocked++;
        this.emit("blocked", { url, ...result });

        res.writeHead(403, { "Content-Type": "text/html" });
        res.end(this._blockPage(url, result));
        return;
      }

      // Forward request
      const parsed = new URL(url);
      const proxyReq = http.request({
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: req.headers,
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end("Bad Gateway");
        } else {
          res.destroy();
        }
      });

      req.pipe(proxyReq);
    } catch (e) {
      console.error("Security proxy error:", e.message);
      res.writeHead(500);
      res.end("Proxy error");
    }
  }

  _handleConnect(req, clientSocket, head) {
    this.requestsScanned++;
    // Parse host:port, handling IPv6 [addr]:port format
    const ipv6Match = req.url.match(/^\[([^\]]+)\]:(\d+)$/);
    const ipv4Match = !ipv6Match && req.url.match(/^([^:]+):(\d+)$/);
    const hostname = ipv6Match ? ipv6Match[1] : (ipv4Match ? ipv4Match[1] : req.url);
    const port = parseInt(ipv6Match ? ipv6Match[2] : (ipv4Match ? ipv4Match[2] : "443")) || 443;

    // Port whitelist — only allow standard HTTP/HTTPS ports to prevent SSRF
    if (port !== 80 && port !== 443) {
      this.threatsBlocked++;
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }

    // Block loopback and private IP ranges
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|localhost$|\[::1\])/i.test(hostname)) {
      this.threatsBlocked++;
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }

    // Synchronous threat check (avoids async timing issues with CONNECT tunnels)
    const result = this.threatChecker._analyzeUrl(`https://${hostname}`);

    if (result.risk === "critical" || result.risk === "high") {
      this.threatsBlocked++;
      this.threatChecker.threatsBlocked++; // Sync with engine panel counter
      this.emit("blocked", { url: `https://${hostname}`, ...result });
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }

    // Track client socket for clean shutdown
    if (this._sockets) {
      this._sockets.add(clientSocket);
      clientSocket.on('close', () => this._sockets.delete(clientSocket));
    }

    // Allow the tunnel
    const serverSocket = net.createConnection(port, hostname, () => {
      // Check resolved IP to prevent DNS rebinding SSRF
      const addr = serverSocket.remoteAddress;
      if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|fc|fd)/.test(addr)) {
        this.threatsBlocked++;
        serverSocket.destroy();
        clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    // Track outbound socket for clean shutdown
    if (this._sockets) {
      this._sockets.add(serverSocket);
      serverSocket.on("close", () => this._sockets.delete(serverSocket));
    }

    serverSocket.on("error", () => clientSocket.end());
    clientSocket.on("error", () => serverSocket.end());
  }

  _blockPage(url, result) {
    const safeUrl = url.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const reasons = (result.checks || []).map((c) => c.detail).join(", ");
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{background:#000;color:#fff;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;max-width:480px;padding:40px}.shield{font-size:48px;margin-bottom:16px}
h1{font-size:1.5rem;margin-bottom:8px;color:#ff3b3b}p{color:#999;font-size:0.875rem;line-height:1.6}
.url{font-family:monospace;font-size:0.75rem;color:#666;word-break:break-all;margin-top:16px;padding:12px;background:#111;border-radius:8px}</style>
</head><body><div class="box"><div class="shield">&#x1F6E1;</div>
<h1>Threat Blocked</h1><p>Vizoguard blocked this page because it was flagged as dangerous.<br>${reasons}</p>
<div class="url">${safeUrl}</div></div></body></html>`;
  }
}

module.exports = SecurityProxy;
