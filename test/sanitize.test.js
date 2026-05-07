"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sanitize } = require("../src/util/sanitize");

describe("sanitize", () => {
  it("masks license keys", () => {
    assert.equal(
      sanitize("Key: VIZO-ABCD-EFGH-IJKL-MNOP"),
      "Key: VIZO-****-****-****-****"
    );
  });

  it("redacts Shadowsocks URLs", () => {
    assert.equal(
      sanitize("url: ss://YWVzLTI1Ni1nY206dGVzdA==@1.2.3.4:8388"),
      "url: ss://[REDACTED]"
    );
  });

  it("redacts VLESS URLs", () => {
    assert.equal(
      sanitize("url: vless://uuid@1.2.3.4:443?path=/ws"),
      "url: vless://[REDACTED]"
    );
  });

  it("redacts UUIDs", () => {
    assert.equal(
      sanitize("uuid: 550e8400-e29b-41d4-a716-446655440000"),
      "uuid: [UUID_REDACTED]"
    );
  });

  it("redacts IPv4 addresses", () => {
    assert.equal(
      sanitize("server: 192.168.1.1"),
      "server: [IP_REDACTED]"
    );
  });

  it("redacts 64-char hex hashes", () => {
    assert.equal(
      sanitize("hash: aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"),
      "hash: [HASH_REDACTED]"
    );
  });

  it("passes through non-strings unchanged", () => {
    assert.equal(sanitize(42), 42);
    assert.deepStrictEqual(sanitize({ a: 1 }), { a: 1 });
  });

  it("handles multiple sensitive values in one string", () => {
    const input = "key=VIZO-1111-2222-3333-4444 ip=10.0.0.1 url=ss://secret@host:port";
    const result = sanitize(input);
    assert.ok(!result.includes("VIZO-1111"));
    assert.ok(!result.includes("10.0.0.1"));
    assert.ok(!result.includes("ss://secret"));
  });
});
