"use strict";

/**
 * LicenseManager tests — validates:
 * 1. activate() key format validation, API calls, VPN provisioning, error handling
 * 2. validate() status handling (active, expired, suspended, device_mismatch, network errors, grace period)
 * 3. isGracePeriodValid() time-based checks
 * 4. isExpired() date-based checks
 * 5. transferToThisDevice(), startPeriodicCheck(), stopPeriodicCheck(), clear()
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// ── Mock api module via require.cache BEFORE requiring license.js ───────────

let mockApiCall;

const apiPath = require.resolve("../src/api");
// license.js destructures: const { apiCall } = require("./api")
// This captures the value once, so we export a wrapper function that delegates
// to mockApiCall at call time (not at require time).
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    apiCall: async (...args) => mockApiCall(...args),
  },
};

// ── Mock platform module ────────────────────────────────────────────────────

const platformPath = require.resolve("../src/platform");
require.cache[platformPath] = {
  id: platformPath,
  filename: platformPath,
  loaded: true,
  exports: { getDeviceId: async () => "test-device-123" },
};

// ── Now safely require the module under test ────────────────────────────────

const LicenseManager = require("../src/license");

// ── Mock store (supports dotted key notation like electron-store) ───────────

function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    get(key) {
      const parts = key.split(".");
      let val = data;
      for (const p of parts) {
        if (val == null || typeof val !== "object") return undefined;
        val = val[p];
      }
      return val;
    },
    set(key, val) {
      const parts = key.split(".");
      if (parts.length === 1) { data[key] = val; return; }
      let obj = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = val;
    },
    delete(key) {
      const parts = key.split(".");
      if (parts.length === 1) { delete data[key]; return; }
      let obj = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) return;
        obj = obj[parts[i]];
      }
      delete obj[parts[parts.length - 1]];
    },
    _data: data,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_KEY = "VIZO-1A2B-3C4D-5E6F-7890";
const FUTURE_DATE = "2027-01-01T00:00:00Z";
const PAST_DATE = "2020-01-01T00:00:00Z";

function defaultApiHandler(endpoint) {
  if (endpoint === "/license") return { status: "active", expires: FUTURE_DATE };
  if (endpoint === "/vpn/create") return { access_url: "ss://test@1.2.3.4:8388" };
  if (endpoint === "/vpn/get") return { access_url: "ss://test@1.2.3.4:8388" };
  if (endpoint === "/license/transfer") return { success: true };
  throw new Error(`Unexpected endpoint: ${endpoint}`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("LicenseManager", () => {
  beforeEach(() => {
    mockApiCall = async (endpoint, body) => defaultApiHandler(endpoint);
  });

  // ── activate() ──────────────────────────────────────────────────────────

  describe("activate()", () => {
    it("rejects invalid key format (too short)", async () => {
      const lm = new LicenseManager(makeStore());
      await assert.rejects(
        () => lm.activate("VIZO-1234"),
        { message: /Invalid license key format/ }
      );
    });

    it("rejects lowercase key", async () => {
      const lm = new LicenseManager(makeStore());
      await assert.rejects(
        () => lm.activate("VIZO-1a2b-3c4d-5e6f-7890"),
        { message: /Invalid license key format/ }
      );
    });

    it("successful activation stores license data", async () => {
      const store = makeStore();
      const lm = new LicenseManager(store);
      const result = await lm.activate(VALID_KEY);

      assert.equal(result.success, true);
      assert.equal(result.status, "active");
      assert.equal(result.expires, FUTURE_DATE);
      assert.equal(store.get("license.key"), VALID_KEY);
      assert.equal(store.get("license.deviceId"), "test-device-123");
      assert.equal(store.get("license.status"), "active");
      assert.equal(store.get("license.expires"), FUTURE_DATE);
      assert.ok(store.get("license.lastSuccessfulCheck"), "should store lastSuccessfulCheck");
    });

    it("successful activation provisions VPN key", async () => {
      const store = makeStore();
      const lm = new LicenseManager(store);
      await lm.activate(VALID_KEY);

      assert.equal(store.get("license.vpnAccessUrl"), "ss://test@1.2.3.4:8388");
    });

    it("VPN provisioning failure is non-fatal", async () => {
      mockApiCall = async (endpoint) => {
        if (endpoint === "/license") return { status: "active", expires: FUTURE_DATE };
        if (endpoint === "/vpn/create") throw new Error("VPN server unavailable");
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      };
      const store = makeStore();
      const lm = new LicenseManager(store);

      const result = await lm.activate(VALID_KEY);
      assert.equal(result.success, true);
      assert.equal(store.get("license.vpnAccessUrl"), null);
    });

    it("device_mismatch throws descriptive error", async () => {
      mockApiCall = async () => {
        throw { httpStatus: 403, status: "device_mismatch", error: "Device mismatch" };
      };
      const lm = new LicenseManager(makeStore());

      await assert.rejects(
        () => lm.activate(VALID_KEY),
        { message: /already activated on another device/ }
      );
    });

    it("other API error propagates", async () => {
      const apiErr = { httpStatus: 500, error: "Internal server error" };
      mockApiCall = async () => { throw apiErr; };
      const lm = new LicenseManager(makeStore());

      await assert.rejects(
        () => lm.activate(VALID_KEY),
        (err) => {
          assert.equal(err.httpStatus, 500);
          return true;
        }
      );
    });
  });

  // ── validate() ──────────────────────────────────────────────────────────

  describe("validate()", () => {
    it("no key stored returns no_license", async () => {
      const lm = new LicenseManager(makeStore());
      const result = await lm.validate();
      assert.deepStrictEqual(result, { valid: false, reason: "no_license" });
    });

    it("successful validation returns valid:true and updates store", async () => {
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "test-device-123",
          status: "active",
          expires: FUTURE_DATE,
          lastSuccessfulCheck: new Date().toISOString(),
          vpnAccessUrl: "ss://cached@1.2.3.4:8388",
        },
      });
      const lm = new LicenseManager(store);
      const result = await lm.validate();

      assert.equal(result.valid, true);
      assert.equal(result.status, "active");
      assert.equal(result.expires, FUTURE_DATE);
      // lastSuccessfulCheck should be updated
      assert.ok(store.get("license.lastSuccessfulCheck"));
    });

    it("403 expired deletes vpnAccessUrl and vlessUuid", async () => {
      mockApiCall = async () => {
        throw { httpStatus: 403, status: "expired", error: "License expired" };
      };
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "test-device-123",
          status: "active",
          vpnAccessUrl: "ss://old@1.2.3.4:8388",
          vlessUuid: "some-uuid",
        },
      });
      const lm = new LicenseManager(store);
      const result = await lm.validate();

      assert.deepStrictEqual(result, { valid: false, reason: "expired" });
      assert.equal(store.get("license.status"), "expired");
      assert.equal(store.get("license.vpnAccessUrl"), undefined);
      assert.equal(store.get("license.vlessUuid"), undefined);
    });

    it("403 suspended deletes vpnAccessUrl and vlessUuid", async () => {
      mockApiCall = async () => {
        throw { httpStatus: 403, status: "suspended", error: "License suspended" };
      };
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "test-device-123",
          status: "active",
          vpnAccessUrl: "ss://old@1.2.3.4:8388",
          vlessUuid: "some-uuid",
        },
      });
      const lm = new LicenseManager(store);
      const result = await lm.validate();

      assert.deepStrictEqual(result, { valid: false, reason: "suspended" });
      assert.equal(store.get("license.status"), "suspended");
      assert.equal(store.get("license.vpnAccessUrl"), undefined);
      assert.equal(store.get("license.vlessUuid"), undefined);
    });

    it("403 device_mismatch returns transferable", async () => {
      mockApiCall = async () => {
        throw { httpStatus: 403, status: "device_mismatch", error: "Wrong device" };
      };
      const store = makeStore({
        license: { key: VALID_KEY, deviceId: "test-device-123" },
      });
      const lm = new LicenseManager(store);
      const result = await lm.validate();

      assert.deepStrictEqual(result, { valid: false, reason: "device_mismatch", transferable: true });
    });

    it("403 unknown status returns invalid", async () => {
      mockApiCall = async () => {
        throw { httpStatus: 403, status: "revoked", error: "License revoked" };
      };
      const store = makeStore({
        license: { key: VALID_KEY, deviceId: "test-device-123" },
      });
      const lm = new LicenseManager(store);
      const result = await lm.validate();

      assert.deepStrictEqual(result, { valid: false, reason: "invalid" });
      assert.equal(store.get("license.status"), "invalid");
    });

    it("network error within grace period returns offline", async () => {
      mockApiCall = async () => { throw new Error("ECONNREFUSED"); };
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "test-device-123",
          status: "active",
          expires: FUTURE_DATE,
          lastSuccessfulCheck: new Date().toISOString(), // just now
        },
      });
      const lm = new LicenseManager(store);
      const result = await lm.validate();

      assert.equal(result.valid, true);
      assert.equal(result.status, "offline");
      assert.equal(result.expires, FUTURE_DATE);
    });

    it("network error beyond grace period returns grace_expired", async () => {
      mockApiCall = async () => { throw new Error("ECONNREFUSED"); };
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "test-device-123",
          status: "active",
          expires: FUTURE_DATE,
          lastSuccessfulCheck: eightDaysAgo,
        },
      });
      const lm = new LicenseManager(store);
      const result = await lm.validate();

      assert.deepStrictEqual(result, { valid: false, reason: "grace_expired" });
    });

    it("status recovery (suspended to active) clears VPN URL", async () => {
      mockApiCall = async (endpoint) => {
        if (endpoint === "/license") return { status: "active", expires: FUTURE_DATE };
        if (endpoint === "/vpn/get") return { access_url: "ss://new@1.2.3.4:8388" };
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      };
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "test-device-123",
          status: "suspended",
          expires: FUTURE_DATE,
          vpnAccessUrl: "ss://stale@1.2.3.4:8388",
          vlessUuid: "stale-uuid",
        },
      });
      const lm = new LicenseManager(store);
      const result = await lm.validate();

      assert.equal(result.valid, true);
      assert.equal(result.status, "active");
      // vpnAccessUrl should be re-fetched (old one cleared, new one set by /vpn/get)
      assert.equal(store.get("license.vpnAccessUrl"), "ss://new@1.2.3.4:8388");
      assert.equal(store.get("license.vlessUuid"), undefined);
    });

    it("fetches VPN key if not cached", async () => {
      let vpnGetCalled = false;
      mockApiCall = async (endpoint) => {
        if (endpoint === "/license") return { status: "active", expires: FUTURE_DATE };
        if (endpoint === "/vpn/get") {
          vpnGetCalled = true;
          return { access_url: "ss://fetched@1.2.3.4:8388" };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      };
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "test-device-123",
          status: "active",
          expires: FUTURE_DATE,
          vpnAccessUrl: null, // not cached
        },
      });
      // Explicitly delete so store.get returns undefined (null is falsy but stored)
      store.delete("license.vpnAccessUrl");
      const lm = new LicenseManager(store);
      await lm.validate();

      assert.ok(vpnGetCalled, "/vpn/get should have been called");
      assert.equal(store.get("license.vpnAccessUrl"), "ss://fetched@1.2.3.4:8388");
    });

    it("emits status change callback", async () => {
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "test-device-123",
          status: "active",
          expires: FUTURE_DATE,
          vpnAccessUrl: "ss://cached@1.2.3.4:8388",
        },
      });
      const lm = new LicenseManager(store);
      let emitted = null;
      lm.onStatusChange((status) => { emitted = status; });

      await lm.validate();

      assert.ok(emitted, "callback should have been called");
      assert.equal(emitted.valid, true);
      assert.equal(emitted.status, "active");
    });
  });

  // ── isGracePeriodValid() ────────────────────────────────────────────────

  describe("isGracePeriodValid()", () => {
    it("within 7 days returns true", () => {
      const store = makeStore({
        license: { lastSuccessfulCheck: new Date().toISOString() },
      });
      const lm = new LicenseManager(store);
      assert.equal(lm.isGracePeriodValid(), true);
    });

    it("beyond 7 days returns false", () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const store = makeStore({
        license: { lastSuccessfulCheck: eightDaysAgo },
      });
      const lm = new LicenseManager(store);
      assert.equal(lm.isGracePeriodValid(), false);
    });

    it("no lastCheck returns false", () => {
      const store = makeStore({ license: {} });
      const lm = new LicenseManager(store);
      assert.equal(lm.isGracePeriodValid(), false);
    });

    it("future clock (negative elapsed) returns false", () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const store = makeStore({
        license: { lastSuccessfulCheck: futureDate },
      });
      const lm = new LicenseManager(store);
      assert.equal(lm.isGracePeriodValid(), false);
    });
  });

  // ── isExpired() ─────────────────────────────────────────────────────────

  describe("isExpired()", () => {
    it("future date returns false", () => {
      const store = makeStore({ license: { expires: FUTURE_DATE } });
      const lm = new LicenseManager(store);
      assert.equal(lm.isExpired(), false);
    });

    it("past date returns true", () => {
      const store = makeStore({ license: { expires: PAST_DATE } });
      const lm = new LicenseManager(store);
      assert.equal(lm.isExpired(), true);
    });

    it("no expires returns true", () => {
      const store = makeStore({ license: {} });
      const lm = new LicenseManager(store);
      assert.equal(lm.isExpired(), true);
    });
  });

  // ── transferToThisDevice() ──────────────────────────────────────────────

  describe("transferToThisDevice()", () => {
    it("success updates deviceId and clears VPN URL", async () => {
      let transferCalled = false;
      mockApiCall = async (endpoint, body) => {
        if (endpoint === "/license/transfer") {
          transferCalled = true;
          assert.equal(body.device_id, "test-device-123");
          return { success: true };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      };
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "old-device-999",
          vpnAccessUrl: "ss://old@1.2.3.4:8388",
        },
      });
      const lm = new LicenseManager(store);
      const result = await lm.transferToThisDevice();

      assert.ok(transferCalled);
      assert.equal(result.success, true);
      assert.equal(store.get("license.deviceId"), "test-device-123");
      assert.equal(store.get("license.vpnAccessUrl"), undefined);
    });

    it("throws if no license key stored", async () => {
      const lm = new LicenseManager(makeStore());
      await assert.rejects(
        () => lm.transferToThisDevice(),
        { message: /No license key stored/ }
      );
    });
  });

  // ── startPeriodicCheck / stopPeriodicCheck ──────────────────────────────

  describe("startPeriodicCheck()", () => {
    let lm;

    afterEach(() => {
      if (lm) lm.stopPeriodicCheck();
    });

    it("is idempotent (call twice, only one timer)", () => {
      const store = makeStore({
        license: { key: VALID_KEY, deviceId: "test-device-123" },
      });
      lm = new LicenseManager(store);
      lm.startPeriodicCheck();
      const firstTimer = lm._timer;
      assert.ok(firstTimer, "timer should be set");

      lm.startPeriodicCheck();
      assert.strictEqual(lm._timer, firstTimer, "second call should not create new timer");
    });
  });

  // ── clear() ─────────────────────────────────────────────────────────────

  describe("clear()", () => {
    it("removes license data and stops timer", () => {
      const store = makeStore({
        license: {
          key: VALID_KEY,
          deviceId: "test-device-123",
          status: "active",
        },
      });
      const lm = new LicenseManager(store);
      lm.startPeriodicCheck();
      assert.ok(lm._timer, "timer should be running");

      lm.clear();
      assert.equal(lm._timer, null, "timer should be stopped");
      assert.equal(store.get("license"), undefined, "license data should be removed");
    });
  });
});
