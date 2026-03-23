const { execFile, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { EventEmitter } = require("events");
const { app } = require("electron");
const { elevatedExec } = require("./elevation");

const TUN_IP = "10.0.85.2";
const TUN_GW = "10.0.85.1";
const TUN_MASK = "255.255.255.0";
const HEALTH_INTERVAL = 3000;

class Tunnel extends EventEmitter {
  constructor() {
    super();
    this._pid = null;
    this._deviceName = null;
    this._healthTimer = null;
  }

  get isRunning() {
    return this._pid !== null;
  }

  get deviceName() {
    return this._deviceName;
  }

  _getBinaryPath() {
    const platform = process.platform === "darwin" ? "darwin" : "win";
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const ext = process.platform === "win32" ? ".exe" : "";
    const binName = `tun2socks${ext}`;

    // extraFiles places binaries at <install-dir>/bin/, not resources/bin/
    const base = app.isPackaged
      ? path.join(path.dirname(app.getPath("exe")), "bin")
      : path.join(__dirname, "..", "bin", `${platform}-${arch}`);

    return path.join(base, binName);
  }

  _getPidFile() {
    return path.join(app.getPath("temp"), "vizoguard-tun2socks.pid");
  }

  // Start tun2socks with elevated privileges (required for TUN creation).
  // sudo-prompt doesn't return a process handle, so we launch in background
  // and track via PID file.
  async start(socksPort = 1080) {
    if (this._pid) return;

    const binPath = this._getBinaryPath();
    const device = process.platform === "darwin" ? "utun" : "tun://vizoguard";
    const pidFile = this._getPidFile();

    try { fs.unlinkSync(pidFile); } catch {}

    console.log(`Starting tun2socks (elevated): ${binPath}`);

    if (process.platform === "win32") {
      // Windows: Start-Process writes PID, then sleeps to keep elevation session alive
      // tun2socks.exe runs independently as a background process
      const escaped = binPath.replace(/'/g, "''");
      const pidEscaped = pidFile.replace(/'/g, "''");
      const psScript = `$p = Start-Process -FilePath '${escaped}' -ArgumentList '-device','${device}','-proxy','socks5://127.0.0.1:${socksPort}' -PassThru -WindowStyle Hidden; $p.Id | Out-File -FilePath '${pidEscaped}' -Encoding ascii`;
      await elevatedExec(`powershell -Command "${psScript}"`);
    } else {
      // macOS: launch via sudo in background, capture PID
      const escaped = binPath.replace(/"/g, '\\"');
      await elevatedExec(`"${escaped}" -device ${device} -proxy socks5://127.0.0.1:${socksPort} & echo $! > "${pidFile}"`);
    }

    // Wait for PID file (max 8s)
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
      throw new Error("tun2socks failed to start — could not read PID");
    }

    this._pid = pid;
    console.log(`tun2socks PID: ${pid}`);

    // Wait for TUN interface (max 8s)
    let found = false;
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      const devName = await this._detectTunDevice();
      if (devName) {
        this._deviceName = devName;
        found = true;
        break;
      }
    }

    if (!found) {
      this.stop();
      throw new Error("tun2socks started but TUN interface did not appear");
    }

    console.log(`TUN interface: ${this._deviceName}`);

    // Monitor process health
    this._healthTimer = setInterval(() => {
      if (!this.isAlive()) {
        this._pid = null;
        this._deviceName = null;
        this._stopHealth();
        this.emit("died", new Error("tun2socks process exited"));
      }
    }, HEALTH_INTERVAL);
  }

  async _detectTunDevice() {
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("ifconfig", ["-l"]);
        const utun = stdout.trim().split(/\s+/).filter(i => i.startsWith("utun")).pop();
        return utun || null;
      } else {
        const { stdout } = await execFileAsync("netsh", ["interface", "show", "interface"]);
        return stdout.includes("vizoguard") ? "vizoguard" : null;
      }
    } catch {
      return null;
    }
  }

  stop() {
    this._stopHealth();

    if (this._pid) {
      const pid = this._pid;
      this._pid = null;
      this._deviceName = null;

      try {
        if (process.platform === "win32") {
          // taskkill with PID (integer we control — safe)
          try { execFileSync("taskkill", ["/F", "/PID", String(pid)], { timeout: 5000 }); } catch {}
        } else {
          process.kill(pid, "SIGTERM");
          setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} }, 3000);
        }
      } catch {}
    }

    try { fs.unlinkSync(this._getPidFile()); } catch {}
  }

  _stopHealth() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  isAlive() {
    if (!this._pid) return false;
    try {
      process.kill(this._pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

Tunnel.TUN_IP = TUN_IP;
Tunnel.TUN_GW = TUN_GW;
Tunnel.TUN_MASK = TUN_MASK;

module.exports = Tunnel;
