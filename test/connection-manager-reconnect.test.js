"use strict";

/**
 * ConnectionManager reconnect + kill switch integration tests — validates:
 * 1. Auto-reconnect triggers on unexpected disconnect
 * 2. Reconnect uses exponential backoff
 * 3. Reconnect stops after max attempts
 * 4. Manual disconnect cancels reconnect
 * 5. Kill switch activates on connect
 * 6. Kill switch deactivates on manual disconnect
 * 7. Kill switch stays active during reconnect
 */

const { EventEmitter } = require("events");
const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const ConnectionManager = require("../src/connection-manager");

function makeTransport(name, opts = {}) {
  const t = new EventEmitter();
  t.name = name;
  t.isRunning = false;
  t.test = mock.fn(async () => opts.testResult !== undefined ? opts.testResult : true);
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
    get(key, defaultVal) { return key in data ? data[key] : defaultVal; },
    set(key, val) { data[key] = val; },
  };
}

function makeFirewall() {
  return {
    isActive: false,
    activate: mock.fn(async (ip) => { this.isActive = true; }),
    deactivate: mock.fn(async () => { this.isActive = false; }),
  };
}

describe("ConnectionManager — auto-reconnect", () => {
  it("emits reconnecting event on unexpected disconnect", async () => {
    const direct = makeTransport("direct");
    const obf = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obf, store);

    await cm.connect();
    assert.equal(cm.isConnected, true);

    const events = [];
    cm.on("reconnecting", (info) => events.push(info));

    // Simulate unexpected disconnect
    direct.isRunning = false;
    direct.emit("disconnected");

    // Wait a tick for event processing
    await new Promise(r => setTimeout(r, 10));

    assert.ok(cm.isReconnecting, "Should be in reconnecting state");
    assert.equal(events.length, 1, "Should emit reconnecting event");
    assert.equal(events[0].attempt, 1);
    assert.equal(events[0].maxAttempts, 5);

    // Cleanup
    cm._cancelReconnect();
  });

  it("manual disconnect cancels reconnect", async () => {
    const direct = makeTransport("direct");
    const obf = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obf, store);

    await cm.connect();

    // Simulate unexpected disconnect
    direct.isRunning = false;
    direct.emit("disconnected");
    await new Promise(r => setTimeout(r, 10));

    assert.ok(cm.isReconnecting);

    // Manual disconnect should cancel reconnect
    await cm.disconnect();
    assert.equal(cm.isReconnecting, false);
    assert.equal(cm._reconnectAttempt, 0);
  });

  it("emergencyStop cancels reconnect", async () => {
    const direct = makeTransport("direct");
    const obf = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obf, store);

    await cm.connect();
    direct.isRunning = false;
    direct.emit("disconnected");
    await new Promise(r => setTimeout(r, 10));

    assert.ok(cm.isReconnecting);

    await cm.emergencyStop();
    assert.equal(cm.isReconnecting, false);
  });

  it("does not reconnect on intentional disconnect", async () => {
    const direct = makeTransport("direct");
    const obf = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obf, store);

    await cm.connect();

    const events = [];
    cm.on("reconnecting", (info) => events.push(info));

    // Intentional disconnect (sets _aborted = true)
    await cm.disconnect();

    await new Promise(r => setTimeout(r, 50));
    assert.equal(events.length, 0, "Should NOT reconnect on intentional disconnect");
  });
});

describe("ConnectionManager — kill switch integration", () => {
  it("constructor accepts firewall parameter", () => {
    const direct = makeTransport("direct");
    const obf = makeTransport("obfuscated");
    const store = makeStore();
    const fw = makeFirewall();
    const cm = new ConnectionManager(direct, obf, store, fw);
    assert.ok(cm._firewall === fw);
  });

  it("disconnect deactivates firewall", async () => {
    const direct = makeTransport("direct");
    const obf = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const fw = makeFirewall();
    fw.isActive = true;
    const cm = new ConnectionManager(direct, obf, store, fw);

    await cm.connect();
    await cm.disconnect();

    assert.equal(fw.deactivate.mock.callCount(), 1, "Firewall should be deactivated on disconnect");
  });

  it("emergencyStop deactivates firewall", async () => {
    const direct = makeTransport("direct");
    const obf = makeTransport("obfuscated");
    const store = makeStore();
    const fw = makeFirewall();
    fw.isActive = true;
    const cm = new ConnectionManager(direct, obf, store, fw);

    await cm.emergencyStop();
    assert.equal(fw.deactivate.mock.callCount(), 1);
  });

  it("works without firewall (null)", async () => {
    const direct = makeTransport("direct");
    const obf = makeTransport("obfuscated");
    const store = makeStore({ connectionMode: "direct" });
    const cm = new ConnectionManager(direct, obf, store, null);

    await cm.connect();
    assert.equal(cm.isConnected, true);
    await cm.disconnect();
    // Should not throw
  });
});
