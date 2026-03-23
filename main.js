const { app, BrowserWindow, ipcMain, clipboard, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const Store = require("electron-store");
const LicenseManager = require("./src/license");
const VpnManager = require("./src/vpn");
const { ThreatChecker, ConnectionMonitor, SecurityProxy, ImmuneSystem } = require("./src/core");
const { createTray, updateMenu, destroyTray } = require("./src/tray");
const Updater = require("./src/updater");
const { apiCall } = require("./src/api");

// Single instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Resilient store — recover from corrupted JSON (#25)
let store;
try {
  store = new Store();
} catch (e) {
  console.error("Store corrupted, resetting:", e.message);
  try { fs.unlinkSync(path.join(app.getPath("userData"), "config.json")); } catch {}
  store = new Store();
}
const license = new LicenseManager(store);

// Data directory for threat lists
const dataDir = path.join(app.getPath("userData"), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Initialize security engine
const threatChecker = new ThreatChecker(dataDir);
const connectionMonitor = new ConnectionMonitor();
const securityProxy = new SecurityProxy(threatChecker);
const immuneSystem = new ImmuneSystem(app.isPackaged ? path.dirname(app.getPath("exe")) : __dirname);
const vpn = new VpnManager(store);
const updater = new Updater();

let mainWindow = null;
let tray = null;

// ── Window Management ─────────────────────────

function createWindow(page) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, "ui", page));
    mainWindow.show();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 480,
    height: 780,
    minHeight: 700,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    frame: false,
    backgroundColor: "#000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "ui", page));

  mainWindow.on("close", (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  return mainWindow;
}

function showPage(page) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, "ui", page));
    mainWindow.show();
  } else {
    createWindow(page);
  }
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Tray ──────────────────────────────────────

const trayCallbacks = {
  showDashboard: () => showPage("dashboard.html"),
  copyVpnKey: () => {
    const vpnUrl = store.get("license.vpnAccessUrl");
    if (vpnUrl) clipboard.writeText(vpnUrl);
  },
  quit: async () => {
    // Graceful shutdown
    license.stopPeriodicCheck();
    connectionMonitor.stop();
    immuneSystem.stop();
    securityProxy.stop();
    await vpn.disconnect().catch(() => {});
    destroyTray();
    mainWindow = null;
    app.exit(0);
  },
};

// ── Connection History ────────────────────────

// Connection history — stored LOCALLY only, never sent to servers
function logConnection(action, details = {}) {
  const history = store.get('connectionHistory', []);
  history.unshift({
    timestamp: new Date().toISOString(),
    action, // 'connected', 'disconnected', 'threat_blocked', 'error'
    ...details
  });
  // Keep last 100 entries
  if (history.length > 100) history.length = 100;
  store.set('connectionHistory', history);
}

// ── Weekly Stats ──────────────────────────────

function updateWeeklyStats(type) {
  const key = 'weeklyStats';
  let stats = store.get(key, { threats: 0, connections: 0, timeProtected: 0, weekStart: new Date().toISOString() });

  // Reset if more than 7 days old — fall through to process current increment
  if (new Date() - new Date(stats.weekStart) > 7 * 24 * 60 * 60 * 1000) {
    stats = { threats: 0, connections: 0, timeProtected: 0, weekStart: new Date().toISOString() };
  }

  if (type === 'threat') stats.threats++;
  if (type === 'connection') stats.connections++;
  if (type === 'time') stats.timeProtected += 60; // add 60 seconds
  store.set(key, stats);
}

// 60-second interval to increment timeProtected while VPN is connected
let _weeklyTimeInterval = null;

// ── Security Engine Events ────────────────────

// Single source of truth for threat events — proxy owns the count
securityProxy.on("blocked", (data) => {
  // Log domain only, not full URL
  const domain = (() => { try { return new URL(data.url).hostname; } catch { return data.url; } })();
  logConnection('threat_blocked', { url: domain, risk: data.risk });
  updateWeeklyStats('threat');
  sendToRenderer("threat:blocked", {
    url: data.url,
    risk: data.risk,
    total: securityProxy.threatsBlocked,
  });
  updateMenu(true, trayCallbacks);
});

