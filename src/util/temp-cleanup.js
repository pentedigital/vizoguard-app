const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const TEMP_PREFIXES = ["vizoguard-singbox", "vizoguard-tun2socks", "vg-cert-"];
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Clean up stale temp files left behind by previous runs (crash/force-quit).
 */
function cleanupStaleTempFiles() {
  try {
    const tmpDir = app.getPath("temp");
    const entries = fs.readdirSync(tmpDir);
    const now = Date.now();

    for (const entry of entries) {
      const fullPath = path.join(tmpDir, entry);
      let shouldRemove = false;

      for (const prefix of TEMP_PREFIXES) {
        if (entry.startsWith(prefix)) {
          shouldRemove = true;
          break;
        }
      }

      if (!shouldRemove) continue;

      try {
        const stats = fs.statSync(fullPath);
        const ageMs = now - stats.mtimeMs;
        if (ageMs > MAX_LOG_AGE_MS) {
          fs.unlinkSync(fullPath);
        }
      } catch (_err) {
        // Ignore permission errors
      }
    }
  } catch (_err) {
    // temp dir may not exist or be unreadable
  }
}

/**
 * Rotate a log file if it exceeds MAX_LOG_SIZE_BYTES.
 * Keeps one backup (file.log -> file.log.1).
 */
function rotateLogIfNeeded(logPath) {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size < MAX_LOG_SIZE_BYTES) return;

    const backupPath = `${logPath}.1`;
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    fs.renameSync(logPath, backupPath);
  } catch (_err) {
    // File doesn't exist or not accessible
  }
}

/**
 * Register cleanup handlers for graceful and crash scenarios.
 * Call once from main process initialization.
 */
function registerTempCleanup() {
  // Clean up stale files on startup (handles crash/force-quit leftovers)
  cleanupStaleTempFiles();

  // On graceful quit, attempt cleanup again
  app.on("before-quit", () => {
    cleanupStaleTempFiles();
  });
}

module.exports = {
  cleanupStaleTempFiles,
  rotateLogIfNeeded,
  registerTempCleanup,
};
