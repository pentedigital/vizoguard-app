// Kill switch — OS-level firewall that blocks all traffic outside the VPN tunnel.
// Windows: netsh advfirewall rules. macOS: PF (Packet Filter) rules via pfctl.
// Rules persist independently of the app process — if Electron crashes, traffic stays blocked.

const { elevatedExec, elevatedBatch } = require("./elevation");
const path = require("path");
const fs = require("fs");

const RULE_PREFIX = "Vizoguard-KillSwitch";

// PF anchor name (macOS)
const PF_ANCHOR = "com.vizoguard.killswitch";

class Firewall {
  constructor() {
    this._active = false;
    this._vpnServerIp = null;
    this._tunInterface = null;
  }

  get isActive() {
    return this._active;
  }

  // Activate kill switch — blocks all traffic except:
  // 1. Loopback (127.0.0.1 / ::1)
  // 2. Traffic to VPN server IP (so the tunnel itself can connect)
  // 3. Traffic on the TUN interface (VPN tunnel)
  // 4. DHCP (UDP 67/68) so network interface stays alive
  // 5. Local SOCKS proxy (127.0.0.1:1080) and security proxy (127.0.0.1:8888)
  async activate(vpnServerIp, tunInterface) {
    if (this._active) await this.deactivate();

    this._vpnServerIp = vpnServerIp;
    this._tunInterface = tunInterface || null;

    if (process.platform === "darwin") {
      await this._activateDarwin(vpnServerIp);
    } else {
      await this._activateWindows(vpnServerIp);
    }

    this._active = true;
    console.log("Kill switch activated");
  }

  // Deactivate kill switch — remove all rules, restore normal traffic
  async deactivate() {
    if (!this._active) return;

    try {
      if (process.platform === "darwin") {
        await this._deactivateDarwin();
      } else {
        await this._deactivateWindows();
      }
    } catch (e) {
      console.error("Kill switch deactivation error:", e.message);
    }

    this._active = false;
    this._vpnServerIp = null;
    this._tunInterface = null;
    console.log("Kill switch deactivated");
  }

  // ── macOS (PF) ────────────────────────────────

  async _activateDarwin(vpnServerIp) {
    // Write PF rules to a temporary config file, load via pfctl anchor
    const app = _getApp();
    const confPath = path.join(
      app ? app.getPath("temp") : require("os").tmpdir(),
      "vizoguard-killswitch.pf.conf"
    );

    // Build PF rules — anchor-based so we never touch /etc/pf.conf
    const rules = [
      "# Vizoguard Kill Switch — auto-generated, do not edit",
      "# Pass loopback",
      "pass quick on lo0 all",
      "# Allow DHCP",
      "pass quick proto udp from any port 68 to any port 67",
      "pass quick proto udp from any port 67 to any port 68",
      "# Allow traffic to VPN server",
      `pass quick proto { tcp, udp } to ${vpnServerIp}`,
      "# Allow traffic on TUN interfaces (utun* on macOS)",
      "pass quick on utun0 all",
      "pass quick on utun1 all",
      "pass quick on utun2 all",
      "pass quick on utun3 all",
      "pass quick on utun4 all",
      "pass quick on utun5 all",
      "# Allow DNS only to tunnel DNS servers (not any — prevents DNS leak)",
      "pass quick proto { tcp, udp } to 9.9.9.9 port 53",
      "pass quick proto { tcp, udp } to 1.1.1.1 port 53",
      "# Block everything else",
      "block all",
    ].join("\n") + "\n";

    fs.writeFileSync(confPath, rules);

    // Load the anchor rules and enable PF
    await elevatedBatch([
      // Load our rules into the anchor
      `pfctl -a "${PF_ANCHOR}" -f "${confPath}" 2>/dev/null`,
      // Enable PF if not already enabled (idempotent)
      `pfctl -e 2>/dev/null || true`,
    ]);

    // Clean up temp file
    try { fs.unlinkSync(confPath); } catch {}
  }

