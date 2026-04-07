"use strict";

/**
 * ConnectionManager tests — validates:
 * 1. Explicit mode selection (direct / obfuscated)
 * 2. Auto mode with probe, fallback, and cache
 * 3. Connect/disconnect/emergencyStop lifecycle
 * 4. Event emission and internal state flags
 */

const { EventEmitter } = require("events");
const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const ConnectionManager = require("../src/connection-manager");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTransport(name, opts = {}) {
  const t = new EventEmitter();
  t.name = name;
  t.isRunning = false;
  t.test = mock.fn(async (timeout) =>
    opts.testResult !== undefined ? opts.testResult : true
  );
  t.start = mock.fn(async () => {
    if (opts.startFails) throw new Error(`${name} start failed`);
    t.isRunning = true;
  });
  t.stop = mock.fn(async () => {
    t.isRunning = false;
  });
  return t;
}

function makeStore(data = {}) {
  return {
    get(key, defaultVal) {
      return key in data ? data[key] : defaultVal;
    },
    set(key, val) {
      data[key] = val;
    },
  };
}

// ── Explicit Mode Selection ────────────────────────────────────────────────

describe("ConnectionManager — explicit mode", () => {
  it("direct mode starts only direct transport", async () => {
    const direct = makeTransport("direct");
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obfuscated, store);

    await cm.connect();

    assert.equal(direct.start.mock.callCount(), 1, "direct.start should be called");
    assert.equal(obfuscated.start.mock.callCount(), 0, "obfuscated.start should NOT be called");
    assert.equal(cm.isConnected, true);
    assert.equal(cm.activeMode, "direct");
  });

  it("obfuscated mode starts only obfuscated transport", async () => {
    const direct = makeTransport("direct");
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "obfuscated" });
    const cm = new ConnectionManager(direct, obfuscated, store);

    await cm.connect();

    assert.equal(obfuscated.start.mock.callCount(), 1, "obfuscated.start should be called");
    assert.equal(direct.start.mock.callCount(), 0, "direct.start should NOT be called");
    assert.equal(cm.isConnected, true);
    assert.equal(cm.activeMode, "obfuscated");
  });
});

// ── Auto Mode ──────────────────────────────────────────────────────────────

describe("ConnectionManager — auto mode", () => {
  it("uses direct when probe succeeds", async () => {
    const direct = makeTransport("direct", { testResult: true });
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore();
    const cm = new ConnectionManager(direct, obfuscated, store);
    cm._getNetworkCacheKey = async () => "test-network-hash";

    await cm.connect();

    assert.equal(direct.test.mock.callCount(), 1, "direct.test should be called");
    assert.equal(direct.test.mock.calls[0].arguments[0], 5000, "probe timeout should be 5000");
    assert.equal(direct.start.mock.callCount(), 1, "direct.start should be called");
    assert.equal(obfuscated.start.mock.callCount(), 0, "obfuscated.start should NOT be called");
  });

  it("falls back to obfuscated when direct probe fails", async () => {
    const direct = makeTransport("direct", { testResult: false });
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore();
    const cm = new ConnectionManager(direct, obfuscated, store);
    cm._getNetworkCacheKey = async () => "test-network-hash";

    await cm.connect();

    assert.equal(direct.test.mock.callCount(), 1, "direct.test should be called");
    assert.equal(direct.start.mock.callCount(), 0, "direct.start should NOT be called");
    assert.equal(obfuscated.start.mock.callCount(), 1, "obfuscated.start should be called");
    assert.equal(cm.activeMode, "obfuscated");
  });

  it("falls back to obfuscated when direct start throws", async () => {
    const direct = makeTransport("direct", { testResult: true, startFails: true });
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore();
    const cm = new ConnectionManager(direct, obfuscated, store);
    cm._getNetworkCacheKey = async () => "test-network-hash";

    await cm.connect();

    assert.equal(direct.start.mock.callCount(), 1, "direct.start should be called (and fail)");
    assert.equal(obfuscated.start.mock.callCount(), 1, "obfuscated.start should be called as fallback");
    assert.equal(cm.activeMode, "obfuscated");
  });

  it("throws when both transports fail", async () => {
    const direct = makeTransport("direct", { testResult: false });
    const obfuscated = makeTransport("obfuscated", { startFails: true });
    const store = makeStore();
    const cm = new ConnectionManager(direct, obfuscated, store);
    cm._getNetworkCacheKey = async () => "test-network-hash";

    await assert.rejects(
      () => cm.connect(),
      /Both transport modes failed/
    );
  });

  it("uses cached transport without probing", async () => {
    const direct = makeTransport("direct");
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore({
      "transportCache.test-network-hash": {
        mode: "direct",
        ts: new Date().toISOString(),
      },
    });
    const cm = new ConnectionManager(direct, obfuscated, store);
    cm._getNetworkCacheKey = async () => "test-network-hash";

    await cm.connect();

    assert.equal(direct.test.mock.callCount(), 0, "direct.test should NOT be called (cache hit)");
    assert.equal(direct.start.mock.callCount(), 1, "direct.start should be called from cache");
    assert.equal(cm.activeMode, "direct");
  });
});

