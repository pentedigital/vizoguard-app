// Obfuscated transport — sing-box with VLESS + WebSocket + TLS
// Used in censored networks (UAE, China, Iran, etc.)
// Traffic looks like normal HTTPS to vizoguard.com

const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const dns = require("dns");
const dnsResolve4 = promisify(dns.resolve4);
const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");
const { app } = require("electron");
const { elevatedExec, elevatedBatch } = require("../elevation");

// Safe shell escaping — wraps in single quotes, escapes embedded single quotes
function shellEscape(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }

// VLESS UUID — shared transport credential (user auth is at license level)
const VLESS_UUID = "f6cb19fc-7b10-4787-a63a-e41f64707534";
const VLESS_SERVER = "vizoguard.com";
const VLESS_PORT = 443;
const WS_PATH = "/ws";
const HEALTH_INTERVAL = 3000;
const LOG_TAIL_LINES = 30;

class ObfuscatedTransport extends EventEmitter {
  constructor() {
    super();
    this._pid = null;
    this._healthTimer = null;
    this._running = false;
    this._logFile = null;
    this._originalGateway = null; // saved before TUN takes over, for rollback
  }

  get isRunning() {
    return this._running;
  }

  get name() {
    return "obfuscated";
  }

  _getBinaryPath() {
    const platform = process.platform === "darwin" ? "darwin" : "win";
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const ext = process.platform === "win32" ? ".exe" : "";

    // extraFiles: <install-dir>/bin/ — go up from resources/ to find it
    const base = app.isPackaged
      ? path.join(process.resourcesPath, "..", "bin")
      : path.join(__dirname, "..", "..", "bin", `${platform}-${arch}`);

    const binPath = path.join(base, `sing-box${ext}`);

    // Fail fast if binary doesn't exist
    if (!fs.existsSync(binPath)) {
      throw new Error(`sing-box binary not found at ${binPath}`);
    }

    // Ensure executable permission (macOS packaging can strip it)
    if (process.platform !== "win32") {
      try { fs.chmodSync(binPath, 0o755); } catch {}
    }

    return binPath;
  }

  _getConfigPath() {
    return path.join(app.getPath("temp"), "vizoguard-singbox.json");
  }

  _getPidFile() {
    return path.join(app.getPath("temp"), "vizoguard-singbox.pid");
  }

  _getLogFile() {
    return path.join(app.getPath("temp"), "vizoguard-singbox.log");
  }

  // Read tail of sing-box log file for diagnostics
  _readLogTail() {
    try {
      const logPath = this._logFile || this._getLogFile();
      const errPath = logPath.replace(/\.log$/, ".err");

      const logExists = fs.existsSync(logPath);
      const errExists = errPath !== logPath && fs.existsSync(errPath);

      if (!logExists && !errExists) return "(no log file found)";

      let output = "";

      // Read stdout log
      if (logExists) {
        const content = fs.readFileSync(logPath, "utf8").trim();
        if (content) output += content;
      }

      // On Windows, stderr goes to a separate .err file
      if (errExists) {
        const errContent = fs.readFileSync(errPath, "utf8").trim();
        if (errContent) output += (output ? "\n" : "") + errContent;
      }

      if (!output) return "(log file empty)";
      const lines = output.split("\n");
      return lines.slice(-LOG_TAIL_LINES).join("\n");
    } catch {
      return "(could not read log file)";
    }
  }

