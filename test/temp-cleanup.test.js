"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Mock electron app.getPath before requiring module
const tmpDir = path.join(os.tmpdir(), `vg-test-${Date.now()}`);
require.cache[require.resolve("electron")] = {
  id: require.resolve("electron"),
  filename: require.resolve("electron"),
  loaded: true,
  exports: {
    app: {
      getPath: (name) => {
        if (name === "temp") return tmpDir;
        return os.tmpdir();
      },
    },
  },
};

const { cleanupStaleTempFiles, rotateLogIfNeeded } = require("../src/util/temp-cleanup");

describe("temp-cleanup", () => {
  before(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try {
      const entries = fs.readdirSync(tmpDir);
      for (const e of entries) fs.unlinkSync(path.join(tmpDir, e));
      fs.rmdirSync(tmpDir);
    } catch {}
  });

  it("removes stale temp files older than 7 days", () => {
    const oldFile = path.join(tmpDir, "vizoguard-singbox-old.log");
    const newFile = path.join(tmpDir, "vizoguard-singbox-new.log");
    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(newFile, "new");

    // Manually set mtime of old file to 8 days ago
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, eightDaysAgo / 1000, eightDaysAgo / 1000);

    cleanupStaleTempFiles();

    assert.equal(fs.existsSync(oldFile), false, "old file should be removed");
    assert.equal(fs.existsSync(newFile), true, "new file should remain");
  });

  it("ignores non-matching temp files", () => {
    const otherFile = path.join(tmpDir, "other-app.log");
    fs.writeFileSync(otherFile, "data");
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(otherFile, eightDaysAgo / 1000, eightDaysAgo / 1000);

    cleanupStaleTempFiles();

    assert.equal(fs.existsSync(otherFile), true, "non-matching file should remain");
  });

  it("rotates log when it exceeds max size", () => {
    const logFile = path.join(tmpDir, "vizoguard-rotate.log");
    const bigContent = "x".repeat(11 * 1024 * 1024); // 11 MB
    fs.writeFileSync(logFile, bigContent);

    rotateLogIfNeeded(logFile);

    assert.equal(fs.existsSync(logFile), false, "log file should be renamed to backup");
    assert.equal(fs.existsSync(`${logFile}.1`), true, "backup should exist");
    assert.equal(fs.statSync(`${logFile}.1`).size, bigContent.length, "backup should contain old content");
  });

  it("handles missing log file gracefully", () => {
    assert.doesNotThrow(() => {
      rotateLogIfNeeded(path.join(tmpDir, "does-not-exist.log"));
    });
  });
});
