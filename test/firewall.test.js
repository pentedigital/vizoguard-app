"use strict";

/**
 * Firewall (kill switch) tests — validates:
 * 1. Activation sets _active flag and stores server IP
 * 2. Deactivation clears state
 * 3. Double-activate deactivates first
 * 4. Deactivate is no-op when inactive
 * 5. Platform-specific command generation (mocked)
 */

const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// Mock elevation module before requiring Firewall
const elevationMock = {
  elevatedExec: mock.fn(async () => ({ stdout: "", stderr: "" })),
  elevatedBatch: mock.fn(async () => ({ stdout: "", stderr: "" })),
};

// Inject mock
const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent) {
  if (request === "../elevation" || request === "./elevation") {
    return require.resolve("../src/elevation");
  }
  return originalResolve.apply(this, arguments);
};

// Monkey-patch the cache entry for elevation
require.cache[require.resolve("../src/elevation")] = {
  id: require.resolve("../src/elevation"),
  filename: require.resolve("../src/elevation"),
  loaded: true,
  exports: elevationMock,
};

// Mock electron app
require.cache[require.resolve("electron")] = {
  id: "electron",
  filename: "electron",
  loaded: true,
  exports: {
    app: {
      getPath: () => "/tmp",
      isPackaged: false,
    },
  },
};

const Firewall = require("../src/firewall");

describe("Firewall — kill switch", () => {
  let fw;

  beforeEach(() => {
    fw = new Firewall();
    elevationMock.elevatedExec.mock.resetCalls();
    elevationMock.elevatedBatch.mock.resetCalls();
  });

  it("starts inactive", () => {
    assert.equal(fw.isActive, false);
  });

  it("activate sets state and stores VPN server IP", async () => {
    await fw.activate("1.2.3.4");
    assert.equal(fw.isActive, true);
    assert.equal(fw._vpnServerIp, "1.2.3.4");
  });

  it("deactivate clears state", async () => {
    await fw.activate("1.2.3.4");
    await fw.deactivate();
    assert.equal(fw.isActive, false);
    assert.equal(fw._vpnServerIp, null);
  });

  it("deactivate is no-op when inactive", async () => {
    await fw.deactivate();
    assert.equal(fw.isActive, false);
    // No elevated commands should have been called
    assert.equal(elevationMock.elevatedExec.mock.callCount(), 0);
    assert.equal(elevationMock.elevatedBatch.mock.callCount(), 0);
  });

  it("double-activate deactivates first", async () => {
    await fw.activate("1.2.3.4");
    assert.equal(fw.isActive, true);
    await fw.activate("5.6.7.8");
    assert.equal(fw.isActive, true);
    assert.equal(fw._vpnServerIp, "5.6.7.8");
  });

  it("activation calls elevated commands", async () => {
    await fw.activate("10.20.30.40");
    // Should have called elevatedBatch or elevatedExec at least once
    const totalCalls = elevationMock.elevatedExec.mock.callCount() + elevationMock.elevatedBatch.mock.callCount();
    assert.ok(totalCalls > 0, "Should call elevated commands during activation");
  });

  it("deactivation calls elevated commands", async () => {
    await fw.activate("1.2.3.4");
    elevationMock.elevatedExec.mock.resetCalls();
    elevationMock.elevatedBatch.mock.resetCalls();
    await fw.deactivate();
    const totalCalls = elevationMock.elevatedExec.mock.callCount() + elevationMock.elevatedBatch.mock.callCount();
    assert.ok(totalCalls > 0, "Should call elevated commands during deactivation");
  });

  it("handles activation failure gracefully", async () => {
    elevationMock.elevatedBatch.mock.mockImplementation(async () => {
      throw new Error("Permission denied");
    });
    // Should not throw — activate catches errors internally
    await assert.rejects(() => fw.activate("1.2.3.4"));
    // Restore mock
    elevationMock.elevatedBatch.mock.mockImplementation(async () => ({ stdout: "", stderr: "" }));
  });
});
