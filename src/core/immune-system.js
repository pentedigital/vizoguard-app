const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEBOUNCE_MS = 1000; // Wait 1s after last change before re-hashing

class ImmuneSystem extends EventEmitter {
  constructor(appDir, isPackaged) {
    super();
    this.appDir = appDir;
    this._isPackaged = !!isPackaged;
    this._watchers = [];
    this._hashes = new Map(); // filepath -> sha256
    this._protectedFiles = [];
    this._alerted = new Set();
    this._debounceTimers = new Map(); // filepath -> timer
    this.events = [];
  }

  start() {
    this.stop();

    this._protectedFiles = this._findProtectedFiles();

    // Take initial snapshot
    for (const file of this._protectedFiles) {
      const hash = this._hashFile(file);
      if (hash) this._hashes.set(file, hash);
    }

    console.log(`Immune system protecting ${this._protectedFiles.length} files`);

    // Watch files/directories for changes
    this._startWatching();
    this.emit("started", { files: this._protectedFiles.length });
  }

  stop() {
    for (const w of this._watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    this._watchers = [];
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
  }

  _startWatching() {
    if (this._isPackaged) {
      // Production: watch the single asar/app file
      for (const file of this._protectedFiles) {
        this._watchFile(file);
      }
    } else {
      // Dev mode: watch directories containing protected files
      const dirs = new Set();
      for (const file of this._protectedFiles) {
        dirs.add(path.dirname(file));
      }
      for (const dir of dirs) {
        this._watchDir(dir);
      }
    }
  }

  _watchFile(filepath) {
    try {
      const watcher = fs.watch(filepath, () => {
        this._scheduleCheck(filepath);
      });
      watcher.on("error", () => { /* file may be deleted — handled in _checkFile */ });
      this._watchers.push(watcher);
    } catch {
      // File doesn't exist or can't be watched — skip
    }
  }

  _watchDir(dir) {
    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(dir, filename);
        if (this._hashes.has(fullPath)) {
          this._scheduleCheck(fullPath);
        }
      });
      watcher.on("error", () => { /* directory may be deleted */ });
      this._watchers.push(watcher);
    } catch {
      // Directory doesn't exist or can't be watched — skip
    }
  }

  _scheduleCheck(filepath) {
    // Debounce: reset timer on each change event
    const existing = this._debounceTimers.get(filepath);
    if (existing) clearTimeout(existing);

    this._debounceTimers.set(filepath, setTimeout(() => {
      this._debounceTimers.delete(filepath);
      this._checkFile(filepath);
    }, DEBOUNCE_MS));
  }

  _checkFile(filepath) {
    const currentHash = this._hashFile(filepath);
    const storedHash = this._hashes.get(filepath);

    if (!currentHash) {
      if (!this._alerted.has(filepath)) {
        this._alerted.add(filepath);
        const event = { type: "deleted", file: path.basename(filepath), time: new Date().toISOString() };
        this.events.push(event);
        this.emit("alert", event);
      }
      return;
    }

    if (storedHash && currentHash !== storedHash && !this._alerted.has(filepath)) {
      this._alerted.add(filepath);
      const event = { type: "modified", file: path.basename(filepath), time: new Date().toISOString() };
      this.events.push(event);
      this.emit("alert", event);
    }

    if (this.events.length > 100) this.events = this.events.slice(-100);
  }

  _findProtectedFiles() {
    if (this._isPackaged) {
      const asarPath = path.join(this.appDir, "resources", "app.asar");
      if (fs.existsSync(asarPath)) return [asarPath];
      const altPath = path.join(this.appDir, "resources", "app");
      if (fs.existsSync(altPath)) return [altPath];
      return [];
    }

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
}

module.exports = ImmuneSystem;
