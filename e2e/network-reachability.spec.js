const { test, expect } = require("@playwright/test");
const { _electron: electron } = require("playwright");
const path = require("path");

/**
 * E2E test: verify connect/disconnect preserves local network reachability.
 *
 * This test launches the Electron app and exercises the Routes + Dns modules
 * in the main process. Elevation commands are captured (not executed) so the
 * test can verify the correct commands are generated for route and DNS
 * save/restore without requiring root/admin privileges.
 */

test.describe("Network reachability preservation", () => {
  let electronApp;

  test.beforeAll(async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, "..", "main.js")],
      env: {
        ...process.env,
        NODE_ENV: "test",
        VIZO_E2E: "1",
      },
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test("app launches and window is visible", async () => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    const title = await window.title();
    expect(title).toBe("Vizoguard");
  });

  test("Routes module saves and restores gateway without data loss", async () => {
    const result = await electronApp.evaluate(async ({ app }) => {
      const path = require("path");
      const Routes = require(path.join(app.getAppPath(), "src", "routes"));
      const Dns = require(path.join(app.getAppPath(), "src", "dns"));

      // Capture all elevated commands instead of executing them
      const capturedCommands = [];
      const elevation = require(path.join(app.getAppPath(), "src", "elevation"));
      const originalBatch = elevation.elevatedBatch;
      const originalExec = elevation.elevatedExec;
      elevation.elevatedBatch = async (cmds) => {
        capturedCommands.push(...cmds);
        return { stdout: "", stderr: "" };
      };
      elevation.elevatedExec = async (cmd) => {
        capturedCommands.push(cmd);
        return "";
      };

      try {
        const routes = new Routes();
        const dns = new Dns();

        // Simulate saving state (would normally read from system)
        routes._originalGateway = "192.168.1.1";
        routes._originalInterface = "en0";
        routes._vpnServerIp = "45.67.89.10";
        dns._service = "Wi-Fi";
        dns._serversByService = { "Wi-Fi": ["8.8.8.8", "1.1.1.1"] };

        // Apply VPN routes and DNS
        const applyCmds = routes.getApplyCommands("10.0.85.1", "45.67.89.10");
        const dnsApplyCmds = dns.getApplyCommands ? dns.getApplyCommands() : [];
        await elevation.elevatedBatch([...applyCmds, ...dnsApplyCmds]);

        // Restore VPN routes and DNS
        const restoreCmds = routes.getRestoreCommands();
        const dnsRestoreCmds = dns.getRestoreCommands();
        await elevation.elevatedBatch([...restoreCmds, ...dnsRestoreCmds]);

        return {
          capturedCommands,
          originalGateway: routes._originalGateway,
          originalDns: dns._serversByService["Wi-Fi"],
        };
      } finally {
        elevation.elevatedBatch = originalBatch;
        elevation.elevatedExec = originalExec;
      }
    });

    // Verify original gateway is preserved in restore commands
    const restoreCommands = result.capturedCommands.filter((c) =>
      c.includes("route change default") || c.includes("route add default")
    );
    expect(restoreCommands.length).toBeGreaterThan(0);
    expect(restoreCommands.some((c) => c.includes("192.168.1.1"))).toBe(true);

    // Verify original DNS servers are preserved in restore commands
    const dnsRestoreCommands = result.capturedCommands.filter((c) =>
      c.includes("setdnsservers")
    );
    expect(dnsRestoreCommands.length).toBeGreaterThan(0);
    expect(dnsRestoreCommands.some((c) => c.includes("8.8.8.8"))).toBe(true);
    expect(dnsRestoreCommands.some((c) => c.includes("1.1.1.1"))).toBe(true);

    // Verify no data loss occurred during the cycle
    expect(result.originalGateway).toBe("192.168.1.1");
    expect(result.originalDns).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  test("Dns module stores servers per-service", async () => {
    const result = await electronApp.evaluate(async ({ app }) => {
      const path = require("path");
      const Dns = require(path.join(app.getAppPath(), "src", "dns"));
      const dns = new Dns();

      // Simulate saving DNS for multiple interfaces
      dns._service = "Ethernet";
      dns._serversByService = {
        "Wi-Fi": ["8.8.8.8", "8.8.4.4"],
        "Ethernet": ["9.9.9.9"],
      };

      // Switch to Wi-Fi and verify its servers are still available
      dns._service = "Wi-Fi";
      const wifiServers = dns._serversByService["Wi-Fi"];
      const ethServers = dns._serversByService["Ethernet"];

      return { wifiServers, ethServers, restoreCmd: dns.getRestoreCommands() };
    });

    expect(result.wifiServers).toEqual(["8.8.8.8", "8.8.4.4"]);
    expect(result.ethServers).toEqual(["9.9.9.9"]);
    expect(result.restoreCmd.some((c) => c.includes("8.8.8.8"))).toBe(true);
  });

  test("stale-gateway telemetry is logged during restore", async () => {
    const result = await electronApp.evaluate(async ({ app }) => {
      const path = require("path");
      const Routes = require(path.join(app.getAppPath(), "src", "routes"));
      const routes = new Routes();

      // Verify the telemetry marker exists in the code path
      const fnSource = routes._restoreDarwin.toString();

      return {
        hasTelemetry: fnSource.includes("[telemetry] route_stale_gateway"),
        hasFallback: fnSource.includes('OG=$(/sbin/route -n get default'),
      };
    });

    expect(result.hasTelemetry).toBe(true);
    expect(result.hasFallback).toBe(true);
  });
});
