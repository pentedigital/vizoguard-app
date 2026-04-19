const { autoUpdater } = require("electron-updater");
const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Expected code signing certificates (SHA-256 hashes of certificate data or thumbprints)
// Set VIZOGUARD_TRUSTED_CERTS env var to a comma-separated list of hashes.
const TRUSTED_CERTIFICATE_HASHES = process.env.VIZOGUARD_TRUSTED_CERTS?.split(",")?.map(h => h.trim().toLowerCase()).filter(Boolean) || [];

// Minimum allowed version (prevents downgrade attacks)
const MINIMUM_VERSION = process.env.VIZOGUARD_MIN_VERSION || "1.0.0";

class Updater extends EventEmitter {
  constructor() {
    super();

    // SECURITY: Verify code signatures before installing updates
    autoUpdater.autoDownload = false; // We'll download manually to verify first
    autoUpdater.autoInstallOnAppQuit = false; // Install only after verification

    // Enable signature verification (electron-updater handles this on macOS/Windows)
    autoUpdater.verifyUpdateCodeSignature = true;

    autoUpdater.on("checking-for-update", () => {
      this.emit("checking");
    });

    autoUpdater.on("update-available", (info) => {
      // SECURITY: Validate version to prevent downgrade attacks
      if (!this._isVersionAllowed(info.version)) {
        console.error(`Update rejected: version ${info.version} is below minimum ${MINIMUM_VERSION}`);
        this.emit("error", new Error("Update version rejected (downgrade protection)"));
        return;
      }
      this.emit("available", info);
      // Manually download so we can verify
      autoUpdater.downloadUpdate().catch((err) => {
        console.error("Download failed:", err.message);
        this.emit("error", err);
      });
    });

    autoUpdater.on("update-not-available", () => {
      this.emit("not-available");
    });

    autoUpdater.on("download-progress", (progress) => {
      this.emit("progress", progress);
    });

    autoUpdater.on("update-downloaded", async (info) => {
      console.log(`Update downloaded: ${info.version}`);
      try {
        const verified = await this._verifyDownloadedUpdate(info);
        if (verified) {
          console.log("Update signature verified successfully");
          this._verifiedUpdateInfo = info;
          this.emit("downloaded", info);
        } else {
          console.error("Update signature verification failed - rejecting update");
          this.emit("error", new Error("Code signature verification failed"));
        }
      } catch (err) {
        console.error("Update verification error:", err.message);
        this.emit("error", err);
      }
    });

    autoUpdater.on("error", (err) => {
      console.error("Update error:", err.message);
      this.emit("error", err);
    });
  }

  /**
   * Check if version meets minimum requirement (prevents downgrade attacks)
   */
  _isVersionAllowed(version) {
    const parse = (v) => v.split(".").map(Number);
    const [maj1, min1, pat1] = parse(version);
    const [maj2, min2, pat2] = parse(MINIMUM_VERSION);

    if (maj1 > maj2) return true;
    if (maj1 < maj2) return false;
    if (min1 > min2) return true;
    if (min1 < min2) return false;
    return pat1 >= pat2;
  }

  /**
   * Verify the downloaded update package.
   * electron-updater handles signature verification internally.
   * This adds certificate-pinning when VIZOGUARD_TRUSTED_CERTS is configured.
   */
  async _verifyDownloadedUpdate(info) {
    if (TRUSTED_CERTIFICATE_HASHES.length === 0) {
      console.warn("Additional certificate pinning not configured; relying on electron-updater");
      return true;
    }

    const filePath = info.path || info.downloadedFile;
    if (!filePath || !fs.existsSync(filePath)) {
      console.error("Update file not found for additional verification");
      return false;
    }

    const platform = process.platform;
    let extractedHash = null;

    try {
      if (platform === "darwin") {
        extractedHash = await this._extractMacOSCertificateHash(filePath);
      } else if (platform === "win32") {
        extractedHash = await this._extractWindowsCertificateThumbprint(filePath);
      } else {
        console.warn(`Additional certificate verification not implemented for platform: ${platform}`);
        return true;
      }
    } catch (err) {
      console.error("Failed to extract certificate information:", err.message);
      return false;
    }

    if (!extractedHash) {
      console.error("Could not extract certificate hash from update package");
      return false;
    }

    const normalized = extractedHash.toLowerCase();
    const pinned = TRUSTED_CERTIFICATE_HASHES.includes(normalized);
    if (!pinned) {
      console.error(`Certificate hash ${normalized} does not match trusted hashes`);
    }
    return pinned;
  }

  /**
   * Extract SHA-256 hash of the leaf signing certificate on macOS.
   * Uses `codesign -dv --extract-certificates` to pull the cert and hash it.
   */
  _extractMacOSCertificateHash(filePath) {
    return new Promise((resolve, reject) => {
      // If the update is a zip, codesign cannot verify it directly.
      // electron-updater verifies internally after extraction; we skip additional
      // pinning for zip files to avoid false rejections.
      if (filePath.endsWith(".zip")) {
        console.warn("Skipping additional cert pinning for .zip update (electron-updater handles it)");
        resolve(null);
        return;
      }

      const tmpPrefix = path.join(os.tmpdir(), `vg-cert-${Date.now()}`);
      const proc = spawn("codesign", ["-dv", `--extract-certificates=${tmpPrefix}`, filePath]);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        const certFile = `${tmpPrefix}0`;
        const cleanup = () => {
          for (let i = 0; i < 5; i++) {
            try { fs.unlinkSync(`${tmpPrefix}${i}`); } catch {}
          }
        };

        if (!fs.existsSync(certFile)) {
          cleanup();
          reject(new Error(`codesign did not extract certificate: ${stderr}`));
          return;
        }

        try {
          const certData = fs.readFileSync(certFile);
          cleanup();
          const hash = crypto.createHash("sha256").update(certData).digest("hex");
          resolve(hash);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`codesign spawn failed: ${err.message}`));
      });
    });
  }

  /**
   * Extract certificate thumbprint on Windows via PowerShell.
   */
  _extractWindowsCertificateThumbprint(filePath) {
    return new Promise((resolve, reject) => {
      const escaped = filePath.replace(/'/g, "''");
      const script = `Get-AuthenticodeSignature -FilePath '${escaped}' | Select-Object -ExpandProperty SignerCertificate | Select-Object -ExpandProperty Thumbprint`;
      const proc = spawn("powershell", ["-NoProfile", "-Command", script]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        const thumbprint = stdout.trim();
        if (code !== 0) {
          reject(new Error(`PowerShell exited ${code}: ${stderr}`));
          return;
        }
        if (/^[0-9a-fA-F]{40}$/.test(thumbprint)) {
          resolve(thumbprint.toLowerCase());
        } else {
          reject(new Error(`Invalid thumbprint extracted: ${thumbprint}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`PowerShell spawn failed: ${err.message}`));
      });
    });
  }

  check() {
    autoUpdater.checkForUpdates();
  }

  install() {
    // SECURITY: Only install if verification passed
    if (!this._verifiedUpdateInfo) {
      console.error("Install rejected: update was not verified");
      this.emit("error", new Error("Cannot install unverified update"));
      return;
    }
    autoUpdater.quitAndInstall();
  }
}

module.exports = Updater;
