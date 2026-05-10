const { EventEmitter } = require("events");
const path = require("path");
const fs = require("fs");

// LRU cache for URL checks
const CACHE_MAX = 10000;
const CACHE_TTL = 3600000; // 1 hour

class ThreatChecker extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this._cache = new Map();
    this._blocklist = new Set();
    this._suspiciousTlds = new Set([
      ".tk", ".ml", ".ga", ".cf", ".gq", ".xyz", ".top", ".club",
      ".work", ".buzz", ".live", ".icu", ".cam", ".rest",
    ]);
    this._brandNames = [
      "paypal", "apple", "google", "microsoft", "amazon", "netflix",
      "facebook", "instagram", "whatsapp", "telegram", "chase", "wellsfargo",
      "bankofamerica", "citibank", "dropbox", "icloud",
    ];
    this._dangerousExtensions = [
      ".exe", ".msi", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".scr",
      ".pif", ".com", ".hta", ".wsf", ".apk", ".dmg", ".pkg", ".deb",
      ".rpm", ".app", ".jar", ".py", ".sh",
    ];
    this._loadBlocklist();
    // Periodic cache sweep to prevent unbounded memory growth from expired entries
    this._cacheSweepTimer = setInterval(() => this._sweepCache(), 5 * 60 * 1000);
    if (this._cacheSweepTimer.unref) this._cacheSweepTimer.unref();
  }

  _sweepCache() {
    const now = Date.now();
    let removed = 0;
    for (const [url, entry] of this._cache) {
      if (now - entry.time > CACHE_TTL) {
        this._cache.delete(url);
        removed++;
      }
    }
    if (removed > 0 && process.env.NODE_ENV !== 'test') {
      console.log(`[threat-checker] Cache sweep: removed ${removed} expired entries`);
    }
  }

  _loadBlocklist() {
    const blocklistPath = path.join(this.dataDir, "malicious-domains.txt");
    try {
      if (fs.existsSync(blocklistPath)) {
        const data = fs.readFileSync(blocklistPath, "utf8");
        data.split("\n").forEach((line) => {
          const domain = line.trim().toLowerCase();
          if (domain && !domain.startsWith("#")) this._blocklist.add(domain);
        });
        console.log(`Loaded ${this._blocklist.size} blocked domains`);
      } else {
        console.warn("Blocklist file not found — domain blocklist protection inactive");
      }
    } catch (e) {
      console.error("Failed to load blocklist:", e.message);
    }
  }

  // Periodic blocklist update — fetches from server every 24 hours
  startAutoUpdate() {
    if (this._updateTimer) return;
    this._autoUpdateStopped = false;
    // Initial update after 60 seconds (don't block startup)
    this._updateTimer = setTimeout(() => {
      // Guard: if stopAutoUpdate was called during the 60s wait or while
      // _fetchBlocklist was awaiting, don't start the interval
      if (this._autoUpdateStopped) return;
      this._fetchBlocklist();
      if (this._autoUpdateStopped) return;
      // Then every 24 hours
      this._updateTimer = setInterval(() => this._fetchBlocklist(), 24 * 60 * 60 * 1000);
    }, 60000);
  }

  stopAutoUpdate() {
    this._autoUpdateStopped = true;
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }
    if (this._cacheSweepTimer) {
      clearInterval(this._cacheSweepTimer);
      this._cacheSweepTimer = null;
    }
  }

  async _fetchBlocklist() {
    const https = require("https");
    const blocklistPath = path.join(this.dataDir, "malicious-domains.txt");
    const tmpPath = blocklistPath + ".tmp";

    try {
      const data = await new Promise((resolve, reject) => {
        const req = https.get("https://vizoguard.com/api/blocklist", (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Blocklist fetch: HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        });
        req.setTimeout(15000, () => { req.destroy(new Error("Blocklist fetch timeout")); });
        req.on("error", reject);
      });

      // Validate: must have at least a few domains, each line a valid domain
      const lines = data.split("\n").filter(l => l.trim() && !l.startsWith("#"));
      if (lines.length < 10) {
        console.warn("Blocklist update: too few entries, skipping");
        return;
      }

      // Write to temp file, then atomically rename
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, blocklistPath);

      // Reload in-memory blocklist
      this._blocklist.clear();
      lines.forEach((line) => {
        const domain = line.trim().toLowerCase();
        if (domain) this._blocklist.add(domain);
      });

      // Clear URL cache so new blocklist entries take effect
      this._cache.clear();

      console.log(`Blocklist updated: ${this._blocklist.size} domains`);
    } catch (e) {
      // Non-fatal — keep using existing blocklist
      console.error("Blocklist auto-update failed:", e.message);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  _cacheGet(url) {
    const entry = this._cache.get(url);
    if (!entry) return null;
    if (Date.now() - entry.time > CACHE_TTL) {
      this._cache.delete(url);
      return null;
    }
    return entry.result;
  }

  _cacheSet(url, result) {
    if (this._cache.size >= CACHE_MAX) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(url, { result, time: Date.now() });
  }

  async checkUrl(url) {
    const cached = this._cacheGet(url);
    if (cached !== null) return cached;

    const result = await this._analyzeUrl(url);
    this._cacheSet(url, result);

    if (result.risk === "critical" || result.risk === "high") {
      this.emit("threat", { url, ...result });
    }

    return result;
  }

  async _analyzeUrl(url) {
    return new Promise((resolve) => {
      setImmediate(() => {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          resolve({ risk: "low", checks: [] });
          return;
        }

        const hostname = parsed.hostname.toLowerCase();
        const checks = [];

        // 1. Local blocklist
        if (this._blocklist.has(hostname)) {
          checks.push({ name: "blocklist", risk: "critical", detail: "Domain on blocklist" });
        }

        // 2. Suspicious TLD
        const tld = "." + hostname.split(".").pop();
        if (this._suspiciousTlds.has(tld)) {
          checks.push({ name: "suspicious_tld", risk: "medium", detail: `Suspicious TLD: ${tld}` });
        }

        // 3. Brand impersonation
        // Extract the registrable domain (e.g., "secure-amazon.com" → "secure-amazon")
        const parts = hostname.split(".");
        const sld = parts.length >= 2 ? parts[parts.length - 2] : "";
        for (const brand of this._brandNames) {
          if (!hostname.includes(brand)) continue;
          // Legitimate: the SLD starts with the brand name (amazon.com, amazonaws.com, amazoncdn.net)
          // or is a subdomain of a brand-owned domain (maps.google.com, api.paypal.com)
          if (sld.startsWith(brand) || (parts.length >= 3 && parts[parts.length - 2] === brand)) {
            continue; // Brand-owned domain
          }
          // Brand name embedded elsewhere (e.g., "secure-amazon-login.com", "paypa1-verify.net")
          checks.push({ name: "brand_impersonation", risk: "high", detail: `Possible ${brand} impersonation` });
          break;
        }

        // 4. IP address in URL
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
          checks.push({ name: "ip_address", risk: "medium", detail: "IP address used instead of domain" });
        }

        // 5. Excessive subdomains
        if (hostname.split(".").length > 4) {
          checks.push({ name: "subdomains", risk: "medium", detail: "Excessive subdomains" });
        }

        // 6. Dangerous file download
        const urlPath = parsed.pathname.toLowerCase();
        for (const ext of this._dangerousExtensions) {
          if (urlPath.endsWith(ext)) {
            checks.push({ name: "dangerous_download", risk: "high", detail: `Dangerous file type: ${ext}` });
            break;
          }
        }

        // 7. Homoglyph detection (basic)
        if (/[а-яА-Я]/.test(hostname) || hostname.startsWith("xn--")) {
          checks.push({ name: "homoglyph", risk: "high", detail: "IDN/punycode detected — possible lookalike domain" });
        }

        // 8. Phishing keywords in URL
        const phishingKeywords = ["login", "verify", "update", "secure", "account", "confirm", "suspend", "locked"];
        const urlLower = url.toLowerCase();
        const keywordHits = phishingKeywords.filter((k) => urlLower.includes(k));
        if (keywordHits.length >= 2) {
          checks.push({ name: "phishing_keywords", risk: "medium", detail: `Phishing indicators: ${keywordHits.join(", ")}` });
        }

        // Calculate overall risk
        const riskLevels = { critical: 4, high: 3, medium: 2, low: 1 };
        let maxRisk = "low";
        for (const check of checks) {
          if (riskLevels[check.risk] > riskLevels[maxRisk]) {
            maxRisk = check.risk;
          }
        }

        resolve({ risk: maxRisk, checks, hostname });
      });
    });
  }

}

module.exports = ThreatChecker;
