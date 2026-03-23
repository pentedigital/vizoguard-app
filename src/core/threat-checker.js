const { EventEmitter } = require("events");
const crypto = require("crypto");
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
  }

  // Blocklist is loaded once at startup from the local file.
  // Updates are delivered via app updates (electron-updater).
  // A future enhancement will add periodic API-based blocklist refresh.
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

    const result = this._analyzeUrl(url);
    this._cacheSet(url, result);

    if (result.risk === "critical" || result.risk === "high") {
      this.emit("threat", { url, ...result });
    }

    return result;
  }

  _analyzeUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { risk: "low", checks: [] };
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
    for (const brand of this._brandNames) {
      if (hostname.includes(brand)) {
        // Allow legitimate domains: brand.com, *.brand.com, and known secondary TLDs
        const legit = hostname === `${brand}.com` || hostname === `www.${brand}.com`
          || hostname.endsWith(`.${brand}.com`) || hostname.endsWith(`.${brand}.net`)
          || hostname.endsWith(`.${brand}.org`) || hostname.endsWith(`.${brand}.io`)
          || hostname.endsWith(`${brand}apis.com`) || hostname.endsWith(`${brand}cdn.com`)
          || hostname.endsWith(`${brand}cdn.net`) || hostname.endsWith(`${brand}online.com`)
          || hostname.endsWith(`${brand}content.com`) || hostname.endsWith(`${brand}objects.com`);
        if (!legit) {
          checks.push({ name: "brand_impersonation", risk: "high", detail: `Possible ${brand} impersonation` });
          break;
        }
      }
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

    return { risk: maxRisk, checks, hostname };
  }

}

module.exports = ThreatChecker;
