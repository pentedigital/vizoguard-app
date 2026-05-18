"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { tagTransportError, USER_MESSAGES } = require("../src/util/transport-errors");

function err(message) {
  const e = new Error(message);
  return e;
}

test("tagTransportError tags macOS utun unavailable as TUN_NOT_LOADED", () => {
  assert.equal(tagTransportError(err("utun: no such device")).code, "TUN_NOT_LOADED");
  assert.equal(tagTransportError(err("TUN interface did not appear")).code, "TUN_NOT_LOADED");
  assert.equal(tagTransportError(err("Cannot create TUN device")).code, "TUN_NOT_LOADED");
});

test("tagTransportError tags permission failures as TUN_PERMISSION_DENIED", () => {
  assert.equal(tagTransportError(err("permission denied: /dev/net/tun")).code, "TUN_PERMISSION_DENIED");
  assert.equal(tagTransportError(err("sudo: a password is required")).code, "TUN_PERMISSION_DENIED");
  assert.equal(tagTransportError(err("Operation not permitted")).code, "TUN_PERMISSION_DENIED");
  assert.equal(tagTransportError(err("EACCES: ...")).code, "TUN_PERMISSION_DENIED");
});

test("tagTransportError tags Windows driver issues as NDIS_INSTALL_FAILED", () => {
  assert.equal(tagTransportError(err("wintun driver not loaded")).code, "NDIS_INSTALL_FAILED");
  assert.equal(tagTransportError(err("tap-windows driver not installed")).code, "NDIS_INSTALL_FAILED");
  assert.equal(tagTransportError(err("sing-box binary not found at sing-box.exe")).code, "NDIS_INSTALL_FAILED");
});

test("tagTransportError tags network failures as NETWORK_UNREACHABLE", () => {
  assert.equal(tagTransportError(err("ENETUNREACH")).code, "NETWORK_UNREACHABLE");
  assert.equal(tagTransportError(err("getaddrinfo ENOTFOUND vizoguard.com")).code, "NETWORK_UNREACHABLE");
  assert.equal(tagTransportError(err("network is unreachable")).code, "NETWORK_UNREACHABLE");
});

test("tagTransportError tags timeouts and refusals as TIMEOUT", () => {
  assert.equal(tagTransportError(err("ETIMEDOUT")).code, "TIMEOUT");
  assert.equal(tagTransportError(err("connect ECONNREFUSED 1.2.3.4:443")).code, "TIMEOUT");
  assert.equal(tagTransportError(err("ECONNRESET")).code, "TIMEOUT");
  assert.equal(tagTransportError(err("handshake timeout")).code, "TIMEOUT");
});

test("tagTransportError tags VLESS provisioning failures", () => {
  assert.equal(tagTransportError(err("VLESS UUID provisioning failed: 500")).code, "PROVISION_FAILED");
});

test("tagTransportError falls back to UNKNOWN for unrecognized messages", () => {
  assert.equal(tagTransportError(err("something completely unexpected")).code, "UNKNOWN");
});

test("tagTransportError preserves already-tagged code", () => {
  const e = err("anything");
  e.code = "TUN_NOT_LOADED";
  const result = tagTransportError(e);
  assert.equal(result.code, "TUN_NOT_LOADED");
});

test("tagTransportError handles null gracefully", () => {
  assert.equal(tagTransportError(null), null);
  assert.equal(tagTransportError(undefined), undefined);
});

test("USER_MESSAGES has an entry for every emitted code", () => {
  const codes = [
    "TUN_NOT_LOADED", "TUN_PERMISSION_DENIED", "NDIS_INSTALL_FAILED",
    "NETWORK_UNREACHABLE", "TIMEOUT", "PROVISION_FAILED", "UNKNOWN",
  ];
  for (const code of codes) {
    assert.ok(code in USER_MESSAGES, `missing user message for ${code}`);
  }
});