connectionMonitor.on("scan", (data) => {
  sendToRenderer("connections:update", data);
});

immuneSystem.on("alert", (data) => {
  sendToRenderer("immune:alert", data);
});

// ── VPN Events ────────────────────────────────

let _vpnConnectTime = null;

vpn.on("connected", () => {
  _vpnConnectTime = Date.now();
  const serverHost = vpn.getServerHost ? vpn.getServerHost() : undefined;
  logConnection('connected', serverHost ? { server: serverHost } : {});
  updateWeeklyStats('connection');
  // Start 60-second ticker for timeProtected
  if (_weeklyTimeInterval) clearInterval(_weeklyTimeInterval);
  _weeklyTimeInterval = setInterval(() => {
    if (vpn.isConnected) updateWeeklyStats('time');
  }, 60000);
  sendToRenderer("vpn:state", { connected: true });
  updateMenu(true, trayCallbacks);
  // Update tray tooltip with weekly stats (after updateMenu so it is not overwritten)
  const stats = store.get('weeklyStats', { threats: 0 });
  try { tray && tray.setToolTip && tray.setToolTip(`Vizoguard — ${stats.threats} threats blocked this week`); } catch {}
});

vpn.on("disconnected", () => {
  const duration = _vpnConnectTime ? Math.floor((Date.now() - _vpnConnectTime) / 1000) : undefined;
  logConnection('disconnected', duration !== undefined ? { duration } : {});
  _vpnConnectTime = null;
  if (_weeklyTimeInterval) { clearInterval(_weeklyTimeInterval); _weeklyTimeInterval = null; }
  sendToRenderer("vpn:state", { connected: false });
  updateMenu(false, trayCallbacks);
});

vpn.on("error", (err) => {
  // Sanitize error — strip IP:port details before sending to renderer
  const safeMsg = (err.message || "VPN error").replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g, "[redacted]");
  logConnection('error', { message: safeMsg });
  sendToRenderer("vpn:error", { message: safeMsg });
});

// ── Updater Events ────────────────────────────

updater.on("downloaded", (info) => {
  sendToRenderer("update:ready", { version: info.version });
});

updater.on("not-available", () => {
  sendToRenderer("update:not-available", {});
});

updater.on("available", (info) => {
  sendToRenderer("update:available", { version: info.version });
});

updater.on("error", (err) => {
  sendToRenderer("update:error", { message: err.message });
});

// ── IPC Handlers ──────────────────────────────

ipcMain.handle("license:activate", async (_event, key) => {
  if (typeof key !== "string" || key.length > 128) {
    return { success: false, error: "Invalid key format" };
  }
  try {
    const result = await license.activate(key);
    // Return immediately — renderer shows success animation,
    // then calls app:showDashboard to navigate + start engine
    return result;
  } catch (err) {
    return { success: false, error: err.error || err.message || "Activation failed" };
  }
});

ipcMain.handle("license:status", () => {
  const cached = license.getCached();
  if (!cached) return null;
  const { vpnAccessUrl, key, ...safe } = cached;
  safe.key = key ? key.slice(0, 5) + "****-****-****-" + key.slice(-4) : null;
  return safe;
});

ipcMain.handle("vpn:connect", async () => {
  try {
    // Validate license with server before connecting
    const validation = await license.validate();
    if (!validation.valid) {
      return { success: false, error: validation.reason || "License invalid" };
    }
    await vpn.connect();
    if (!vpn.isConnected) {
      return { success: false, error: "Connection was cancelled" };
    }
    return { success: true };
  } catch (err) {
    // Surface tunnel/connection errors to the UI (vpnConnect() return value is often ignored)
    const safeMsg = (err.message || "VPN error").replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g, "[redacted]");
    sendToRenderer("vpn:error", { message: safeMsg });
    sendToRenderer("vpn:state", { connected: false });
    return { success: false, error: safeMsg };
  }
});

