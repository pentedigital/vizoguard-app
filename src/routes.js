const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { elevatedExec } = require("./elevation");

class Routes {
  constructor() {
    this._originalGateway = null;
    this._originalInterface = null;
    this._vpnServerIp = null;
    this._applied = false;
  }

  get isApplied() {
    return this._applied;
  }

  get originalGateway() {
    return this._originalGateway;
  }

  // Save current default gateway before modifying routes
  async save() {
    if (process.platform === "darwin") {
      await this._saveDarwin();
    } else {
      await this._saveWin32();
    }
  }

  // Set TUN as default route, preserve route to VPN server
  async apply(tunGateway, vpnServerIp) {
    this._vpnServerIp = vpnServerIp;

    if (!this._originalGateway) {
      throw new Error("Must call save() before apply()");
    }

    if (process.platform === "darwin") {
      await this._applyDarwin(tunGateway, vpnServerIp);
    } else {
      await this._applyWin32(tunGateway, vpnServerIp);
    }

    this._applied = true;
  }

  // Restore original routes
  async restore() {
    if (!this._originalGateway) return;

    try {
      if (process.platform === "darwin") {
        await this._restoreDarwin();
      } else {
        await this._restoreWin32();
      }
    } catch (e) {
      console.error("Failed to restore routes:", e.message);
    }

    this._applied = false;
  }

  // Check if current default route still points to TUN gateway
  async isIntact(tunGateway) {
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("/usr/sbin/netstat", ["-rn"]);
        return stdout.includes(tunGateway);
      } else {
        const { stdout } = await execFileAsync("route", ["print", "0.0.0.0"]);
        return stdout.includes(tunGateway);
      }
    } catch {
      return false;
    }
  }

  // ── macOS ──────────────────────────────────────

  async _saveDarwin() {
    try {
      const { stdout } = await execFileAsync("/sbin/route", ["-n", "get", "default"]);
      const gwMatch = stdout.match(/gateway:\s*(\S+)/);
      const ifMatch = stdout.match(/interface:\s*(\S+)/);
      this._originalGateway = gwMatch ? gwMatch[1] : null;
      this._originalInterface = ifMatch ? ifMatch[1] : null;

      if (!this._originalGateway) {
        throw new Error("Could not detect default gateway");
      }
      console.log(`Saved original route: gateway=${this._originalGateway}, interface=${this._originalInterface}`);
    } catch (e) {
      throw new Error(`Failed to read default route: ${e.message}`);
    }
  }

  async _applyDarwin(tunGateway, vpnServerIp) {
    // 1. Preserve route to VPN server through original gateway
    await elevatedExec(`/sbin/route add -host ${vpnServerIp} ${this._originalGateway}`);

    // 2. Replace default route with TUN gateway
    await elevatedExec(`/sbin/route delete default`).catch(() => {});
    await elevatedExec(`/sbin/route add default ${tunGateway}`);

    console.log(`Routes applied: default → ${tunGateway}, ${vpnServerIp} → ${this._originalGateway}`);
  }

  async _restoreDarwin() {
    // 1. Restore original default route (must happen before tun2socks dies)
    await elevatedExec(`/sbin/route delete default`).catch(() => {});
    await elevatedExec(`/sbin/route add default ${this._originalGateway}`);

    // 2. Remove VPN server host route
    if (this._vpnServerIp) {
      await elevatedExec(`/sbin/route delete -host ${this._vpnServerIp}`).catch(() => {});
    }

    console.log(`Routes restored: default → ${this._originalGateway}`);
  }

  // ── Windows ────────────────────────────────────

  async _saveWin32() {
    try {
      const { stdout } = await execFileAsync("route", ["print", "0.0.0.0"]);
      // Parse "0.0.0.0    0.0.0.0    192.168.1.1    192.168.1.100    25"
      const lines = stdout.split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === "0.0.0.0" && parts[1] === "0.0.0.0") {
          this._originalGateway = parts[2];
          break;
        }
      }

      if (!this._originalGateway) {
        throw new Error("Could not detect default gateway");
      }
      console.log(`Saved original route: gateway=${this._originalGateway}`);
    } catch (e) {
      throw new Error(`Failed to read default route: ${e.message}`);
    }
  }

  async _applyWin32(tunGateway, vpnServerIp) {
    // 1. Preserve route to VPN server through original gateway
    await elevatedExec(`route add ${vpnServerIp} mask 255.255.255.255 ${this._originalGateway}`);

    // 2. Add TUN as default route with low metric (higher priority)
    await elevatedExec(`route add 0.0.0.0 mask 0.0.0.0 ${tunGateway} metric 5`);

    console.log(`Routes applied: 0.0.0.0/0 → ${tunGateway} (metric 5), ${vpnServerIp} → ${this._originalGateway}`);
  }

  async _restoreWin32() {
    // 1. Remove TUN default route
    await elevatedExec(`route delete 0.0.0.0 mask 0.0.0.0 10.0.85.1`).catch(() => {});

    // 2. Remove VPN server host route
    if (this._vpnServerIp) {
      await elevatedExec(`route delete ${this._vpnServerIp}`).catch(() => {});
    }

    console.log(`Routes restored: removed TUN routes`);
  }
}

module.exports = Routes;
