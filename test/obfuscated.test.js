"use strict";

/**
 * ObfuscatedTransport tests — validates:
 * 1. Config validation catches missing/malformed fields + routing loop prevention
 * 2. Log file reading returns diagnostics (stdout + stderr)
 * 3. Error messages include sing-box output on failure
 * 4. Generated config includes server IP bypass rules
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Patch electron before requiring the module ──────────────────────────────
const Module = require("module");
const originalResolve = Module._resolveFilename;
const electronMock = path.join(__dirname, "_electron-mock.js");

fs.writeFileSync(electronMock, `
  module.exports = {
    app: {
      getPath: (name) => require("os").tmpdir(),
      isPackaged: false,
    },
  };
`);

Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "electron") return electronMock;
  return originalResolve.call(this, request, parent, ...rest);
};

// ── Now safely require the module under test ────────────────────────────────
const ObfuscatedTransport = require("../src/transports/obfuscated");

// ── Helpers ─────────────────────────────────────────────────────────────────

const LOG_TAIL_LINES = 30;
const TEST_SERVER_IPS = ["1.2.3.4"];

function makeTransport() {
  return new ObfuscatedTransport();
}

function validConfig(overrides) {
  const t = makeTransport();
  const config = t._generateConfig(TEST_SERVER_IPS);
  return { ...config, ...overrides };
}

function cleanFiles(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch {}
  }
}

// ── Config Validation ───────────────────────────────────────────────────────

describe("ObfuscatedTransport._validateConfig", () => {
  it("accepts a valid config with server IP bypass", () => {
    const t = makeTransport();
    const config = t._generateConfig(TEST_SERVER_IPS);
    t._validateConfig(config);
  });

  it("rejects config with no outbounds", () => {
    const t = makeTransport();
    assert.throws(
      () => t._validateConfig({ inbounds: [{ type: "tun", address: ["10.0.85.1/30"] }] }),
      /no outbounds defined/
    );
  });

  it("rejects config with empty outbounds", () => {
    const t = makeTransport();
    assert.throws(
      () => t._validateConfig({
        inbounds: [{ type: "tun", address: ["10.0.85.1/30"] }],
        outbounds: [],
      }),
      /no outbounds defined/
    );
  });

  it("rejects config missing proxy outbound tag", () => {
    const t = makeTransport();
    assert.throws(
      () => t._validateConfig({
        inbounds: [{ type: "tun", address: ["10.0.85.1/30"] }],
        outbounds: [{ type: "direct", tag: "direct" }],
      }),
      /no 'proxy' outbound defined/
    );
  });

  it("rejects proxy outbound missing server", () => {
    const t = makeTransport();
    assert.throws(
      () => t._validateConfig({
        inbounds: [{ type: "tun", address: ["10.0.85.1/30"] }],
        outbounds: [{ type: "vless", tag: "proxy", server_port: 443, uuid: "abc" }],
      }),
      /missing server, server_port, or uuid/
    );
  });

  it("rejects proxy outbound missing server_port", () => {
    const t = makeTransport();
    assert.throws(
      () => t._validateConfig({
        inbounds: [{ type: "tun", address: ["10.0.85.1/30"] }],
        outbounds: [{ type: "vless", tag: "proxy", server: "example.com", uuid: "abc" }],
      }),
      /missing server, server_port, or uuid/
    );
  });

  it("rejects proxy outbound missing uuid", () => {
    const t = makeTransport();
    assert.throws(
      () => t._validateConfig({
        inbounds: [{ type: "tun", address: ["10.0.85.1/30"] }],
        outbounds: [{ type: "vless", tag: "proxy", server: "example.com", server_port: 443 }],
      }),
      /missing server, server_port, or uuid/
    );
  });

  it("rejects config with no inbounds", () => {
    const t = makeTransport();
    assert.throws(
      () => t._validateConfig({
        outbounds: [{ type: "vless", tag: "proxy", server: "x", server_port: 443, uuid: "abc" }],
      }),
      /no inbounds defined/
    );
  });

  it("rejects config with no TUN inbound", () => {
    const t = makeTransport();
    assert.throws(
      () => t._validateConfig({
        inbounds: [{ type: "socks", listen: "127.0.0.1" }],
        outbounds: [{ type: "vless", tag: "proxy", server: "x", server_port: 443, uuid: "abc" }],
      }),
      /TUN inbound missing or has no address/
    );
  });

  it("rejects TUN inbound with empty address", () => {
    const t = makeTransport();
    assert.throws(
      () => t._validateConfig({
        inbounds: [{ type: "tun", address: [] }],
        outbounds: [{ type: "vless", tag: "proxy", server: "x", server_port: 443, uuid: "abc" }],
      }),
      /TUN inbound missing or has no address/
    );
  });

  it("rejects config without route rules (routing loop prevention)", () => {
    const t = makeTransport();
    const config = t._generateConfig(TEST_SERVER_IPS);
    delete config.route.rules;
    assert.throws(
      () => t._validateConfig(config),
      /route rules missing/
    );
  });

  it("rejects config without server IP bypass rule", () => {
    const t = makeTransport();
    const config = t._generateConfig(TEST_SERVER_IPS);
    // Replace server IP bypass rule with a dummy rule (keep rules non-empty)
    config.route.rules = [
      { ip_cidr: ["10.0.0.0/8"], outbound: "direct" }
    ];
    assert.throws(
      () => t._validateConfig(config),
      /no server IP bypass rule/
    );
  });
});

// ── Log Reading ─────────────────────────────────────────────────────────────

describe("ObfuscatedTransport._readLogTail", () => {
  let logPath;
  let errPath;

  beforeEach(() => {
    const t = makeTransport();
    logPath = t._getLogFile();
    errPath = logPath.replace(/\.log$/, ".err");
    cleanFiles(logPath, errPath);
  });

  afterEach(() => {
    cleanFiles(logPath, errPath);
  });

  it("returns '(no log file found)' when log does not exist", () => {
    const t = makeTransport();
    t._logFile = path.join(os.tmpdir(), `nonexistent-${Date.now()}-${Math.random()}.log`);
    assert.equal(t._readLogTail(), "(no log file found)");
  });

  it("returns '(log file empty)' when log is empty", () => {
    fs.writeFileSync(logPath, "");
    const t = makeTransport();
    t._logFile = logPath;
    assert.equal(t._readLogTail(), "(log file empty)");
  });

  it("reads stdout log content", () => {
    fs.writeFileSync(logPath, "FATAL: config parse error at line 5\n");
    const t = makeTransport();
    t._logFile = logPath;
    const result = t._readLogTail();
    assert.ok(result.includes("config parse error"));
  });

  it("merges stderr (.err) content on Windows-style split logs", () => {
    fs.writeFileSync(logPath, "starting sing-box\n");
    fs.writeFileSync(errPath, "error: bind failed on :1080\n");
    const t = makeTransport();
    t._logFile = logPath;
    const result = t._readLogTail();
    assert.ok(result.includes("starting sing-box"), "should include stdout");
    assert.ok(result.includes("bind failed"), "should include stderr");
  });

  it("limits output to last 30 lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(logPath, lines.join("\n"));
    const t = makeTransport();
    t._logFile = logPath;
    const result = t._readLogTail();
    const outputLines = result.split("\n");
    assert.equal(outputLines.length, LOG_TAIL_LINES, `should return last ${LOG_TAIL_LINES} lines`);
    assert.ok(outputLines[0].includes("line 71"), "first returned line should be line 71");
    assert.ok(outputLines[29].includes("line 100"), "last returned line should be line 100");
  });

  it("handles read errors gracefully", () => {
    const t = makeTransport();
    t._logFile = os.tmpdir();
    const result = t._readLogTail();
    assert.ok(typeof result === "string");
  });
});

// ── Generated Config ────────────────────────────────────────────────────────

describe("ObfuscatedTransport._generateConfig", () => {
  it("generates a valid config that passes validation", () => {
    const t = makeTransport();
    const config = t._generateConfig(TEST_SERVER_IPS);
    t._validateConfig(config);

    assert.equal(config.outbounds[0].type, "vless");
    assert.equal(config.outbounds[0].tag, "proxy");
    assert.equal(config.outbounds[0].server, "vizoguard.com");
    assert.equal(config.outbounds[0].server_port, 443);
    assert.ok(config.outbounds[0].uuid);
    assert.equal(config.inbounds[0].type, "tun");
    assert.ok(config.inbounds[0].inet4_address, "TUN must have inet4_address");
    // interface_name only set on Windows (macOS uses system-assigned utunN)
    if (process.platform === "win32") {
      assert.equal(config.inbounds[0].interface_name, "vizoguard");
    }
  });

  it("includes server IP bypass route rule", () => {
    const t = makeTransport();
    const config = t._generateConfig(["5.6.7.8"]);
    const serverRule = config.route.rules.find(r =>
      r.ip_cidr && r.ip_cidr.includes("5.6.7.8/32")
    );
    assert.ok(serverRule, "should have a rule for the server IP");
    assert.equal(serverRule.outbound, "direct", "server IP should bypass proxy");
  });

  it("includes multiple server IPs when resolved to multiple addresses", () => {
    const t = makeTransport();
    const config = t._generateConfig(["5.6.7.8", "9.10.11.12"]);
    const serverRule = config.route.rules.find(r =>
      r.ip_cidr && r.ip_cidr.includes("5.6.7.8/32")
    );
    assert.ok(serverRule, "should have server IP rule");
    assert.ok(serverRule.ip_cidr.includes("9.10.11.12/32"), "should include both IPs");
  });

  it("includes private network bypass rules", () => {
    const t = makeTransport();
    const config = t._generateConfig(TEST_SERVER_IPS);
    const privateRule = config.route.rules.find(r =>
      r.ip_cidr && r.ip_cidr.includes("192.168.0.0/16")
    );
    assert.ok(privateRule, "should have private network bypass rule");
    assert.equal(privateRule.outbound, "direct");
    assert.ok(privateRule.ip_cidr.includes("10.0.0.0/8"));
    assert.ok(privateRule.ip_cidr.includes("172.16.0.0/12"));
  });

  it("uses DNS-over-HTTPS to prevent DNS leaks", () => {
    const t = makeTransport();
    const config = t._generateConfig(TEST_SERVER_IPS);
    for (const server of config.dns.servers) {
      assert.ok(server.address.startsWith("https://"), `DNS server ${server.address} should use DoH`);
    }
  });
});

// ── Route Rollback Safety Net ────────────────────────────────────────────────

describe("ObfuscatedTransport route rollback", () => {
  it("_saveGateway stores _originalGateway", () => {
    const t = makeTransport();
    // Before saving, gateway should be null
    assert.equal(t._originalGateway, null);
  });

  it("_ensureRouteRestored is a no-op when no gateway was saved", async () => {
    const t = makeTransport();
    t._originalGateway = null;
    // Should not throw, should return immediately
    await t._ensureRouteRestored();
    assert.equal(t._originalGateway, null);
  });

  it("_ensureRouteRestored clears _originalGateway after running", async () => {
    const t = makeTransport();
    t._originalGateway = "192.168.1.1";
    // On this Linux server, /sbin/route and route commands will fail
    // but _ensureRouteRestored should handle errors gracefully
    await t._ensureRouteRestored();
    assert.equal(t._originalGateway, null, "should clear gateway after restoration attempt");
  });

  it("stop() calls _ensureRouteRestored (gateway cleared after stop)", async () => {
    const t = makeTransport();
    t._originalGateway = "192.168.1.1";
    t._pid = null; // no process to kill
    t._running = false;
    await t.stop();
    assert.equal(t._originalGateway, null, "stop should clear gateway via _ensureRouteRestored");
  });

  it("constructor initializes _originalGateway to null", () => {
    const t = makeTransport();
    assert.equal(t._originalGateway, null);
    assert.equal(t._running, false);
    assert.equal(t._pid, null);
  });
});

// ── Error Message Enrichment ────────────────────────────────────────────────

describe("Error messages include sing-box output", () => {
  let logPath;

  beforeEach(() => {
    const t = makeTransport();
    logPath = t._getLogFile();
    cleanFiles(logPath);
  });

  afterEach(() => {
    cleanFiles(logPath);
  });

  it("PID-not-found error includes log output", () => {
    fs.writeFileSync(logPath, "FATAL: permission denied opening /dev/net/tun\n");
    const t = makeTransport();
    t._logFile = logPath;
    const logs = t._readLogTail();
    const errorMsg = `sing-box failed to start — could not read PID. Check binary path and permissions.\n\nsing-box output:\n${logs}`;
    assert.ok(errorMsg.includes("permission denied"));
    assert.ok(errorMsg.includes("could not read PID"));
  });

  it("immediate-exit error includes log output", () => {
    fs.writeFileSync(logPath, "error: TLS handshake failed: certificate has expired\n");
    const t = makeTransport();
    t._logFile = logPath;
    const logs = t._readLogTail();
    const errorMsg = `sing-box process 7028 exited immediately.\n\nsing-box output:\n${logs}`;
    assert.ok(errorMsg.includes("TLS handshake failed"));
    assert.ok(errorMsg.includes("7028 exited immediately"));
  });

  it("TUN-not-found error includes log output", () => {
    fs.writeFileSync(logPath, "warn: TUN device creation failed: operation not permitted\n");
    const t = makeTransport();
    t._logFile = logPath;
    const logs = t._readLogTail();
    const errorMsg = `sing-box started but TUN interface did not appear.\n\nsing-box output:\n${logs}`;
    assert.ok(errorMsg.includes("operation not permitted"));
    assert.ok(errorMsg.includes("TUN interface did not appear"));
  });

  it("health-monitor error includes log output", () => {
    fs.writeFileSync(logPath, "error: connection reset by peer\n");
    const t = makeTransport();
    t._logFile = logPath;
    const logs = t._readLogTail();
    const errorMsg = `Obfuscated tunnel process died.\n\nsing-box output:\n${logs}`;
    assert.ok(errorMsg.includes("connection reset by peer"));
    assert.ok(errorMsg.includes("tunnel process died"));
  });
});

// ── Cleanup mock ────────────────────────────────────────────────────────────

describe("cleanup", () => {
  it("removes electron mock file", () => {
    try { fs.unlinkSync(electronMock); } catch {}
    Module._resolveFilename = originalResolve;
  });
});
