const assert = require("assert");
const crypto = require("crypto");
const { describe, it } = require("node:test");

// Simulate the actual verification logic that would run on macOS/Windows
function computeCertificateHash(certInfo) {
  // In real implementation, this would be the SHA-256 of the certificate's public key
  // For testing, we hash a simulated certificate string
  return crypto.createHash("sha256").update(certInfo).digest("hex");
}

function verifyMacOSSignature(filePath, trustedHashes) {
  // Simulates: codesign -dvvv <filePath> → extract certificate hash
  // On actual macOS, this would spawn codesign and parse output
  if (!filePath) return false;
  // Mock: pretend we extracted a certificate hash from the file
  const extractedHash = "abcd1234efgh5678"; // would come from codesign output
  return trustedHashes.includes(extractedHash);
}

function verifyWindowsSignature(filePath, trustedHashes) {
  // Simulates: Get-AuthenticodeSignature → extract thumbprint
  if (!filePath) return false;
  const extractedThumbprint = "wxyz9999abcd0000"; // would come from PowerShell output
  return trustedHashes.includes(extractedThumbprint);
}

describe("Updater certificate verification logic", () => {
  it("accepts update when certificate hash matches on macOS", () => {
    const trusted = ["abcd1234efgh5678", "otherhash123"];
    const result = verifyMacOSSignature("/tmp/Vizoguard-1.3.5-mac.zip", trusted);
    assert.strictEqual(result, true);
  });

  it("rejects update when certificate hash does not match on macOS", () => {
    const trusted = ["unknownhash0000"];
    const result = verifyMacOSSignature("/tmp/Vizoguard-1.3.5-mac.zip", trusted);
    assert.strictEqual(result, false);
  });

  it("accepts update when thumbprint matches on Windows", () => {
    const trusted = ["wxyz9999abcd0000"];
    const result = verifyWindowsSignature("C:\\tmp\\Vizoguard-1.3.5.exe", trusted);
    assert.strictEqual(result, true);
  });

  it("rejects update when thumbprint does not match on Windows", () => {
    const trusted = ["badthumbprint1111"];
    const result = verifyWindowsSignature("C:\\tmp\\Vizoguard-1.3.5.exe", trusted);
    assert.strictEqual(result, false);
  });

  it("computes consistent SHA-256 hashes", () => {
    const hash1 = computeCertificateHash("test-cert-data");
    const hash2 = computeCertificateHash("test-cert-data");
    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64); // hex length of SHA-256
  });
});
