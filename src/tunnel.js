const { spawn } = require("child_process");
const path = require("path");
const { EventEmitter } = require("events");
const { app } = require("electron");

const TUN_IP = "10.0.85.2";
const TUN_GW = "10.0.85.1";
const TUN_MASK = "255.255.255.0";

class Tunnel extends EventEmitter {
  constructor() {
    super();
    this._process = null;
    this._deviceName = null;
  }

  get isRunning() {
    return this._process !== null;
  }

  get deviceName() {
    return this._deviceName;
  }

  // Resolve path to the tun2socks binary for current platform
  _getBinaryPath() {
    const platform = process.platform === "darwin" ? "darwin" : "win";
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const ext = process.platform === "win32" ? ".exe" : "";
    const binName = `tun2socks${ext}`;

    const base = app.isPackaged
      ? path.join(process.resourcesPath, "bin")
      : path.join(__dirname, "..", "bin", `${platform}-${arch}`);

    return path.join(base, binName);
  }

  // Start tun2socks as a child process
  // On macOS: launched via sudo (elevation.js handles this externally)
  // Returns once tun2socks prints the device name to stdout
  start(socksPort = 1080) {
    return new Promise((resolve, reject) => {
      if (this._process) {
        resolve();
        return;
      }

      const binPath = this._getBinaryPath();
      const device = process.platform === "darwin" ? "utun" : "tun://vizoguard";

      const args = [
        "-device", device,
        "-proxy", `socks5://127.0.0.1:${socksPort}`,
      ];

      console.log(`Starting tun2socks: ${binPath} ${args.join(" ")}`);

      const proc = spawn(binPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      this._process = proc;

      let started = false;
      let stdoutBuf = "";
      const startTimeout = setTimeout(() => {
        if (!started) {
          this.stop();
          reject(new Error("tun2socks failed to start within 10 seconds"));
        }
      }, 10000);

      proc.stdout.on("data", (data) => {
        const text = data.toString();
        stdoutBuf += text;
        console.log("[tun2socks]", text.trim());

        // tun2socks v2 prints the device name on startup
        // Look for "utun" on macOS or "vizoguard" on Windows
        if (!started) {
          const utunMatch = stdoutBuf.match(/(?:utun\d+|vizoguard)/i);
          if (utunMatch) {
            this._deviceName = utunMatch[0];
            started = true;
            clearTimeout(startTimeout);
            resolve();
          }
        }
      });

      proc.stderr.on("data", (data) => {
        const text = data.toString();
        console.error("[tun2socks stderr]", text.trim());

        // Some versions print device info to stderr
        if (!started) {
          const utunMatch = text.match(/(?:utun\d+|vizoguard)/i);
          if (utunMatch) {
            this._deviceName = utunMatch[0];
            started = true;
            clearTimeout(startTimeout);
            resolve();
          }
        }
      });

      proc.on("error", (err) => {
        clearTimeout(startTimeout);
        this._process = null;
        this._deviceName = null;
        if (!started) {
          reject(new Error(`tun2socks failed to start: ${err.message}`));
        } else {
          this.emit("died", err);
        }
      });

      proc.on("exit", (code) => {
        clearTimeout(startTimeout);
        this._process = null;
        const dev = this._deviceName;
        this._deviceName = null;
        if (!started) {
          reject(new Error(`tun2socks exited with code ${code} before starting`));
        } else {
          console.log(`tun2socks exited (code ${code}, device was ${dev})`);
          this.emit("died", new Error(`tun2socks exited with code ${code}`));
        }
      });
    });
  }

  // Stop tun2socks process
  stop() {
    if (this._process) {
      const proc = this._process;
      this._process = null;
      this._deviceName = null;
      try {
        proc.kill("SIGTERM");
        // Force kill after 3 seconds if still alive
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 3000);
      } catch {}
    }
  }

  // Check if process is still alive
  isAlive() {
    if (!this._process) return false;
    try {
      process.kill(this._process.pid, 0);
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
