const { EventEmitter } = require("events");
const net = require("net");

const MAX_EXPLANATIONS = 20;
const MAX_RISKY_CONNECTIONS = 12;

const PRIVATE_HOST_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^fe80:/i,
  /^fc[0-9a-f]:/i,
  /^fd[0-9a-f]:/i,
  /^localhost$/i,
];

const SENSITIVE_PORTS = new Set([
  "21", "23", "25", "110", "143", "445", "3389", "5900", "6667",
]);

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function parseEndpoint(address) {
  const value = String(address || "");
  const arrowParts = value.split("->");
  const remote = (arrowParts[1] || arrowParts[0] || "").trim();
  if (!remote) return { host: "", port: "" };

  const bracketedIpv6 = remote.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketedIpv6) {
    return { host: bracketedIpv6[1], port: bracketedIpv6[2] || "" };
  }

  const hostPort = remote.match(/^([^:\s]+):(\d+)$/);
  if (hostPort) {
    return { host: hostPort[1], port: hostPort[2] };
  }

  return { host: remote.replace(/^\[|\]$/g, ""), port: "" };
}

function isPrivateHost(host) {
  const normalized = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isIpAddress(host) {
  return net.isIP(String(host || "").replace(/^\[|\]$/g, "")) !== 0;
}

function toCount(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function safeProcessName(processName) {
  return String(processName || "Unknown app").replace(/[^\w.\- ]/g, "").slice(0, 48) || "Unknown app";
}

class PrivacyIntelligence extends EventEmitter {
  constructor(options = {}) {
    super();
    this._explanations = [];
    this._riskyConnections = new Map();
    this._lastScan = { active: 0, total: 0 };
    this._vpnConnected = false;
    this._proxyRunning = false;
    this._threatsBlocked = 0;
    this._now = options.now || (() => Date.now());
  }

  setVpnState(connected) {
    const next = !!connected;
    if (this._vpnConnected === next) {
      return;
    }
    this._vpnConnected = next;
    this._emitUpdate();
  }

  setProxyState(running) {
    const next = !!running;
    if (this._proxyRunning === next) {
      return;
    }
    this._proxyRunning = next;
    this._emitUpdate();
  }

  updateScan(data = {}) {
    this._lastScan = {
      active: toCount(data.active ?? data.activeConnections),
      total: toCount(data.total),
    };
    this._emitUpdate();
  }

  recordConnection(conn = {}) {
    const endpoint = parseEndpoint(conn.address);
    const processName = safeProcessName(conn.process);
    const risks = [];

    if (!endpoint.host) return;
    if (isPrivateHost(endpoint.host)) return;
    if (endpoint.port && SENSITIVE_PORTS.has(endpoint.port)) {
      risks.push({
        severity: "medium",
        title: "Sensitive network service",
        detail: `${processName} opened a connection to port ${endpoint.port}. This port is commonly used by remote access, mail, or legacy services.`,
      });
    }
    if (isIpAddress(endpoint.host) && !isPrivateHost(endpoint.host)) {
      risks.push({
        severity: "low",
        title: "Direct IP connection",
        detail: `${processName} connected directly to ${endpoint.host}. Direct IP traffic is harder to explain than a named domain and is worth watching if unexpected.`,
      });
    }

    if (risks.length === 0) return;

    const key = `${processName}:${endpoint.host}:${endpoint.port}`;
    const finding = {
      key,
      process: processName,
      host: endpoint.host,
      port: endpoint.port,
      severity: risks.some((r) => r.severity === "medium") ? "medium" : "low",
      title: risks[0].title,
      detail: risks[0].detail,
      lastSeen: new Date(this._now()).toISOString(),
    };
    this._riskyConnections.set(key, finding);
    if (this._riskyConnections.size > MAX_RISKY_CONNECTIONS) {
      this._riskyConnections.delete(this._riskyConnections.keys().next().value);
    }
    this._addExplanation({
      type: "connection",
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
    });
    this._emitUpdate();
  }

  recordThreat(data = {}) {
    const reportedTotal = toCount(data.total);
    this._threatsBlocked = Math.max(this._threatsBlocked, reportedTotal || this._threatsBlocked + 1);
    const host = (() => {
      try { return new URL(data.url).hostname; } catch { return String(data.url || "unknown domain"); }
    })();
    const checks = Array.isArray(data.checks) ? data.checks.map((c) => c.detail || c.name).filter(Boolean) : [];
    const reason = checks.length > 0 ? checks[0] : `Risk level: ${data.risk || "high"}`;
    this._addExplanation({
      type: "threat",
      severity: data.risk === "critical" ? "critical" : "high",
      title: "Threat blocked",
      detail: `Vizoguard blocked ${host} before the connection completed. ${reason}.`,
    });
    this._emitUpdate();
  }

  getInsights() {
    const findings = [];
    let score = 100;

    if (!this._vpnConnected) {
      score -= 35;
      findings.push({
        severity: "high",
        title: "VPN tunnel is off",
        detail: "Your public IP address is not masked. Turn on the VPN before using public Wi-Fi or sensitive accounts.",
      });
    }

    if (!this._proxyRunning) {
      score -= 20;
      findings.push({
        severity: "medium",
        title: "Threat proxy is unavailable",
        detail: "Device-level web threat filtering is not currently accepting traffic.",
      });
    }

    const risky = Array.from(this._riskyConnections.values()).slice(-MAX_RISKY_CONNECTIONS).reverse();
    if (risky.length > 0) {
      score -= Math.min(20, risky.length * 4);
      findings.push({
        severity: risky.some((item) => item.severity === "medium") ? "medium" : "low",
        title: `${risky.length} connection${risky.length === 1 ? "" : "s"} worth reviewing`,
        detail: "Some apps made direct IP or sensitive-port connections. Review the explanations below if this behavior was unexpected.",
      });
    }

    if (this._lastScan.active > 80) {
      score -= 10;
      findings.push({
        severity: "low",
        title: "High connection activity",
        detail: `${this._lastScan.active} active network connections were observed. This can be normal during heavy browsing or updates.`,
      });
    }

    if (findings.length === 0) {
      findings.push({
        severity: "good",
        title: "Privacy posture looks strong",
        detail: "VPN masking, threat filtering, and connection monitoring are active.",
      });
    }

    const scoreValue = clampScore(score);
    return {
      score: scoreValue,
      label: scoreValue >= 85 ? "Protected" : scoreValue >= 65 ? "Watch" : "At Risk",
      vpnConnected: this._vpnConnected,
      proxyRunning: this._proxyRunning,
      activeConnections: this._lastScan.active,
      threatsBlocked: this._threatsBlocked,
      findings,
      riskyConnections: risky,
      explanations: this._explanations.slice(),
    };
  }

  _addExplanation(entry) {
    this._explanations.unshift({
      timestamp: new Date(this._now()).toISOString(),
      ...entry,
    });
    if (this._explanations.length > MAX_EXPLANATIONS) this._explanations.length = MAX_EXPLANATIONS;
  }

  _emitUpdate() {
    this.emit("update", this.getInsights());
  }
}

module.exports = PrivacyIntelligence;