  // Validate config before writing to disk
  _validateConfig(config) {
    if (!config.outbounds || !config.outbounds.length) {
      throw new Error("Invalid sing-box config: no outbounds defined");
    }
    const proxy = config.outbounds.find(o => o.tag === "proxy");
    if (!proxy) {
      throw new Error("Invalid sing-box config: no 'proxy' outbound defined");
    }
    if (!proxy.server || !proxy.server_port || !proxy.uuid) {
      throw new Error("Invalid sing-box config: proxy outbound missing server, server_port, or uuid");
    }
    if (!config.inbounds || !config.inbounds.length) {
      throw new Error("Invalid sing-box config: no inbounds defined");
    }
    const tun = config.inbounds.find(i => i.type === "tun");
    if (!tun || !tun.address || !tun.address.length) {
      throw new Error("Invalid sing-box config: TUN inbound missing or has no address");
    }
    // Ensure route rules exist with server IP bypass (prevents routing loop)
    if (!config.route || !config.route.rules || !config.route.rules.length) {
      throw new Error("Invalid sing-box config: route rules missing — server IP bypass required");
    }
    const hasServerBypass = config.route.rules.some(r =>
      r.ip_cidr && r.outbound === "direct" && r.ip_cidr.some(cidr => cidr.endsWith("/32"))
    );
    if (!hasServerBypass) {
      throw new Error("Invalid sing-box config: no server IP bypass rule — will cause routing loop");
    }
  }

