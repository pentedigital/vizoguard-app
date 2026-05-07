"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// We need to instantiate VpnManager to test private methods.
// Mock dependencies that require Electron or native modules.
const Tunnel = require("../src/tunnel");
const Routes = require("../src/routes");
const Dns = require("../src/dns");
const Monitor = require("../src/monitor");

// Minimal mock store
function makeStore(data = {}) {
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; },
  };
}

const VpnManager = require("../src/vpn");

describe("VpnManager _parseAccessUrl", () => {
  it("parses a valid ss:// URL", () => {
    const vpn = new VpnManager(makeStore());
    const url = "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTp0ZXN0cGFzcw==@1.2.3.4:8388";
    const result = vpn._parseAccessUrl(url);
    assert.equal(result.method, "chacha20-ietf-poly1305");
    assert.equal(result.password, "testpass");
    assert.equal(result.host, "1.2.3.4");
    assert.equal(result.port, 8388);
  });

  it("rejects loopback addresses", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@127.0.0.1:8388");
    }, /public address/);
  });

  it("rejects 10.x private addresses", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@10.0.0.1:8388");
    }, /public address/);
  });

  it("rejects 192.168.x private addresses", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@192.168.1.1:8388");
    }, /public address/);
  });

  it("rejects 172.16-31.x private addresses", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@172.16.0.1:8388");
    }, /public address/);
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@172.31.255.1:8388");
    }, /public address/);
  });

  it("rejects 169.254.x link-local addresses", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@169.254.1.1:8388");
    }, /public address/);
  });

  it("rejects 100.64.0.0/10 CGNAT addresses", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@100.64.0.1:8388");
    }, /public address/);
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@100.127.255.1:8388");
    }, /public address/);
  });

  it("rejects IPv6 loopback", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@[::1]:8388");
    }, /public address/);
  });

  it("rejects IPv6 link-local", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@[fe80::1]:8388");
    }, /public address/);
  });

  it("rejects IPv6 unique local addresses", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@[fc00::1]:8388");
    }, /public address/);
    assert.throws(() => {
      vpn._parseAccessUrl("ss://base64@[fd00::1]:8388");
    }, /public address/);
  });

  it("accepts public IPv4 addresses", () => {
    const vpn = new VpnManager(makeStore());
    const result = vpn._parseAccessUrl("ss://base64@8.8.8.8:8388");
    assert.equal(result.host, "8.8.8.8");
  });

  it("accepts public IPv6 addresses", () => {
    const vpn = new VpnManager(makeStore());
    const result = vpn._parseAccessUrl("ss://base64@[2001:db8::1]:8388");
    assert.equal(result.host, "2001:db8::1");
  });

  it("rejects unsupported cipher", () => {
    const vpn = new VpnManager(makeStore());
    assert.throws(() => {
      vpn._parseAccessUrl("ss://YmFkLWNpcGhlcjpwYXNz@1.2.3.4:8388");
    }, /Unsupported cipher/);
  });
});

describe("VpnManager _buildAddressHeader", () => {
  it("builds IPv4 header", () => {
    const vpn = new VpnManager(makeStore());
    const header = vpn._buildAddressHeader("1.2.3.4", 80);
    assert.equal(header.length, 7);
    assert.equal(header[0], 0x01);
    assert.equal(header[1], 1);
    assert.equal(header[2], 2);
    assert.equal(header[3], 3);
    assert.equal(header[4], 4);
    assert.equal(header.readUInt16BE(5), 80);
  });

  it("builds IPv6 header", () => {
    const vpn = new VpnManager(makeStore());
    const header = vpn._buildAddressHeader("2001:db8::1", 443);
    assert.equal(header.length, 19);
    assert.equal(header[0], 0x04);
    assert.equal(header.readUInt16BE(17), 443);
  });

  it("builds domain header", () => {
    const vpn = new VpnManager(makeStore());
    const header = vpn._buildAddressHeader("example.com", 8080);
    assert.equal(header[0], 0x03);
    assert.equal(header[1], "example.com".length);
    assert.equal(header.readUInt16BE(2 + "example.com".length), 8080);
  });

  it("rejects domain names that are too long", () => {
    const vpn = new VpnManager(makeStore());
    const longDomain = "a".repeat(256);
    assert.throws(() => {
      vpn._buildAddressHeader(longDomain, 80);
    }, /too long/);
  });
});
