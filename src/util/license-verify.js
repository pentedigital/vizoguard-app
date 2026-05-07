const crypto = require("crypto");
const os = require("os");
const Store = require("electron-store");

// Must match backend LICENSE_RESPONSE_SECRET
// In production this MUST be set via build-time env var; verification is mandatory
const SHARED_SECRET = process.env.VIZOGUARD_LICENSE_SECRET || "";

const MAX_AGE_SECONDS = 5 * 60; // 5 minutes
const NONCE_HISTORY_SIZE = 100;

let seenNonces = [];
let nonceStore = null;

// Derive a machine-specific encryption key so nonce stores are not portable
// across devices (limits replay-attack surface if store file is exfiltrated).
function _deriveEncryptionKey() {
  const salt = "vizoguard-nonce-v1";
  // Use stable machine properties that survive reboots but differ across hardware
  let username;
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER || process.env.USERNAME || "unknown";
  }
  const machineId = [
    os.hostname(),
    os.platform(),
    os.arch(),
    username,
  ].join("|");
  return crypto.createHmac("sha256", salt).update(machineId).digest("hex");
}

function _tryLoadWithKey(key) {
  try {
    const store = new Store({ name: "license-nonces", encryptionKey: key });
    const stored = store.get("seenNonces");
    if (Array.isArray(stored) && stored.length > 0) {
      seenNonces = stored;
      return store;
    }
    // No data yet — return the store so future writes use this key
    return store;
  } catch {
    return null;
  }
}

function _getNonceStore() {
  if (!nonceStore) {
    // Try machine-derived key first (preferred)
    nonceStore = _tryLoadWithKey(_deriveEncryptionKey());
    if (nonceStore) {
      // Check if this is an empty store — if so, try legacy key for migration
      const stored = nonceStore.get("seenNonces");
      if (!Array.isArray(stored) || stored.length === 0) {
        const legacyStore = _tryLoadWithKey("vizoguard-nonce-v1");
        const legacyNonces = legacyStore ? legacyStore.get("seenNonces") : null;
        if (Array.isArray(legacyNonces) && legacyNonces.length > 0) {
          seenNonces = legacyNonces;
          try {
            nonceStore.set("seenNonces", seenNonces);
            console.log("[license-verify] Migrated nonce history from legacy key to machine-derived key");
          } catch {
            console.warn("[license-verify] Nonce migration failed — using in-memory only");
            nonceStore = null;
          }
        }
      }
    }
    if (!nonceStore) {
      // Backward compat: fall back to legacy hardcoded key
      nonceStore = _tryLoadWithKey("vizoguard-nonce-v1");
    }
    if (!nonceStore) {
      // Last resort: in-memory only (no persistence)
      console.warn("[license-verify] Unable to create nonce store — using in-memory only");
    }
  }
  return nonceStore;
}

function _persistNonces() {
  const store = _getNonceStore();
  if (store) {
    try { store.set("seenNonces", seenNonces); } catch {}
  }
}

function verifyLicenseResponse(response) {
  if (!response || typeof response !== "object") return false;

  if (!response.sig) {
    if (SHARED_SECRET) {
      console.warn("[license-verify] Response missing signature but secret is configured");
      return false;
    }
    return true; // Backward compat when no secret configured
  }

  if (!SHARED_SECRET) {
    console.warn("[license-verify] Response signed but no secret configured — rejecting");
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
  _persistNonces();

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
