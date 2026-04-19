const assert = require("assert");
const { describe, it } = require("node:test");

// Read the updater source and verify the env-var logic without loading electron-updater
const fs = require("fs");
const src = fs.readFileSync("src/updater.js", "utf8");

describe("Updater env-var handling", () => {
  it("reads VIZOGUARD_TRUSTED_CERTS from process.env", () => {
    assert(src.includes("process.env.VIZOGUARD_TRUSTED_CERTS"), "Source must read env var");
  });

  it("warns when additional certificate pinning is not configured", () => {
    assert(src.includes("Additional certificate pinning not configured"), "Source must warn unconfigured");
  });

  it("has async _verifyDownloadedUpdate method", () => {
    const verifyBlock = src.match(/async _verifyDownloadedUpdate\(info\)\s*\{[\s\S]*?\n  \}/);
    assert(verifyBlock, "Found async _verifyDownloadedUpdate method");
    const body = verifyBlock[0];
    assert(body.includes("TRUSTED_CERTIFICATE_HASHES.length === 0"), "Method checks hash list emptiness");
    assert(body.includes("return true"), "Method returns true when unconfigured");
  });

  it("implements macOS certificate extraction via codesign", () => {
    assert(src.includes("_extractMacOSCertificateHash"), "Must have macOS cert extraction method");
    assert(src.includes('spawn("codesign"'), "Must spawn codesign");
    assert(src.includes("--extract-certificates="), "Must extract certificates");
  });

  it("implements Windows certificate extraction via PowerShell", () => {
    assert(src.includes("_extractWindowsCertificateThumbprint"), "Must have Windows cert extraction method");
    assert(src.includes('spawn("powershell"'), "Must spawn powershell");
    assert(src.includes("Get-AuthenticodeSignature"), "Must use Get-AuthenticodeSignature");
  });

  it("downgrade-protects with MINIMUM_VERSION", () => {
    assert(src.includes("MINIMUM_VERSION"), "Must reference MINIMUM_VERSION");
    assert(src.includes("_isVersionAllowed"), "Must have version check method");
    assert(src.includes("downgrade protection"), "Must mention downgrade protection");
  });
});
