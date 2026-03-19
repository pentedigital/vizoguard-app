const { apiCall } = require("./api");
const platform = require("./platform");

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

class LicenseManager {
  constructor(store) {
    this.store = store;
    this._timer = null;
    this._onStatusChange = null;
  }

  onStatusChange(callback) {
    this._onStatusChange = callback;
  }

  _emit(status) {
    if (this._onStatusChange) this._onStatusChange(status);
  }

  hasLicense() {
    return !!this.store.get("license.key");
  }

  getCached() {
    const license = this.store.get("license");
    if (!license) return null;

    return {
      key: license.key,
      deviceId: license.deviceId,
      status: license.status,
      expires: license.expires,
      lastCheck: license.lastSuccessfulCheck,
      vpnAccessUrl: license.vpnAccessUrl || null,
    };
  }

  isGracePeriodValid() {
    const lastCheck = this.store.get("license.lastSuccessfulCheck");
    if (!lastCheck) return false;
    return Date.now() - new Date(lastCheck).getTime() < GRACE_PERIOD_MS;
  }

  isExpired() {
    const expires = this.store.get("license.expires");
    if (!expires) return true;
    return new Date(expires) < new Date();
  }

  async activate(key) {
    // Validate key format before API call
    if (!/^VIZO-[0-9A-Fa-f]{4}(-[0-9A-Fa-f]{4}){3}$/.test(key)) {
      throw new Error("Invalid license key format. Expected VIZO-XXXX-XXXX-XXXX-XXXX");
    }

    const deviceId = await platform.getDeviceId();

    const result = await apiCall("/license", { key, device_id: deviceId });

    this.store.set("license", {
      key,
      deviceId,
      status: result.status,
      expires: result.expires,
      lastSuccessfulCheck: new Date().toISOString(),
      vpnAccessUrl: null,
    });

    // Provision VPN key
    try {
      const vpn = await apiCall("/vpn/create", { key });
      this.store.set("license.vpnAccessUrl", vpn.access_url);
    } catch (err) {
      console.error("VPN provisioning failed (non-fatal):", err.message || err.error);
    }

    return { success: true, status: result.status, expires: result.expires };
  }

  async validate() {
    const key = this.store.get("license.key");
    const deviceId = this.store.get("license.deviceId");
    if (!key || !deviceId) return { valid: false, reason: "no_license" };

    try {
      const result = await apiCall("/license", { key, device_id: deviceId });

      this.store.set("license.status", result.status);
      this.store.set("license.expires", result.expires);
      this.store.set("license.lastSuccessfulCheck", new Date().toISOString());

      // Fetch VPN key if not cached
      if (!this.store.get("license.vpnAccessUrl")) {
        try {
          const vpn = await apiCall("/vpn/get", { key });
          this.store.set("license.vpnAccessUrl", vpn.access_url);
        } catch { /* VPN key may not exist yet */ }
      }

      this._emit({ valid: true, status: result.status, expires: result.expires });
      return { valid: true, status: result.status, expires: result.expires };
    } catch (err) {
      if (err.status === 403 && (err.error || "").includes("expired")) {
        this.store.set("license.status", "expired");
        this._emit({ valid: false, reason: "expired" });
        return { valid: false, reason: "expired" };
      }

      if (err.status === 403 && (err.error || "").includes("suspended")) {
        this.store.set("license.status", "suspended");
        this._emit({ valid: false, reason: "suspended" });
        return { valid: false, reason: "suspended" };
      }

      // Any other 403 — treat as invalid (don't fall through to grace period)
      if (err.status === 403) {
        this.store.set("license.status", "invalid");
        this._emit({ valid: false, reason: "invalid" });
        return { valid: false, reason: "invalid" };
      }

      // Network error — check grace period
      if (this.isGracePeriodValid() && !this.isExpired()) {
        this._emit({ valid: true, status: "offline", expires: this.store.get("license.expires") });
        return { valid: true, status: "offline", expires: this.store.get("license.expires") };
      }

      this._emit({ valid: false, reason: "grace_expired" });
      return { valid: false, reason: "grace_expired" };
    }
  }

  startPeriodicCheck() {
    this.stopPeriodicCheck();
    this._timer = setInterval(() => this.validate(), CHECK_INTERVAL_MS);
  }

  stopPeriodicCheck() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  clear() {
    this.stopPeriodicCheck();
    this.store.delete("license");
  }
}

module.exports = LicenseManager;
