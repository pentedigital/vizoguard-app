// Obfuscated transport — sing-box with VLESS + WebSocket + TLS
// Used in censored networks (UAE, China, Iran, etc.)
// Traffic looks like normal HTTPS to vizoguard.com

const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");
const { app } = require("electron");
const { elevatedExec } = require("../elevation");

// VLESS UUID — shared transport credential (user auth is at license level)
const VLESS_UUID = "f6cb19fc-7b10-4787-a63a-e41f64707534";
const VLESS_SERVER = "vizoguard.com";
const VLESS_PORT = 443;
const WS_PATH = "/ws";
const HEALTH_INTERVAL = 3000;

class ObfuscatedTransport extends EventEmitter {
  constructor() {
    super();
    this._pid = null;
    this._healthTimer = null;
    this._running = false;
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

    const base = app.isPackaged
      ? path.join(process.resourcesPath, "bin")
      : path.join(__dirname, "..", "..", "bin", `${platform}-${arch}`);

    return path.join(base, `sing-box${ext}`);
  }

  _getConfigPath() {
    return path.join(app.getPath("temp"), "vizoguard-singbox.json");
  }

  _getPidFile() {
    return path.join(app.getPath("temp"), "vizoguard-singbox.pid");
  }

  // Generate sing-box config for VLESS + WS + TLS
  _generateConfig() {
    return {
      log: { level: "warn" },
      inbounds: [{
        type: "tun",
        interface_name: "vizoguard",
        inet4_address: "10.0.85.1/30",
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
      }],
      dns: {
        servers: [
          { address: "9.9.9.9", tag: "dns-remote" },
          { address: "1.1.1.1", tag: "dns-fallback" }
        ]
      },
      route: {
        auto_detect_interface: true
      }
    };
  }

  async start() {
    if (this._running) return;

    const binPath = this._getBinaryPath();
    const configPath = this._getConfigPath();
    const pidFile = this._getPidFile();

    // Write config
    const config = this._generateConfig();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Clean stale PID
    try { fs.unlinkSync(pidFile); } catch {}

    console.log(`Starting sing-box (obfuscated): ${binPath}`);

    if (process.platform === "win32") {
      const escaped = binPath.replace(/'/g, "''");
      const confEscaped = configPath.replace(/'/g, "''");
      const pidEscaped = pidFile.replace(/'/g, "''");
      const psScript = `$p = Start-Process -FilePath '${escaped}' -ArgumentList 'run','-c','${confEscaped}' -PassThru -WindowStyle Hidden; $p.Id | Out-File -FilePath '${pidEscaped}' -Encoding ascii`;
      await elevatedExec(`powershell -Command "${psScript}"`);
    } else {
      const escaped = binPath.replace(/"/g, '\\"');
      const confEscaped = configPath.replace(/"/g, '\\"');
      await elevatedExec(`"${escaped}" run -c "${confEscaped}" & echo $! > "${pidFile}"`);
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
      throw new Error("sing-box failed to start — could not read PID");
    }

    this._pid = pid;
    console.log(`sing-box PID: ${pid}`);

    // Wait for TUN interface (max 8s)
    let found = false;
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      const detected = await this._detectTun();
      if (detected) { found = true; break; }
    }

    if (!found) {
      this.stop();
      throw new Error("sing-box started but TUN interface did not appear");
    }

    this._running = true;
    console.log("sing-box connected (obfuscated mode)");

    // Health monitor
    this._healthTimer = setInterval(() => {
      if (!this._isAlive()) {
        this._pid = null;
        this._running = false;
        this._stopHealth();
        this.emit("error", new Error("Obfuscated tunnel process died"));
        this.emit("disconnected");
      }
    }, HEALTH_INTERVAL);

    this.emit("connected");
  }

  async stop() {
    this._stopHealth();

    if (this._pid) {
      const pid = this._pid;
      this._pid = null;
      this._running = false;

      try {
        if (process.platform === "win32") {
          try { execFileSync("taskkill", ["/F", "/PID", String(pid)], { timeout: 5000 }); } catch {}
        } else {
          process.kill(pid, "SIGTERM");
          setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} }, 3000);
        }
      } catch {}
    }

    // Clean up temp files
    try { fs.unlinkSync(this._getConfigPath()); } catch {}
    try { fs.unlinkSync(this._getPidFile()); } catch {}

    this._running = false;
    this.emit("disconnected");
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
        const { stdout } = await execFileAsync("ifconfig", ["-l"]);
        return stdout.includes("utun");
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
