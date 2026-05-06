const crypto = require("crypto");

// Must match backend LICENSE_RESPONSE_SECRET
// In production this is embedded at build time; for dev it defaults to empty (verification skipped)
const SHARED_SECRET = process.env.VIZOGUARD_LICENSE_SECRET || "";

const MAX_AGE_SECONDS = 5 * 60; // 5 minutes
const NONCE_HISTORY_SIZE = 100;

let seenNonces = [];

function verifyLicenseResponse(response) {
  if (!response || typeof response !== "object") return false;

  // If no signature present and no secret configured, skip verification (backward compat)
  if (!response.sig) {
    if (SHARED_SECRET) {
      console.warn("[license-verify] Response missing signature but secret is configured");
      return false;
    }
    return true;
  }

  if (!SHARED_SECRET) {
    // Signature present but no secret configured — can't verify
    console.warn("[license-verify] Response signed but no secret configured");
    return false;
  }

  // Check timestamp
  if (typeof response.iat !== "number") {
    console.warn("[license-verify] Response missing iat");
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - response.iat > MAX_AGE_SECONDS) {
    console.warn("[license-verify] Response expired (replay protection)");
    return false;
  }

  // Check nonce (replay protection)
  if (typeof response.nonce !== "string" || response.nonce.length < 8) {
    console.warn("[license-verify] Response missing nonce");
    return false;
  }
  if (seenNonces.includes(response.nonce)) {
    console.warn("[license-verify] Nonce already seen (replay attack)");
    return false;
  }
  seenNonces.push(response.nonce);
  if (seenNonces.length > NONCE_HISTORY_SIZE) {
    seenNonces = seenNonces.slice(-NONCE_HISTORY_SIZE);
  }

  // Verify HMAC
  const sigPayload = `${response.valid}|${response.status || ""}|${response.expires || ""}|${response.iat}|${response.nonce}`;
  const expected = crypto.createHmac("sha256", SHARED_SECRET).update(sigPayload).digest("hex");

  try {
    if (!crypto.timingSafeEqual(Buffer.from(response.sig, "hex"), Buffer.from(expected, "hex"))) {
      console.warn("[license-verify] Signature mismatch (tampering detected)");
      return false;
    }
  } catch {
    console.warn("[license-verify] Signature comparison failed");
    return false;
  }

  return true;
}

module.exports = { verifyLicenseResponse };