ipcMain.handle("vpn:disconnect", async () => {
  try {
    await vpn.disconnect();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("vpn:status", () => {
  return { connected: vpn.isConnected };
});

ipcMain.handle("vpn:getKey", async () => {
  const cached = license.getCached();
  if (cached && cached.vpnAccessUrl) return { access_url: cached.vpnAccessUrl };

  try {
    const key = store.get("license.key");
    const deviceId = store.get("license.deviceId");

    // Try /vpn/get first (retrieves existing key with device verification)
    try {
      const result = await apiCall("/vpn/get", { key, device_id: deviceId });
      store.set("license.vpnAccessUrl", result.access_url);
      return result;
    } catch (getErr) {
      // 404 = no key provisioned yet, fall through to create
      if (getErr.httpStatus !== 404) throw getErr;
    }

    // Create a new key
    const result = await apiCall("/vpn/create", { key, device_id: deviceId });
    store.set("license.vpnAccessUrl", result.access_url);
    return result;
  } catch (err) {
    return { error: err.error || "Could not fetch VPN key" };
  }
});

ipcMain.handle("vpn:copyKey", () => {
  const vpnUrl = store.get("license.vpnAccessUrl");
  if (vpnUrl) {
    clipboard.writeText(vpnUrl);
    return { success: true };
  }
  return { success: false, error: "No VPN key available" };
});

ipcMain.handle("security:stats", () => {
  return {
    threatsBlocked: securityProxy.threatsBlocked, // single source of truth (proxy owns the count)
    requestsScanned: securityProxy.requestsScanned,
    activeConnections: connectionMonitor.activeConnections,
    immuneEvents: immuneSystem.events.length,
    proxyRunning: !!securityProxy._server,
    vpnConnected: vpn.isConnected,
  };
});

ipcMain.handle("update:install", () => {
  updater.install();
});

ipcMain.handle("app:openExternal", (_event, url) => {
  // Only allow exact support mailto
  if (url === "mailto:support@vizoguard.com") {
    shell.openExternal(url);
    return;
  }
  try {
    const parsed = new URL(url);
    const allowedHosts = ["vizoguard.com", "www.vizoguard.com", "getoutline.org", "www.getoutline.org"];
    if (parsed.protocol === "https:" && allowedHosts.includes(parsed.hostname)) {
      shell.openExternal(url);
    }
  } catch {}
});

ipcMain.handle("app:quit", () => trayCallbacks.quit());
ipcMain.handle("app:minimize", () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); });
ipcMain.handle("app:close", () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); });

ipcMain.handle("app:version", () => app.getVersion());

ipcMain.handle("update:check", () => {
  updater.check(); // Fire-and-forget; results come via update events
});

// ── Engine Metrics ────────────────────────────