  async _deactivateDarwin() {
    // Flush our anchor — removes all our rules, leaves system PF intact
    await elevatedExec(`pfctl -a "${PF_ANCHOR}" -F all 2>/dev/null || true`);
  }

  // ── Windows (netsh advfirewall) ────────────────

  async _activateWindows(vpnServerIp) {
    // Remove any stale rules first
    await this._deactivateWindows();

    // Create firewall rules using netsh advfirewall
    // Order matters: allow rules must be created before the block rule
    const cmds = [
      // Allow loopback
      `netsh advfirewall firewall add rule name="${RULE_PREFIX}-AllowLoopback" dir=out action=allow remoteip=127.0.0.1 enable=yes`,
      // Allow DHCP
      `netsh advfirewall firewall add rule name="${RULE_PREFIX}-AllowDHCP" dir=out action=allow protocol=udp remoteport=67 enable=yes`,
      // Allow traffic to VPN server
      `netsh advfirewall firewall add rule name="${RULE_PREFIX}-AllowVPN" dir=out action=allow remoteip=${vpnServerIp} enable=yes`,
      // Allow local network (for LAN access + DNS)
      `netsh advfirewall firewall add rule name="${RULE_PREFIX}-AllowLAN" dir=out action=allow remoteip=localsubnet enable=yes`,
      // Allow DNS only to tunnel DNS servers — both UDP and TCP (prevents DNS leak)
      `netsh advfirewall firewall add rule name="${RULE_PREFIX}-AllowDNS1" dir=out action=allow protocol=udp remoteip=9.9.9.9 remoteport=53 enable=yes`,
      `netsh advfirewall firewall add rule name="${RULE_PREFIX}-AllowDNS1-TCP" dir=out action=allow protocol=tcp remoteip=9.9.9.9 remoteport=53 enable=yes`,
      `netsh advfirewall firewall add rule name="${RULE_PREFIX}-AllowDNS2" dir=out action=allow protocol=udp remoteip=1.1.1.1 remoteport=53 enable=yes`,
      `netsh advfirewall firewall add rule name="${RULE_PREFIX}-AllowDNS2-TCP" dir=out action=allow protocol=tcp remoteip=1.1.1.1 remoteport=53 enable=yes`,
      // Block all other outbound traffic
      `netsh advfirewall firewall add rule name="${RULE_PREFIX}-BlockAll" dir=out action=block enable=yes`,
    ];

    await elevatedBatch(cmds);
  }

  async _deactivateWindows() {
    // Remove all our rules by prefix — use || ver>nul to ignore "not found" errors
    const cmds = [
      `netsh advfirewall firewall delete rule name="${RULE_PREFIX}-BlockAll" || ver>nul`,
      `netsh advfirewall firewall delete rule name="${RULE_PREFIX}-AllowDNS1" || ver>nul`,
      `netsh advfirewall firewall delete rule name="${RULE_PREFIX}-AllowDNS1-TCP" || ver>nul`,
      `netsh advfirewall firewall delete rule name="${RULE_PREFIX}-AllowDNS2" || ver>nul`,
      `netsh advfirewall firewall delete rule name="${RULE_PREFIX}-AllowDNS2-TCP" || ver>nul`,
      `netsh advfirewall firewall delete rule name="${RULE_PREFIX}-AllowLAN" || ver>nul`,
      `netsh advfirewall firewall delete rule name="${RULE_PREFIX}-AllowVPN" || ver>nul`,
      `netsh advfirewall firewall delete rule name="${RULE_PREFIX}-AllowDHCP" || ver>nul`,
      `netsh advfirewall firewall delete rule name="${RULE_PREFIX}-AllowLoopback" || ver>nul`,
    ];

    await elevatedBatch(cmds, { ignoreErrors: true });
  }
}

function _getApp() {
  try { return require("electron").app; } catch { return null; }
}

module.exports = Firewall;