  // Save current default gateway for rollback if sing-box doesn't clean up auto_route
  async _saveGateway() {
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("/sbin/route", ["-n", "get", "default"]);
        const match = stdout.match(/gateway:\s*(\S+)/);
        this._originalGateway = match ? match[1] : null;
      } else {
        const { stdout } = await execFileAsync("route", ["print", "0.0.0.0"]);
        const lines = stdout.split("\n");
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts[0] === "0.0.0.0" && parts[1] === "0.0.0.0") {
            this._originalGateway = parts[2];
            break;
          }
        }
      }
      if (this._originalGateway) {
        console.log(`Saved original gateway: ${this._originalGateway}`);
      }
    } catch (e) {
      console.error("Failed to save gateway:", e.message);
    }
  }

  // Verify default route is restored after sing-box stops; fix it if not
  async _ensureRouteRestored() {
    if (!this._originalGateway) return;

    // Give the OS a moment to clean up after sing-box exits
    await new Promise(r => setTimeout(r, 1000));

    try {
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("/sbin/route", ["-n", "get", "default"]);
        const match = stdout.match(/gateway:\s*(\S+)/);
        const currentGw = match ? match[1] : null;

        if (!currentGw) {
          console.warn("No default route after sing-box stop — restoring");
          await elevatedExec(`/sbin/route add default ${this._originalGateway}`);
          console.log(`Restored default route → ${this._originalGateway}`);
        } else if (currentGw === "10.0.85.1") {
          console.warn("Default route still points to TUN — restoring");
          await elevatedBatch([
            `/sbin/route delete default || true`,
            `/sbin/route add default ${this._originalGateway}`
          ]);
          console.log(`Restored default route → ${this._originalGateway}`);
        }
      } else {
        const { stdout } = await execFileAsync("route", ["print", "0.0.0.0"]);
        const cmds = [];
        if (stdout.includes("10.0.85.1")) {
          cmds.push("route delete 0.0.0.0 mask 0.0.0.0 10.0.85.1 || ver>nul");
        }
        if (!stdout.includes(this._originalGateway)) {
          cmds.push(`route add 0.0.0.0 mask 0.0.0.0 ${this._originalGateway} metric 25`);
        }
        if (cmds.length > 0) {
          await elevatedBatch(cmds, { ignoreErrors: true });
          console.log(`Restored routes (${cmds.length} commands)`);
        }
      }
    } catch (e) {
      console.error("Route restoration check failed:", e.message);
    }

    this._originalGateway = null;
  }

  // Resolve VLESS server to IP addresses (must happen BEFORE TUN is up)
  async _resolveServerIp() {
    try {
      const ips = await dnsResolve4(VLESS_SERVER);
      if (ips && ips.length > 0) return ips;
    } catch {}
    // Fallback: try system resolver
    try {
      const { address } = await promisify(dns.lookup)(VLESS_SERVER);
      if (address) return [address];
    } catch {}
    throw new Error(`Cannot resolve ${VLESS_SERVER} — check your internet connection`);
  }

  // Generate sing-box config for VLESS + WS + TLS
  // serverIps: resolved IPs of the VLESS server, excluded from TUN to prevent routing loop
  _generateConfig(serverIps) {
    // Build IP rules to bypass the VPN server — prevents routing loop
    // where sing-box's own outbound gets caught by its TUN
    const serverIpRules = serverIps.map(ip => `${ip}/32`);

    return {
      log: { level: "warn" },
      inbounds: [{
        type: "tun",
        interface_name: "vizoguard",
        address: ["10.0.85.1/30"],
        auto_route: true,
        strict_route: true,
        sniff: true,
        stack: "system"
      }],
      outbounds: [{
        type: "vless",
        tag: "proxy",
        server: VLESS_SERVER,
        server_port: VLESS_PORT,
        uuid: VLESS_UUID,
        tls: {
          enabled: true,
          server_name: VLESS_SERVER
        },
        transport: {
          type: "ws",
          path: WS_PATH
        }
      }, {
        type: "direct",
        tag: "direct"
      }, {
        type: "block",
        tag: "block"
      }],
      dns: {
        servers: [
          { address: "https://1.1.1.1/dns-query", tag: "dns-remote", strategy: "ipv4_only" },
          { address: "https://9.9.9.9/dns-query", tag: "dns-fallback", strategy: "ipv4_only" }
        ]
      },
      route: {
        auto_detect_interface: true,
        final: "proxy",
        rules: [
          // CRITICAL: Route VPN server IP directly — prevents routing loop
          { ip_cidr: serverIpRules, outbound: "direct" },
          // Bypass private networks
          {
            ip_cidr: [
              "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
              "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4",
              "255.255.255.255/32"
            ],
            outbound: "direct"
          }
        ]
      }
    };
  }

  async start() {
    if (this._running) return;

    const binPath = this._getBinaryPath();
    const configPath = this._getConfigPath();
    const pidFile = this._getPidFile();
    const logFile = this._getLogFile();
    this._logFile = logFile;

    // Save current default gateway for rollback safety net
    await this._saveGateway();

    // Resolve server IP BEFORE TUN goes up (DNS won't work after)
    console.log(`Resolving ${VLESS_SERVER}...`);
    const serverIps = await this._resolveServerIp();
    console.log(`Resolved ${VLESS_SERVER} → ${serverIps.join(", ")}`);

    // Generate and validate config before writing
    const config = this._generateConfig(serverIps);
    this._validateConfig(config);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Clean stale PID and log
    try { fs.unlinkSync(pidFile); } catch {}
    try { fs.unlinkSync(logFile); } catch {}

    console.log(`Starting sing-box (obfuscated): ${binPath}`);
    console.log(`Config: ${configPath}, PID file: ${pidFile}, Log: ${logFile}`);

    try {
      if (process.platform === "win32") {
        // WorkingDirectory must be the bin folder so sing-box finds wintun.dll
        const binDir = path.dirname(binPath).replace(/'/g, "''");
        const escaped = binPath.replace(/'/g, "''");
        const confEscaped = configPath.replace(/'/g, "''");
        const pidEscaped = pidFile.replace(/'/g, "''");
        const logEscaped = logFile.replace(/'/g, "''");
        const errLog = logFile.replace(/\.log$/, ".err").replace(/'/g, "''");
        const psScript = `$p = Start-Process -FilePath '${escaped}' -ArgumentList 'run','-c','${confEscaped}' -WorkingDirectory '${binDir}' -PassThru -WindowStyle Hidden -RedirectStandardOutput '${logEscaped}' -RedirectStandardError '${errLog}'; $p.Id | Out-File -FilePath '${pidEscaped}' -Encoding ascii`;
        await elevatedExec(`powershell -Command "${psScript}"`);
      } else {
        const escaped = shellEscape(binPath);
        const confEscaped = shellEscape(configPath);
        const pidEsc = shellEscape(pidFile);
        const logEsc = shellEscape(logFile);
        await elevatedExec(`${escaped} run -c ${confEscaped} > ${logEsc} 2>&1 & echo $! > ${pidEsc}`);
      }
    } catch (e) {
      throw new Error(`Failed to launch sing-box: ${e.message}`);
    }

    // Wait for PID (max 8s)
    let pid = null;
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const content = fs.readFileSync(pidFile, "utf8").trim();
        const parsed = parseInt(content, 10);
        if (parsed > 0) { pid = parsed; break; }
      } catch {}
    }

    if (!pid) {
      const logs = this._readLogTail();
      throw new Error(`sing-box failed to start — could not read PID. Check binary path and permissions.\n\nsing-box output:\n${logs}`);
    }

    // Verify the process is actually alive (not just a stale PID)
    try {
      process.kill(pid, 0);
    } catch {
      const logs = this._readLogTail();
      throw new Error(`sing-box process ${pid} exited immediately.\n\nsing-box output:\n${logs}`);
    }

    this._pid = pid;
    console.log(`sing-box PID: ${pid} (verified alive)`);

    // Wait for TUN interface (max 8s)
    let found = false;
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      const detected = await this._detectTun();
      if (detected) { found = true; break; }
    }

    if (!found) {
      const logs = this._readLogTail();
      this.stop();
      throw new Error(`sing-box started but TUN interface did not appear.\n\nsing-box output:\n${logs}`);
    }

    this._running = true;
    console.log("sing-box connected (obfuscated mode)");

    // Health monitor
    this._healthTimer = setInterval(async () => {
      if (!this._isAlive()) {
        this._pid = null;
        this._running = false;
        this._stopHealth();
        const logs = this._readLogTail();
        // Restore routes before emitting error — prevents internet blackhole
        await this._ensureRouteRestored();
        this.emit("error", new Error(`Obfuscated tunnel process died.\n\nsing-box output:\n${logs}`));
        this.emit("disconnected");
      }
    }, HEALTH_INTERVAL);

    this.emit("connected");
  }

  async stop() {
    this._stopHealth();
    const wasRunning = this._running;

    if (this._pid) {
      const pid = this._pid;
      this._pid = null;
      this._running = false;

      try {
        if (process.platform === "win32") {
          try { execFileSync("taskkill", ["/F", "/PID", String(pid)], { timeout: 5000 }); } catch {}
        } else {
          process.kill(pid, "SIGTERM");
          // Wait briefly for graceful shutdown before force-killing
          await new Promise(r => setTimeout(r, 2000));
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      } catch {}
    }

    // Verify OS routes are restored (sing-box auto_route cleanup is unreliable on crash/SIGKILL)
    await this._ensureRouteRestored();

    // Clean up temp files
    try { fs.unlinkSync(this._getConfigPath()); } catch {}
    try { fs.unlinkSync(this._getPidFile()); } catch {}
    try { fs.unlinkSync(this._getLogFile()); } catch {}
    try { fs.unlinkSync(this._getLogFile().replace(/\.log$/, ".err")); } catch {}

    this._running = false;
    if (wasRunning) this.emit("disconnected");
  }

  // Quick test: can we reach vizoguard.com:443 via TLS+WS?
  async test(timeout = 5000) {
    const net = require("net");
    return new Promise((resolve) => {
      const sock = net.createConnection(443, VLESS_SERVER);
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

  async _detectTun() {
    try {
      if (process.platform === "darwin") {
        // macOS: sing-box creates utunN (can't guarantee name "vizoguard")
        // If process is alive, TUN is ready (sing-box exits on TUN creation failure)
        return this._pid && this._isAlive();
      } else {
        const { stdout } = await execFileAsync("netsh", ["interface", "show", "interface"]);
        return stdout.includes("vizoguard");
      }
    } catch {
      return false;
    }
  }

  _isAlive() {
    if (!this._pid) return false;
    try { process.kill(this._pid, 0); return true; } catch { return false; }
  }

  _stopHealth() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }
}

module.exports = ObfuscatedTransport;
