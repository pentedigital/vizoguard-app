const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { elevatedExec } = require("./elevation");

const TUNNEL_DNS = ["9.9.9.9", "1.1.1.1"];

class Dns {
  constructor() {
    this._originalServers = null;
    this._ipv6Disabled = false;
    this._service = null; // macOS network service name
    this._applied = false;
  }

  get isApplied() {
    return this._applied;
  }

  // Save current DNS servers before modifying
  async save() {
    if (process.platform === "darwin") {
      await this._saveDarwin();
    } else {
      await this._saveWin32();
    }
  }

  // Set tunnel-safe DNS servers and disable IPv6 to prevent leaks
  async apply() {
    if (process.platform === "darwin") {
      await this._applyDarwin();
      await this._disableIpv6Darwin();
    } else {
      await this._applyWin32();
      await this._disableIpv6Win32();
    }
    this._applied = true;
  }

  // Restore original DNS servers and re-enable IPv6
  async restore() {
    try {
      if (process.platform === "darwin") {
        await this._restoreDarwin();
        await this._restoreIpv6Darwin();
      } else {
        await this._restoreWin32();
        await this._restoreIpv6Win32();
      }
    } catch (e) {
      console.error("Failed to restore DNS:", e.message);
    }
    this._applied = false;
    this._ipv6Disabled = false;
  }

  // Check if DNS still points to tunnel servers
  async isIntact() {
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("/usr/sbin/networksetup", ["-getdnsservers", this._service || "Wi-Fi"]);
        return stdout.includes(TUNNEL_DNS[0]);
      } else {
        const { stdout } = await execFileAsync("netsh", ["interface", "ip", "show", "dns", "vizoguard"]);
        return stdout.includes(TUNNEL_DNS[0]);
      }
    } catch {
      return false;
    }
  }

  // ── macOS ──────────────────────────────────────

  async _saveDarwin() {
    // Find the active network service (Wi-Fi, Ethernet, etc.)
    try {
      const { stdout } = await execFileAsync("/usr/sbin/networksetup", ["-listallnetworkservices"]);
      const services = stdout.split("\n").filter(s => s && !s.startsWith("*")).map(s => s.trim());

      // Try to find the active service by checking which has a gateway
      for (const svc of services) {
        try {
          const { stdout: info } = await execFileAsync("/usr/sbin/networksetup", ["-getinfo", svc]);
          if (info.includes("Router:") && !info.includes("Router: \n")) {
            this._service = svc;
            break;
          }
        } catch {}
      }

      if (!this._service) {
        this._service = services.includes("Wi-Fi") ? "Wi-Fi" : services[0];
      }

      // Save current DNS
      const { stdout: dnsOut } = await execFileAsync("/usr/sbin/networksetup", ["-getdnsservers", this._service]);
      if (dnsOut.includes("There aren't any")) {
        this._originalServers = []; // DHCP DNS
      } else {
        this._originalServers = dnsOut.trim().split("\n").map(s => s.trim()).filter(Boolean);
      }

      console.log(`Saved DNS: service=${this._service}, servers=${this._originalServers.join(",") || "(DHCP)"}`);
    } catch (e) {
      throw new Error(`Failed to read DNS: ${e.message}`);
    }
  }

  async _applyDarwin() {
    await elevatedExec(`/usr/sbin/networksetup -setdnsservers "${this._service}" ${TUNNEL_DNS.join(" ")}`);
    console.log(`DNS set to ${TUNNEL_DNS.join(", ")} on ${this._service}`);
  }

  async _restoreDarwin() {
    if (!this._service) return;

    if (this._originalServers && this._originalServers.length > 0) {
      await elevatedExec(`/usr/sbin/networksetup -setdnsservers "${this._service}" ${this._originalServers.join(" ")}`);
    } else {
      // Restore to DHCP DNS (empty = automatic)
      await elevatedExec(`/usr/sbin/networksetup -setdnsservers "${this._service}" Empty`);
    }
    console.log(`DNS restored on ${this._service}`);
  }

  // ── Windows ────────────────────────────────────

  async _saveWin32() {
    try {
      // Get DNS for the active interface
      const { stdout } = await execFileAsync("netsh", ["interface", "ip", "show", "dns"]);
      const lines = stdout.split("\n");
      const servers = [];
      let activeInterface = null;

      for (const line of lines) {
        const ifMatch = line.match(/Configuration for interface "(.+)"/);
        if (ifMatch) activeInterface = ifMatch[1];
        const dnsMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (dnsMatch && activeInterface && activeInterface !== "Loopback") {
          servers.push(dnsMatch[1]);
        }
      }

      this._originalServers = servers;
      this._service = activeInterface;
      console.log(`Saved DNS: servers=${servers.join(",") || "(DHCP)"}`);
    } catch (e) {
      throw new Error(`Failed to read DNS: ${e.message}`);
    }
  }

  async _applyWin32() {
    // Set DNS on the TUN interface
    await elevatedExec(`netsh interface ip set dns "vizoguard" static ${TUNNEL_DNS[0]}`);
    await elevatedExec(`netsh interface ip add dns "vizoguard" ${TUNNEL_DNS[1]} index=2`);
    console.log(`DNS set to ${TUNNEL_DNS.join(", ")} on vizoguard`);
  }

  async _restoreWin32() {
    // On Windows, DNS was set on the TUN interface which gets destroyed.
    // No explicit restore needed — the original interface DNS is untouched.
    console.log("DNS restored (TUN interface removed)");
  }

  // ── IPv6 leak prevention ───────────────────────

  async _disableIpv6Darwin() {
    if (!this._service) return;
    try {
      await elevatedExec(`/usr/sbin/networksetup -setv6off "${this._service}"`);
      this._ipv6Disabled = true;
      console.log(`IPv6 disabled on ${this._service}`);
    } catch (e) {
      console.warn("Failed to disable IPv6:", e.message);
    }
  }

  async _restoreIpv6Darwin() {
    if (!this._service || !this._ipv6Disabled) return;
    try {
      await elevatedExec(`/usr/sbin/networksetup -setv6automatic "${this._service}"`);
      console.log(`IPv6 restored on ${this._service}`);
    } catch (e) {
      console.warn("Failed to restore IPv6:", e.message);
    }
  }

  async _disableIpv6Win32() {
    try {
      // Disable IPv6 on all interfaces via registry (takes effect immediately)
      await elevatedExec(`reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 0xFF /f`);
      this._ipv6Disabled = true;
      console.log("IPv6 disabled (Windows)");
    } catch (e) {
      console.warn("Failed to disable IPv6:", e.message);
    }
  }

  async _restoreIpv6Win32() {
    if (!this._ipv6Disabled) return;
    try {
      await elevatedExec(`reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 0x0 /f`);
      console.log("IPv6 restored (Windows)");
    } catch (e) {
      console.warn("Failed to restore IPv6:", e.message);
    }
  }
}

module.exports = Dns;
