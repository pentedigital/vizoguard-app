"use strict";

/**
 * ThreatChecker tests — validates:
 * 1. Blocklist matching (exact hostname only)
 * 2. Suspicious TLD detection
 * 3. Brand impersonation vs legitimate brand domains
 * 4. IP address in URL detection
 * 5. Excessive subdomain detection
 * 6. Dangerous download detection
 * 7. Homoglyph/punycode detection
 * 8. Phishing keyword detection
 * 9. LRU cache behavior and TTL expiry
 * 10. Event emission on high/critical risk
 * 11. Edge cases (invalid URLs, combined risk factors)
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ThreatChecker = require("../src/core/threat-checker");

// ── Setup ──────────────────────────────────────────────────────────────────

const testDir = path.join(os.tmpdir(), `vizoguard-threat-test-${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });
fs.writeFileSync(
  path.join(testDir, "malicious-domains.txt"),
  "evil.com\nmalware.org\n# comment line\n"
);

after(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Blocklist ──────────────────────────────────────────────────────────────

describe("ThreatChecker blocklist", () => {
  it("flags blocklisted domain as critical risk", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://evil.com/path");
    assert.equal(result.risk, "critical");
    assert.equal(result.checks[0].name, "blocklist");
  });

  it("does not match subdomain of blocklisted domain", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://sub.evil.com/path");
    const blocklistCheck = result.checks.find((c) => c.name === "blocklist");
    assert.equal(blocklistCheck, undefined);
  });

  it("returns no blocklist check for clean domain", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://safe-site.com/");
    const blocklistCheck = result.checks.find((c) => c.name === "blocklist");
    assert.equal(blocklistCheck, undefined);
  });
});

// ── Suspicious TLD ─────────────────────────────────────────────────────────

describe("ThreatChecker suspicious TLD", () => {
  it("flags .xyz domain as medium risk", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://sketchy-site.xyz/");
    assert.equal(result.risk, "medium");
    const tldCheck = result.checks.find((c) => c.name === "suspicious_tld");
    assert.ok(tldCheck);
  });

  it("does not flag .com domain", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://normal-site.com/");
    const tldCheck = result.checks.find((c) => c.name === "suspicious_tld");
    assert.equal(tldCheck, undefined);
  });
});

// ── Brand Impersonation ────────────────────────────────────────────────────

describe("ThreatChecker brand impersonation", () => {
  it("flags fake brand domain as high risk", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://fake-paypal-login.com/");
    assert.equal(result.risk, "high");
    const brandCheck = result.checks.find((c) => c.name === "brand_impersonation");
    assert.ok(brandCheck);
  });

  it("allows brand-owned subdomain (api.paypal.com)", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://api.paypal.com/v1");
    assert.equal(result.risk, "low");
    const brandCheck = result.checks.find((c) => c.name === "brand_impersonation");
    assert.equal(brandCheck, undefined);
  });

  it("allows SLD starting with brand (amazonaws.com)", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://amazonaws.com/s3");
    assert.equal(result.risk, "low");
    const brandCheck = result.checks.find((c) => c.name === "brand_impersonation");
    assert.equal(brandCheck, undefined);
  });

  it("allows exact brand domain (paypal.com)", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://paypal.com/");
    assert.equal(result.risk, "low");
    const brandCheck = result.checks.find((c) => c.name === "brand_impersonation");
    assert.equal(brandCheck, undefined);
  });
});

// ── IP Address ─────────────────────────────────────────────────────────────

describe("ThreatChecker IP address detection", () => {
  it("flags IP address in URL as medium risk", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://192.168.1.1/admin");
    const ipCheck = result.checks.find((c) => c.name === "ip_address");
    assert.ok(ipCheck);
    assert.equal(ipCheck.risk, "medium");
  });

  it("does not flag normal domain", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://example.com/");
    const ipCheck = result.checks.find((c) => c.name === "ip_address");
    assert.equal(ipCheck, undefined);
  });
});

// ── Excessive Subdomains ───────────────────────────────────────────────────

describe("ThreatChecker excessive subdomains", () => {
  it("flags URL with 5+ hostname parts", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://a.b.c.d.example.com/");
    const subCheck = result.checks.find((c) => c.name === "subdomains");
    assert.ok(subCheck);
  });

  it("does not flag URL with 3 hostname parts", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://sub.example.com/");
    const subCheck = result.checks.find((c) => c.name === "subdomains");
    assert.equal(subCheck, undefined);
  });
});

// ── Dangerous Downloads ────────────────────────────────────────────────────

describe("ThreatChecker dangerous downloads", () => {
  it("flags .exe download as high risk", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://example.com/setup.exe");
    const dlCheck = result.checks.find((c) => c.name === "dangerous_download");
    assert.ok(dlCheck);
    assert.equal(dlCheck.risk, "high");
  });

  it("does not flag .pdf download", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://example.com/document.pdf");
    const dlCheck = result.checks.find((c) => c.name === "dangerous_download");
    assert.equal(dlCheck, undefined);
  });
});

// ── Homoglyphs ─────────────────────────────────────────────────────────────

describe("ThreatChecker homoglyph detection", () => {
  it("flags punycode domain as high risk", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://xn--pypal-4ve.com/");
    const homoCheck = result.checks.find((c) => c.name === "homoglyph");
    assert.ok(homoCheck);
    assert.equal(homoCheck.risk, "high");
  });
});

// ── Phishing Keywords ──────────────────────────────────────────────────────

describe("ThreatChecker phishing keywords", () => {
  it("flags URL with 2+ phishing keywords", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://example.com/login-verify-account");
    const phishCheck = result.checks.find((c) => c.name === "phishing_keywords");
    assert.ok(phishCheck);
  });

  it("does not flag URL with only 1 keyword", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("https://example.com/login");
    const phishCheck = result.checks.find((c) => c.name === "phishing_keywords");
    assert.equal(phishCheck, undefined);
  });
});

// ── Cache ──────────────────────────────────────────────────────────────────

describe("ThreatChecker cache", () => {
  it("returns cached result on second call", async () => {
    const tc = new ThreatChecker(testDir);
    const url = "https://cache-test.com/page";
    const first = await tc.checkUrl(url);
    const second = await tc.checkUrl(url);
    assert.equal(first, second, "second call should return exact same object reference");
  });

  it("expires cache entries older than 1 hour", () => {
    const tc = new ThreatChecker(testDir);
    const url = "https://ttl-test.com/page";
    const fakeResult = { risk: "low", checks: [], hostname: "ttl-test.com" };
    // Manually insert a cache entry with an old timestamp
    tc._cache.set(url, { result: fakeResult, time: Date.now() - 3600001 });
    const got = tc._cacheGet(url);
    assert.equal(got, null, "expired entry should return null");
  });
});

// ── Events ─────────────────────────────────────────────────────────────────

describe("ThreatChecker event emission", () => {
  it("emits 'threat' event for blocklisted URL", async () => {
    const tc = new ThreatChecker(testDir);
    let emitted = null;
    tc.on("threat", (data) => {
      emitted = data;
    });
    await tc.checkUrl("https://evil.com/phish");
    assert.ok(emitted, "threat event should have been emitted");
    assert.equal(emitted.url, "https://evil.com/phish");
    assert.equal(emitted.risk, "critical");
  });

  it("does not emit 'threat' event for clean URL", async () => {
    const tc = new ThreatChecker(testDir);
    let emitted = false;
    tc.on("threat", () => {
      emitted = true;
    });
    await tc.checkUrl("https://safe-example.com/");
    assert.equal(emitted, false, "no threat event for clean URL");
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────────────

describe("ThreatChecker edge cases", () => {
  it("returns low risk with empty checks for invalid URL", async () => {
    const tc = new ThreatChecker(testDir);
    const result = await tc.checkUrl("not-a-valid-url");
    assert.equal(result.risk, "low");
    assert.deepEqual(result.checks, []);
  });

  it("highest risk wins when multiple factors combine", async () => {
    const tc = new ThreatChecker(testDir);
    // evil.com is blocklisted (critical) + .exe download (high)
    const result = await tc.checkUrl("https://evil.com/setup.exe");
    assert.equal(result.risk, "critical");
    const blocklistCheck = result.checks.find((c) => c.name === "blocklist");
    const dlCheck = result.checks.find((c) => c.name === "dangerous_download");
    assert.ok(blocklistCheck);
    assert.ok(dlCheck);
  });
});
