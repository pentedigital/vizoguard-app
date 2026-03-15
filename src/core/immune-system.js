const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CHECK_INTERVAL = 15000; // 15 seconds

class ImmuneSystem extends EventEmitter {
  constructor(appDir) {
    super();
    this.appDir = appDir;
    this._timer = null;
    this._hashes = new Map(); // filepath -> sha256
    this._protectedFiles = [];
    this.events = [];
  }

  start() {
    // Clear any existing timer to prevent leaks on repeated start()
    this.stop();

    // Build list of protected files
    this._protectedFiles = this._findProtectedFiles();

    // Take initial snapshot
    for (const file of this._protectedFiles) {
      const hash = this._hashFile(file);
      if (hash) this._hashes.set(file, hash);
    }

    console.log(`Immune system protecting ${this._protectedFiles.length} files`);

    // Start monitoring
    this._timer = setInterval(() => this._check(), CHECK_INTERVAL);
    this.emit("started", { files: this._protectedFiles.length });
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _findProtectedFiles() {
    const files = [];
    const dirs = [
      this.appDir,
      path.join(this.appDir, "src"),
      path.join(this.appDir, "src", "core"),
      path.join(this.appDir, "src", "platform"),
    ];

    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (entry.endsWith(".js") || entry.endsWith(".json") || entry.endsWith(".html")) {
            files.push(path.join(dir, entry));
          }
        }
      } catch { /* directory may not exist */ }
    }

    return files;
  }

  _hashFile(filepath) {
    try {
      const data = fs.readFileSync(filepath);
      return crypto.createHash("sha256").update(data).digest("hex");
    } catch {
      return null;
    }
  }

  _check() {
    for (const file of this._protectedFiles) {
      const currentHash = this._hashFile(file);
      const storedHash = this._hashes.get(file);

      if (!currentHash) {
        // File was deleted
        const event = { type: "deleted", file: path.basename(file), time: new Date().toISOString() };
        this.events.push(event);
        this.emit("alert", event);
        continue;
      }

      if (storedHash && currentHash !== storedHash) {
        // File was modified
        const event = { type: "modified", file: path.basename(file), time: new Date().toISOString() };
        this.events.push(event);
        this.emit("alert", event);
        // Update hash to track the new state
        this._hashes.set(file, currentHash);
      }
    }
  }
}

module.exports = ImmuneSystem;
