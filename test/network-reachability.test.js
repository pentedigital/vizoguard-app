"use strict";

/**
 * Desktop E2E-style integration test: verify connect/disconnect preserves
 * local network reachability.
 *
 * This test exercises the Routes and Dns modules through a full lifecycle
 * (save → apply → restore) without requiring root privileges by mocking the
 * elevation layer. It validates that:
 * - Original gateway is preserved across the VPN cycle
 * - DNS servers are stored per-service and restored correctly
 * - Stale-gateway telemetry exists in the restore path
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Force darwin platform for route/DNS command generation tests
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");
Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

// ── Mock elevation module ──────────────────────────────────────────────────
const capturedCommands = [];
const mockElevatedExec = async (cmd) => {
  capturedCommands.push(cmd);
  return "";
};
const mockElevatedBatch = async (cmds) => {
  for (const cmd of cmds) capturedCommands.push(cmd);
  return { stdout: "", stderr: "" };
};

const elevationPath = path.resolve(__dirname, "../src/elevation.js");
require.cache[elevationPath] = {
  id: elevationPath,
  filename: elevationPath,
  loaded: true,
  exports: { elevatedExec: mockElevatedExec, elevatedBatch: mockElevatedBatch },
};

const Routes = require("../src/routes");
const Dns = require("../src/dns");

// ── Helpers ─────────────────────────────────────────────────────────────────
function freshRoutes() {
  const r = new Routes();
  r._originalGateway = "192.168.1.1";
  r._originalInterface = "en0";
  r._vpnServerIp = "45.67.89.10";
  return r;
}

function freshDns() {
  const d = new Dns();
  d._service = "Wi-Fi";
  d._serversByService = { "Wi-Fi": ["8.8.8.8", "1.1.1.1"] };
  return d;
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe("E2E: connect/disconnect preserves local network reachability", () => {
  beforeEach(() => {
    capturedCommands.length = 0;
  });

  after(() => {
    if (ORIGINAL_PLATFORM) {
      Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
    } else {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    }
  });

  it("restores original gateway after disconnect", () => {
    const routes = freshRoutes();

    const applyCmds = routes.getApplyCommands("10.0.85.1", "45.67.89.10");
    const restoreCmds = routes.getRestoreCommands();

    // Apply commands should route VPN server via original gateway
    assert.ok(applyCmds.some((c) => c.includes("route add -host 45.67.89.10 192.168.1.1")));
    // Apply commands should set default via TUN
    assert.ok(applyCmds.some((c) => c.includes("route change default 10.0.85.1")));

    // Restore commands should set default back to original gateway
    assert.ok(restoreCmds.some((c) => c.includes("route change default 192.168.1.1")));
    // Restore commands should include stale-gateway fallback
    assert.ok(restoreCmds.some((c) => c.includes('OG=$(/sbin/route -n get default')));
    // Restore commands should clean up VPN server route
    assert.ok(restoreCmds.some((c) => c.includes("route delete -host 45.67.89.10")));
  });

  it("restores original DNS servers after disconnect", () => {
    const dns = freshDns();
    const restoreCmds = dns.getRestoreCommands();

    assert.ok(restoreCmds.some((c) => c.includes('setdnsservers "Wi-Fi" 8.8.8.8 1.1.1.1')));
  });

  it("falls back to DHCP when no original DNS is cached", () => {
    const dns = freshDns();
    dns._serversByService = { "Wi-Fi": [] }; // DHCP
    const restoreCmds = dns.getRestoreCommands();

    assert.ok(restoreCmds.some((c) => c.includes('setdnsservers "Wi-Fi" Empty')));
  });

  it("stores DNS per-service so interface switches don't lose data", () => {
    const dns = freshDns();

    // Save DNS for multiple interfaces
    dns._serversByService = {
      "Wi-Fi": ["8.8.8.8", "8.8.4.4"],
      "Ethernet": ["9.9.9.9"],
    };

    // Switch to Ethernet
    dns._service = "Ethernet";
    const ethRestore = dns.getRestoreCommands();
    assert.ok(ethRestore.some((c) => c.includes('setdnsservers "Ethernet" 9.9.9.9')));

    // Switch back to Wi-Fi
    dns._service = "Wi-Fi";
    const wifiRestore = dns.getRestoreCommands();
    assert.ok(wifiRestore.some((c) => c.includes('setdnsservers "Wi-Fi" 8.8.8.8 8.8.4.4')));
  });

  it("includes stale-gateway telemetry in restore path", () => {
    const routes = freshRoutes();
    const fnSource = routes._restoreDarwin.toString();
    assert.ok(fnSource.includes("[telemetry] route_stale_gateway"));
    assert.ok(fnSource.includes("saved="));
    assert.ok(fnSource.includes("current="));
  });

  it("full cycle does not mutate saved state", async () => {
    const routes = freshRoutes();
    const dns = freshDns();

    const applyCmds = routes.getApplyCommands("10.0.85.1", "45.67.89.10");
    const dnsApplyCmds = dns.getApplyCommands ? dns.getApplyCommands() : [];
    await mockElevatedBatch([...applyCmds, ...dnsApplyCmds]);

    const restoreCmds = routes.getRestoreCommands();
    const dnsRestoreCmds = dns.getRestoreCommands();
    await mockElevatedBatch([...restoreCmds, ...dnsRestoreCmds]);

    // Saved state should be unchanged
    assert.strictEqual(routes._originalGateway, "192.168.1.1");
    assert.strictEqual(routes._vpnServerIp, "45.67.89.10");
    assert.deepStrictEqual(dns._serversByService["Wi-Fi"], ["8.8.8.8", "1.1.1.1"]);

    // Verify the full cycle generated both apply and restore commands
    assert.ok(capturedCommands.some((c) => c.includes("route add -host")),
      "Should have applied VPN server route");
    assert.ok(capturedCommands.some((c) => c.includes("route change default")),
      "Should have changed default route");
    assert.ok(capturedCommands.some((c) => c.includes("setdnsservers")),
      "Should have applied DNS");
    assert.ok(capturedCommands.some((c) => c.includes("route delete -host")),
      "Should have deleted VPN server route on restore");
  });
});
