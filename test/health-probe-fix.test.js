const assert = require("assert");
const crypto = require("crypto");
const { describe, it } = require("node:test");

// Minimal reproduction of the cipher resolution logic from vpn.js
const CIPHER_INFO = {
  "chacha20-ietf-poly1305": { cipher: "chacha20-poly1305", keyLen: 32, saltLen: 32, nonceLen: 12, tagLen: 16 },
  "aes-256-gcm": { cipher: "aes-256-gcm", keyLen: 32, saltLen: 32, nonceLen: 12, tagLen: 16 },
};

function resolveCipher(info) {
  if (info.cipher) return info.cipher;
  return info.method;
}

// Simulate VpnManager's _performAeadHealthProbe cipher usage
function createHealthProbeCipher(cipherInfo, masterKey) {
  const salt = crypto.randomBytes(cipherInfo.saltLen);
  // Derive subkey (simplified - real code uses hkdfSha1)
  const subkey = crypto.createHash("sha256").update(masterKey).update(salt).digest().slice(0, cipherInfo.keyLen);
  const nonce = Buffer.alloc(cipherInfo.nonceLen);
  // This is the fixed line: _cipherInfo.cipher instead of undefined _cipherName
  const cipher = crypto.createCipheriv(cipherInfo.cipher, subkey, nonce, { authTagLength: cipherInfo.tagLen });
  return cipher;
}

describe("Health probe cipher fix", () => {
  it("uses _cipherInfo.cipher without throwing ReferenceError", () => {
    const info = { ...CIPHER_INFO["chacha20-ietf-poly1305"] };
    info.cipher = resolveCipher(info);
    const masterKey = crypto.randomBytes(32);
    
    // Before fix: this._cipherName was undefined → ReferenceError
    // After fix: this._cipherInfo.cipher resolves correctly
    assert.doesNotThrow(() => {
      const cipher = createHealthProbeCipher(info, masterKey);
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16BE(0);
      const encryptedLen = Buffer.concat([cipher.update(lenBuf), cipher.final()]);
      const lenTag = cipher.getAuthTag();
      assert.strictEqual(encryptedLen.length, 2);
      assert.strictEqual(lenTag.length, 16);
    });
  });

  it("works with aes-256-gcm as well", () => {
    const info = { ...CIPHER_INFO["aes-256-gcm"] };
    info.cipher = resolveCipher(info);
    const masterKey = crypto.randomBytes(32);
    
    assert.doesNotThrow(() => {
      const cipher = createHealthProbeCipher(info, masterKey);
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16BE(0);
      Buffer.concat([cipher.update(lenBuf), cipher.final()]);
      assert.strictEqual(cipher.getAuthTag().length, 16);
    });
  });
});
