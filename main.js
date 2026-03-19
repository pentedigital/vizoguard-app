const { app, BrowserWindow, ipcMain, clipboard, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const Store = require("electron-store");
const LicenseManager = require("./src/license");
const VpnManager = require("./src/vpn");
const { ThreatChecker, ConnectionMonitor, SecurityProxy, ImmuneSystem } = require("./src/core");
const { createTray, updateMenu, destroyTray } = require("./src/tray");
const Updater = require("./src/updater");

// Single instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const store = new Store();
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

// ── Window Management ─────────────────────────

function createWindow(page) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, "ui", page));
    mainWindow.show();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    frame: false,
    backgroundColor: "#000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
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

// ── Security Engine Events ────────────────────

threatChecker.on("threat", (data) => {
  sendToRenderer("threat:blocked", {
    url: data.url,
    risk: data.risk,
    checks: data.checks,
    total: threatChecker.threatsBlocked,
  });
  // Update tray tooltip with threat count
  updateMenu(true, trayCallbacks);
});

securityProxy.on("blocked", (data) => {
  sendToRenderer("threat:blocked", {
    url: data.url,
    risk: data.risk,
    total: securityProxy.threatsBlocked,
  });
});

connectionMonitor.on("scan", (data) => {
  sendToRenderer("connections:update", data);
});

immuneSystem.on("alert", (data) => {
  sendToRenderer("immune:alert", data);
});

// ── VPN Events ────────────────────────────────

vpn.on("connected", () => {
  sendToRenderer("vpn:state", { connected: true });
  updateMenu(true, trayCallbacks);
});

vpn.on("disconnected", () => {
  sendToRenderer("vpn:state", { connected: false });
});

vpn.on("error", (err) => {
  // Sanitize error — strip IP:port details before sending to renderer
  const safeMsg = (err.message || "VPN error").replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g, "[redacted]");
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
  return license.getCached();
});

ipcMain.handle("vpn:connect", async () => {
  try {
    await vpn.connect();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
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
    const { apiCall } = require("./src/api");
    const key = store.get("license.key");
    const result = await apiCall("/vpn/create", { key });
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

ipcMain.handle("app:showDashboard", async () => {
  showPage("dashboard.html");
  updateMenu(true, trayCallbacks);
  license.startPeriodicCheck();
  await startSecurityEngine();
});

// ── Security Engine Start ─────────────────────

async function startSecurityEngine() {
  try {
    await securityProxy.start();
  } catch (e) {
    console.error("Security proxy failed to start:", e.message);
    sendToRenderer("security:error", { message: `Security proxy unavailable: ${e.message}` });
  }
  connectionMonitor.start();
  immuneSystem.start();
  console.log("Security engine started");
}

// ── License Status Change ─────────────────────

license.onStatusChange((status) => {
  sendToRenderer("status:changed", status);

  if (!status.valid) {
    showPage("expired.html");
    updateMenu(false, trayCallbacks);
    securityProxy.stop();
    connectionMonitor.stop();
    immuneSystem.stop();
    vpn.disconnect().catch(() => {});
  } else {
    updateMenu(true, trayCallbacks);
  }
});

// ── App Lifecycle ─────────────────────────────

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock.hide();
  }

  createTray(trayCallbacks);

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

      // Check for updates silently
      setTimeout(() => updater.check(), 5000);
    } else {
      // License invalid/expired/suspended — navigate away from dashboard
      showPage("expired.html");
      updateMenu(false, trayCallbacks);
    }
  }).catch((err) => {
    // Network error — log it, dashboard stays visible (grace period applies)
    console.error("Background license validation failed:", err);
  });
});

app.on("second-instance", () => {
  if (mainWindow) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});
