"use strict";

/**
 * Grace period hardening tests — validates:
 * 1. Normal grace period works within 7 days
 * 2. Grace period rejects if server iat indicates >7 days elapsed
 * 3. Grace period rejects if serverIat is in the future (clock set back)
 * 4. Grace period rejects if wall clock elapsed is negative
 * 5. Grace period works without serverIat (backward compat)
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Mock apiCall and platform before requiring LicenseManager
const Module = require("module");
const originalResolve = Module._resolveFilename;

let mockApiCall = async () => ({ status: "active", expires: "2099-01-01T00:00:00Z", iat: Math.floor(Date.now() / 1000), nonce: "abc", sig: "def" });

require.cache[require.resolve("../src/api")] = {
  id: require.resolve("../src/api"),
  filename: require.resolve("../src/api"),
  loaded: true,
  exports: { apiCall: async (...args) => mockApiCall(...args) },
};

require.cache[require.resolve("../src/platform")] = {
  id: require.resolve("../src/platform"),
  filename: require.resolve("../src/platform"),
  loaded: true,
  exports: { getDeviceId: async () => "test-device-1234567890" },
};

require.cache[require.resolve("../src/util/license-verify")] = {
  id: require.resolve("../src/util/license-verify"),
  filename: require.resolve("../src/util/license-verify"),
  loaded: true,
  exports: { verifyLicenseResponse: () => true },
};

const LicenseManager = require("../src/license");

function makeStore(data = {}) {
  return {
    _data: { ...data },
    get(key, def) {
      const parts = key.split(".");
      let val = this._data;
      for (const p of parts) {
        if (val == null) return def;
        val = typeof val === "object" ? val[p] : undefined;
      }
      return val !== undefined ? val : def;
    },
    set(key, val) {
      const parts = key.split(".");
      if (parts.length === 1) {
        this._data[key] = val;
        return;
      }
      // Handle dotted keys: license.status -> _data.license.status
      let obj = this._data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = val;
    },
    delete(key) {
      const parts = key.split(".");
      if (parts.length === 1) { delete this._data[key]; return; }
      let obj = this._data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) return;
        obj = obj[parts[i]];
      }
      delete obj[parts[parts.length - 1]];
    },
  };
}

describe("Grace period — clock manipulation hardening", () => {
  it("valid: last check within 7 days, no server iat", () => {
    const store = makeStore({
      license: {
        key: "VIZO-1234-5678-9ABC-DEF0",
        deviceId: "test-device",
        status: "active",
        expires: "2099-01-01T00:00:00Z",
        lastSuccessfulCheck: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      },
    });
    const lm = new LicenseManager(store);
    assert.equal(lm.isGracePeriodValid(), true);
  });

  it("invalid: last check beyond 7 days", () => {
    const store = makeStore({
      license: {
        lastSuccessfulCheck: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
      },
    });
    const lm = new LicenseManager(store);
    assert.equal(lm.isGracePeriodValid(), false);
  });

  it("invalid: wall clock moved backward (negative elapsed)", () => {
    const store = makeStore({
      license: {
        lastSuccessfulCheck: new Date(Date.now() + 3600000).toISOString(), // 1 hour in the future
      },
    });
    const lm = new LicenseManager(store);
    assert.equal(lm.isGracePeriodValid(), false);
  });

  it("invalid: server iat indicates >7 days elapsed", () => {
    const store = makeStore({
      license: {
        lastSuccessfulCheck: new Date().toISOString(), // wall clock says "just now"
        serverIat: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60, // server says 8 days ago
      },
    });
    const lm = new LicenseManager(store);
    assert.equal(lm.isGracePeriodValid(), false);
  });

  it("valid: server iat within 7 days", () => {
    const store = makeStore({
      license: {
        lastSuccessfulCheck: new Date(Date.now() - 3600000).toISOString(),
        serverIat: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
      },
    });
    const lm = new LicenseManager(store);
    assert.equal(lm.isGracePeriodValid(), true);
  });

  it("invalid: server iat in the future", () => {
    const store = makeStore({
      license: {
        lastSuccessfulCheck: new Date().toISOString(),
        serverIat: Math.floor(Date.now() / 1000) + 3600, // 1 hour in the future
      },
    });
    const lm = new LicenseManager(store);
    assert.equal(lm.isGracePeriodValid(), false);
  });

  it("no lastCheck returns false", () => {
    const store = makeStore({ license: {} });
    const lm = new LicenseManager(store);
    assert.equal(lm.isGracePeriodValid(), false);
  });
});
