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
    const elapsed = Date.now() - new Date(lastCheck).getTime();
    if (elapsed < 0) return false; // clock skew
    return elapsed < GRACE_PERIOD_MS;
  }

  isExpired() {
    const expires = this.store.get("license.expires");
    if (!expires) return true;
    return new Date(expires).getTime() < Date.now();
  }

  async activate(key) {
    // Validate key format before API call
    if (!/^VIZO-[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(key)) {
      throw new Error("Invalid license key format. Expected VIZO-XXXX-XXXX-XXXX-XXXX");
    }

    const deviceId = await platform.getDeviceId();

    let result;
    try {
      result = await apiCall("/license", { key, device_id: deviceId });
    } catch (err) {
      if (err.httpStatus === 403 && err.status === "device_mismatch") {
        throw new Error("This license is already activated on another device. Contact support@vizoguard.com to transfer.");
      }
      throw err;
    }

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
      const vpn = await apiCall("/vpn/create", { key, device_id: deviceId });
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

      const previousStatus = this.store.get("license.status");
      this.store.set("license.status", result.status);
      this.store.set("license.expires", result.expires);

      // Clear stale VPN URL on status recovery
      if ((previousStatus === "suspended" || previousStatus === "expired") && result.status === "active") {
        this.store.delete("license.vpnAccessUrl");
      }
      this.store.set("license.lastSuccessfulCheck", new Date().toISOString());

      // Fetch VPN key if not cached
      if (!this.store.get("license.vpnAccessUrl")) {
        try {
          const vpn = await apiCall("/vpn/get", { key, device_id: deviceId });
          this.store.set("license.vpnAccessUrl", vpn.access_url);
        } catch (vpnErr) {
          // 403 = revoked/mismatch — clear stale key (#23)
          if (vpnErr.httpStatus === 403) {
            this.store.delete("license.vpnAccessUrl");
          }
          // 404 = not provisioned yet — ignore
        }
      }

      this._emit({ valid: true, status: result.status, expires: result.expires });
      return { valid: true, status: result.status, expires: result.expires };
    } catch (err) {
      // Check HTTP status code (httpStatus) — not err.status which is the JSON body field
      if (err.httpStatus === 403 && err.status === "expired") {
        this.store.set("license.status", "expired");
        this.store.delete("license.vpnAccessUrl");
        this._emit({ valid: false, reason: "expired" });
        return { valid: false, reason: "expired" };
      }

      if (err.httpStatus === 403 && err.status === "suspended") {
        this.store.set("license.status", "suspended");
        this.store.delete("license.vpnAccessUrl");
        this._emit({ valid: false, reason: "suspended" });
        return { valid: false, reason: "suspended" };
      }

      // Any other 403 — treat as invalid (don't fall through to grace period)
      if (err.httpStatus === 403) {
        this.store.set("license.status", "invalid");
        this._emit({ valid: false, reason: "invalid" });
        return { valid: false, reason: "invalid" };
      }

      // Network error — check grace period
      console.error("License validation failed (network):", err.message || err);
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
