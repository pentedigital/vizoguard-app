"use strict";

/**
 * Blocklist auto-update tests — validates:
 * 1. startAutoUpdate sets timer
 * 2. stopAutoUpdate clears timer
 * 3. _fetchBlocklist validates minimum entry count
 * 4. _fetchBlocklist atomically swaps blocklist
 * 5. _fetchBlocklist clears URL cache after update
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { ThreatChecker } = require("../src/core");

describe("ThreatChecker — blocklist auto-update", () => {
  let tc;
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vizoguard-test-"));
    tc = new ThreatChecker(dataDir);
  });

  it("startAutoUpdate sets _updateTimer", () => {
    tc.startAutoUpdate();
    assert.ok(tc._updateTimer !== null && tc._updateTimer !== undefined, "Timer should be set");
    tc.stopAutoUpdate();
  });

  it("stopAutoUpdate clears _updateTimer", () => {
    tc.startAutoUpdate();
    tc.stopAutoUpdate();
    assert.equal(tc._updateTimer, null, "Timer should be cleared");
  });

  it("double startAutoUpdate is idempotent", () => {
    tc.startAutoUpdate();
    const timer1 = tc._updateTimer;
    tc.startAutoUpdate();
    assert.equal(tc._updateTimer, timer1, "Timer should not change on double start");
    tc.stopAutoUpdate();
  });

  it("_fetchBlocklist rejects files with too few entries", async () => {
    // Mock https.get to return a small blocklist
    const https = require("https");
    const origGet = https.get;
    https.get = (url, cb) => {
      const res = {
        statusCode: 200,
        on: (event, handler) => {
          if (event === "data") handler("bad.com\nevil.com\n");
          if (event === "end") handler();
        },
        resume: () => {},
      };
      cb(res);
      return { setTimeout: () => {}, on: () => {}, destroy: () => {} };
    };

    const origSize = tc._blocklist.size;
    await tc._fetchBlocklist();

    // Blocklist should NOT have been updated (too few entries)
    assert.equal(tc._blocklist.size, origSize, "Blocklist should not update with <10 entries");

    https.get = origGet;
  });

  it("_fetchBlocklist clears URL cache after successful update", async () => {
    // Populate cache
    tc._cache.set("https://test.com", { result: { risk: "low" }, time: Date.now() });
    assert.equal(tc._cache.size, 1);

    // Mock https.get to return valid blocklist
    const https = require("https");
    const origGet = https.get;
    const domains = Array.from({ length: 15 }, (_, i) => `malicious${i}.com`).join("\n");
    https.get = (url, cb) => {
      const res = {
        statusCode: 200,
        on: (event, handler) => {
          if (event === "data") handler(domains);
          if (event === "end") handler();
        },
        resume: () => {},
      };
      cb(res);
      return { setTimeout: () => {}, on: () => {}, destroy: () => {} };
    };

    await tc._fetchBlocklist();
    assert.equal(tc._cache.size, 0, "Cache should be cleared after blocklist update");
    assert.equal(tc._blocklist.size, 15, "Blocklist should have 15 entries");

    https.get = origGet;
  });

  it("_fetchBlocklist handles network errors gracefully", async () => {
    const https = require("https");
    const origGet = https.get;
    https.get = (url, cb) => {
      return {
        setTimeout: () => {},
        on: (event, handler) => {
          if (event === "error") setTimeout(() => handler(new Error("Network error")), 0);
        },
        destroy: () => {},
      };
    };

    const origSize = tc._blocklist.size;
    // Should not throw
    await tc._fetchBlocklist();
    assert.equal(tc._blocklist.size, origSize, "Blocklist should be unchanged after error");

    https.get = origGet;
  });
});