function getEngineMetrics() {
  const stats = {
    proxy: {
      requestsPerSec: 0,
      cachedEntries: 0,
      threatsBlocked: 0,
      activeConnections: 0,
      threatDbLoaded: true
    },
    vpn: {
      cipher: 'ChaCha20-Poly1305',
      serverHost: '—',
      ipMasked: false,
      dnsEncrypted: false
    },
    immune: {
      layers: [
        { name: 'Blocklist', level: 0 },
        { name: 'Behaviors', level: 0 },
        { name: 'Persistence', level: 0 },
        { name: 'Sentinel', level: 0 }
      ]
    }
  };

  // Populate from actual modules if available
  try {
    if (typeof threatChecker !== 'undefined' && threatChecker) {
      stats.proxy.cachedEntries = threatChecker._cache?.size || 0;
      stats.proxy.threatsBlocked = securityProxy ? securityProxy.threatsBlocked : 0;
      stats.immune.layers[0].level = threatChecker._cache?.size > 0 ? 98 : 0;
    }
    if (typeof connectionMonitor !== 'undefined' && connectionMonitor) {
      stats.proxy.activeConnections = connectionMonitor.activeConnections || 0;
      stats.immune.layers[1].level = connectionMonitor.activeConnections > 0 ? 64 : 0;
    }
    if (typeof securityProxy !== 'undefined' && securityProxy) {
      const now = Date.now();
      const current = securityProxy.requestsScanned || 0;
      if (!securityProxy._lastSampleTime) {
        securityProxy._lastSampleTime = now;
        securityProxy._lastSampleCount = current;
      }
      const elapsed = (now - securityProxy._lastSampleTime) / 1000;
      stats.proxy.requestsPerSec = elapsed > 0 ? Math.round((current - securityProxy._lastSampleCount) / elapsed) : 0;
      securityProxy._lastSampleTime = now;
      securityProxy._lastSampleCount = current;
    }
    if (typeof vpn !== 'undefined' && vpn) {
      stats.vpn.ipMasked = vpn?.isConnected || false;
      stats.vpn.dnsEncrypted = vpn?.isConnected || false;
      stats.vpn.serverHost = vpn.getServerHost?.() || '—';
      stats.vpn.uptime = vpn && vpn.isConnected && _vpnConnectTime ? Math.floor((Date.now() - _vpnConnectTime) / 1000) : 0;
    }
    stats.immune.layers[2].level = 0; // Persistence — not yet implemented
    stats.immune.layers[3].level = 0; // Sentinel — not yet implemented
  } catch (e) {
    // Non-fatal — return defaults
  }

  return stats;
}

function flattenEngineMetrics() {
  var stats = getEngineMetrics();
  return {
    cipher: stats.vpn.cipher,
    serverHost: stats.vpn.serverHost,
    ipMasked: stats.vpn.ipMasked,
    dnsEncrypted: stats.vpn.dnsEncrypted,
    requestsPerSec: stats.proxy.requestsPerSec,
    cachedEntries: stats.proxy.cachedEntries,
    threatsBlocked: stats.proxy.threatsBlocked,
    activeConnections: stats.proxy.activeConnections,
    threatDbLoaded: stats.proxy.threatDbLoaded,
    uptime: stats.vpn.uptime || 0,
    layers: stats.immune.layers.map(l => l.level)
  };
}

// Engine metrics for the bonnet view
ipcMain.handle("engine:metrics", () => {
  return flattenEngineMetrics();
});

const engineIntervals = new Map();

ipcMain.on("engine:subscribe", (event) => {
  // Single-window app: clear ALL existing intervals on new subscribe
  // to prevent accumulation when pages navigate
  for (const [oldId, oldInterval] of engineIntervals) {
    clearInterval(oldInterval);
  }
  engineIntervals.clear();

  const id = event.sender.id;

  const interval = setInterval(() => {
    if (event.sender.isDestroyed()) {
      clearInterval(interval);
      engineIntervals.delete(id);
      return;
    }
    event.sender.send("engine:update", flattenEngineMetrics());
  }, 1000);
  engineIntervals.set(id, interval);

  // Clean up when the webContents is destroyed
  event.sender.once("destroyed", () => {
    if (engineIntervals.has(id)) {
      clearInterval(engineIntervals.get(id));
      engineIntervals.delete(id);
    }
  });
});

ipcMain.on("engine:unsubscribe", (event) => {
  const id = event.sender.id;
  if (engineIntervals.has(id)) {
    clearInterval(engineIntervals.get(id));
    engineIntervals.delete(id);
  }
});

// ── Settings Persistence ──────────────────────