// ── Already Connected / Connecting Guards ──────────────────────────────────

describe("ConnectionManager — guard conditions", () => {
  it("no-ops when already connected", async () => {
    const direct = makeTransport("direct");
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obfuscated, store);

    // First connect
    await cm.connect();
    assert.equal(direct.start.mock.callCount(), 1);

    // Second connect should no-op
    await cm.connect();
    assert.equal(direct.start.mock.callCount(), 1, "start should not be called again");
  });

  it("no-ops when already connecting", async () => {
    const direct = makeTransport("direct");
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obfuscated, store);

    cm._connecting = true;
    await cm.connect();

    assert.equal(direct.start.mock.callCount(), 0, "start should not be called when _connecting is true");
  });
});

// ── Disconnect ─────────────────────────────────────────────────────────────

describe("ConnectionManager — disconnect", () => {
  it("stops active transport and clears state", async () => {
    const direct = makeTransport("direct");
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obfuscated, store);

    await cm.connect();
    assert.equal(cm.isConnected, true);

    await cm.disconnect();

    assert.equal(direct.stop.mock.callCount(), 1, "direct.stop should be called");
    assert.equal(cm._active, null, "_active should be null");
    assert.equal(cm.isConnected, false);
  });

  it("sets _aborted during connect", async () => {
    // Use a transport that delays its start
    const direct = new EventEmitter();
    direct.name = "direct";
    direct.isRunning = false;
    direct.test = mock.fn(async () => true);
    direct.start = mock.fn(async () => {
      // Simulate slow start
      await new Promise((resolve) => setTimeout(resolve, 100));
      direct.isRunning = true;
    });
    direct.stop = mock.fn(async () => {
      direct.isRunning = false;
    });

    const obfuscated = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obfuscated, store);

    const connectPromise = cm.connect();

    // Disconnect immediately while connect is in progress
    await cm.disconnect();
    assert.equal(cm._aborted, true, "_aborted should be true");

    // Wait for connect to finish
    await connectPromise;
  });
});

// ── Emergency Stop ─────────────────────────────────────────────────────────

describe("ConnectionManager — emergencyStop", () => {
  it("stops both transports and clears _active", async () => {
    const direct = makeTransport("direct");
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore();
    const cm = new ConnectionManager(direct, obfuscated, store);

    await cm.emergencyStop();

    assert.equal(direct.stop.mock.callCount(), 1, "direct.stop should be called");
    assert.equal(obfuscated.stop.mock.callCount(), 1, "obfuscated.stop should be called");
    assert.equal(cm._active, null, "_active should be null");
  });
});

// ── Events ─────────────────────────────────────────────────────────────────

describe("ConnectionManager — events", () => {
  it("emits 'connected' with mode after successful connect", async () => {
    const direct = makeTransport("direct");
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obfuscated, store);

    const events = [];
    cm.on("connected", (data) => events.push(data));

    await cm.connect();

    assert.equal(events.length, 1, "connected event should fire once");
    assert.deepEqual(events[0], { mode: "direct" });
  });
});

// ── Internal State ─────────────────────────────────────────────────────────

describe("ConnectionManager — internal state", () => {
  it("_connecting is false after connect rejects", async () => {
    const direct = makeTransport("direct", { testResult: false });
    const obfuscated = makeTransport("obfuscated", { startFails: true });
    const store = makeStore();
    const cm = new ConnectionManager(direct, obfuscated, store);
    cm._getNetworkCacheKey = async () => "test-network-hash";

    try {
      await cm.connect();
    } catch {
      // expected
    }

    assert.equal(cm._connecting, false, "_connecting should be reset in finally block");
  });

  it("activeMode returns transport name when connected, null when disconnected", async () => {
    const direct = makeTransport("direct");
    const obfuscated = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obfuscated, store);

    assert.equal(cm.activeMode, null, "activeMode should be null before connect");

    await cm.connect();
    assert.equal(cm.activeMode, "direct", "activeMode should be 'direct' after connect");

    await cm.disconnect();
    assert.equal(cm.activeMode, null, "activeMode should be null after disconnect");
  });
});
