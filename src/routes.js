const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { elevatedExec, elevatedBatch } = require("./elevation");

const STRICT_IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

function assertIp(value, label) {
  if (!STRICT_IPV4.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const octets = value.split(".").map(Number);
  if (octets.some(o => o > 255)) {
    throw new Error(`Invalid ${label}: octet out of range`);
  }
}

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
    this._tunGateway = tunGateway;

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

  // Mark as applied/restored after external batch execution
  markApplied() { this._applied = true; }
  markRestored() { this._applied = false; }

  // Return commands for batched execution (avoids multiple admin prompts)
  getApplyCommands(tunGateway, vpnServerIp) {
    this._vpnServerIp = vpnServerIp;
    this._tunGateway = tunGateway;
    if (!this._originalGateway) throw new Error("Must call save() before getApplyCommands()");

    assertIp(tunGateway, "tunGateway");
    assertIp(vpnServerIp, "vpnServerIp");
    assertIp(this._originalGateway, "originalGateway");

    if (process.platform === "darwin") {
      return [
        `/sbin/route add -host ${vpnServerIp} ${this._originalGateway}`,
        `/sbin/route delete default || true`,
        `/sbin/route add default ${tunGateway}`
      ];
    } else {
      return [
        `route add ${vpnServerIp} mask 255.255.255.255 ${this._originalGateway}`,
        `route add 0.0.0.0 mask 0.0.0.0 ${tunGateway} metric 5`
      ];
    }
  }

  getRestoreCommands() {
    if (!this._originalGateway) return [];
    const gw = this._tunGateway || "10.0.85.1";

    if (process.platform === "darwin") {
      assertIp(this._originalGateway, "originalGateway");
      const cmds = [
        `/sbin/route delete default || true`,
        `/sbin/route add default ${this._originalGateway}`
      ];
      if (this._vpnServerIp) {
        assertIp(this._vpnServerIp, "vpnServerIp");
        cmds.push(`/sbin/route delete -host ${this._vpnServerIp} || true`);
      }
      return cmds;
    } else {
      assertIp(gw, "tunGateway");
      const cmds = [`route delete 0.0.0.0 mask 0.0.0.0 ${gw} || ver>nul`];
      if (this._vpnServerIp) {
        assertIp(this._vpnServerIp, "vpnServerIp");
        cmds.push(`route delete ${this._vpnServerIp} || ver>nul`);
      }
      return cmds;
    }
  }

  async _applyDarwin(tunGateway, vpnServerIp) {
    assertIp(tunGateway, "tunGateway");
    assertIp(vpnServerIp, "vpnServerIp");
    assertIp(this._originalGateway, "originalGateway");

    await elevatedBatch([
      `/sbin/route add -host ${vpnServerIp} ${this._originalGateway}`,
      `/sbin/route delete default || true`,
      `/sbin/route add default ${tunGateway}`
    ]);

    console.log(`Routes applied: default → ${tunGateway}, ${vpnServerIp} → ${this._originalGateway}`);
  }

  async _restoreDarwin() {
    assertIp(this._originalGateway, "originalGateway");

    const cmds = [
      `/sbin/route delete default || true`,
      `/sbin/route add default ${this._originalGateway}`
    ];
    if (this._vpnServerIp) {
      assertIp(this._vpnServerIp, "vpnServerIp");
      cmds.push(`/sbin/route delete -host ${this._vpnServerIp} || true`);
    }
    await elevatedBatch(cmds);

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
    assertIp(tunGateway, "tunGateway");
    assertIp(vpnServerIp, "vpnServerIp");
    assertIp(this._originalGateway, "originalGateway");

    await elevatedBatch([
      `route add ${vpnServerIp} mask 255.255.255.255 ${this._originalGateway}`,
      `route add 0.0.0.0 mask 0.0.0.0 ${tunGateway} metric 5`
    ]);

    console.log(`Routes applied: 0.0.0.0/0 → ${tunGateway} (metric 5), ${vpnServerIp} → ${this._originalGateway}`);
  }

  async _restoreWin32() {
    const gw = this._tunGateway || "10.0.85.1";
    assertIp(gw, "tunGateway");
    const cmds = [`route delete 0.0.0.0 mask 0.0.0.0 ${gw} || ver>nul`];
    if (this._vpnServerIp) {
      assertIp(this._vpnServerIp, "vpnServerIp");
      cmds.push(`route delete ${this._vpnServerIp} || ver>nul`);
    }
    await elevatedBatch(cmds);

    console.log(`Routes restored: removed TUN routes`);
  }
}

module.exports = Routes;