ipcMain.handle("settings:get", () => ({
  autoConnect: store.get('autoConnect', false),
  notifications: store.get('notifications', true),
}));
const ALLOWED_SETTINGS = ['autoConnect', 'notifications', 'ui.engineExpanded', 'ui.settingsOpen'];
ipcMain.handle("settings:get-one", (_e, key) => {
  if (!ALLOWED_SETTINGS.includes(key)) return undefined;
  return store.get(key);
});
ipcMain.handle("settings:set", (_e, key, value) => {
  if (!ALLOWED_SETTINGS.includes(key)) return;
  store.set(key, value);
});

ipcMain.handle("history:get", () => store.get('connectionHistory', []));
ipcMain.handle("history:clear", () => { store.set('connectionHistory', []); });

ipcMain.handle("stats:weekly", () => store.get('weeklyStats', { threats: 0, connections: 0, timeProtected: 0 }));

ipcMain.handle("app:showDashboard", async () => {
  showPage("dashboard.html");
  updateMenu(true, trayCallbacks);
  license.startPeriodicCheck();
  await startSecurityEngine();
});

// ── Security Engine Start ─────────────────────

let _engineStarted = false;
async function startSecurityEngine() {
  if (_engineStarted) return;
  _engineStarted = true;
  try {
    await securityProxy.start();
  } catch (e) {
    _engineStarted = false;
    console.error("Security proxy failed to start:", e.message);
    sendToRenderer("security:error", { message: `Security proxy unavailable: ${e.message}` });
    return;
  }
  connectionMonitor.start();
  immuneSystem.start();
  console.log("Security engine started");
}

// ── License Status Change ─────────────────────

license.onStatusChange((status) => {
  sendToRenderer("status:changed", status);

  if (!status.valid) {
    vpn._licenseValid = false;
    showPage("expired.html");
    updateMenu(false, trayCallbacks);
    securityProxy.stop();
    connectionMonitor.stop();
    immuneSystem.stop();
    _engineStarted = false;
    vpn.disconnect().catch(() => {});
  } else {
    vpn._licenseValid = true;
    updateMenu(true, trayCallbacks);
  }
});

// ── App Lifecycle ─────────────────────────────

app.whenReady().then(async () => {
  // Restore proxy on any exit (including force-kill via SIGTERM)
  const platform = require("./src/platform");
  process.on('SIGTERM', () => { try { platform.clearProxy(); } catch {} process.exit(0); });
  process.on('SIGINT', () => { try { platform.clearProxy(); } catch {} process.exit(0); });
  // Also clear proxy on app startup in case previous instance was killed
  platform.clearProxy().catch(() => {});

  // Reapply proxy after sleep/resume
  const { powerMonitor } = require("electron");
  powerMonitor.on("resume", () => {
    if (vpn && vpn.isConnected) {
      platform.setProxy("127.0.0.1", 1080).catch(err => console.error("Failed to reapply proxy after resume:", err.message));
    }
  });

  if (process.platform === "darwin") {
    app.dock.hide();
  }

  tray = createTray(trayCallbacks);

  if (!license.hasLicense()) {
    createWindow("activate.html");
    return;
  }

  // Instant startup: load dashboard immediately from cached license
  createWindow("dashboard.html");
  updateMenu(true, trayCallbacks);

  // Background validation — don't block the UI
  license.validate().then(async (result) => {
    if (result.valid) {
      license.startPeriodicCheck();
      await startSecurityEngine();
      updateMenu(true, trayCallbacks);

      // Auto-connect if setting is enabled
      if (store.get('autoConnect')) {
        vpn.connect().catch(() => {});
      }

      // Check for updates silently
      setTimeout(() => updater.check(), 5000);
    } else if (result.reason === "no_license") {
      // Corrupted store — missing device ID or key, go back to activation
      showPage("activate.html");
      updateMenu(false, trayCallbacks);
    } else {
      // License expired/suspended/invalid — show expired page
      showPage("expired.html");
      updateMenu(false, trayCallbacks);
    }
  }).catch((err) => {
    // Network error — log it, dashboard stays visible (grace period applies)
    console.error("Background license validation failed:", err);
  });
});

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});
