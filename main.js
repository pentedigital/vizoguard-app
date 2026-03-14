const { app, BrowserWindow, ipcMain, clipboard, shell } = require("electron");
const path = require("path");
const Store = require("electron-store");
const LicenseManager = require("./src/license");
const { createTray, updateMenu, destroyTray } = require("./src/tray");

// Single instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const store = new Store();
const license = new LicenseManager(store);

let mainWindow = null;

function createWindow(page) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, "ui", page));
    mainWindow.show();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 420,
    height: 660,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    frame: false,
    backgroundColor: "#0a0a0f",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "ui", page));

  mainWindow.on("close", (e) => {
    // Hide to tray instead of quitting
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

// Tray callbacks
const trayCallbacks = {
  showDashboard: () => showPage("dashboard.html"),
  copyVpnKey: () => {
    const vpnUrl = store.get("license.vpnAccessUrl");
    if (vpnUrl) clipboard.writeText(vpnUrl);
  },
  quit: () => {
    license.stopPeriodicCheck();
    destroyTray();
    mainWindow = null;
    app.exit(0);
  },
};

// ── IPC Handlers ──────────────────────────────

ipcMain.handle("license:activate", async (_event, key) => {
  try {
    const result = await license.activate(key);
    showPage("dashboard.html");
    updateMenu(true, trayCallbacks);
    license.startPeriodicCheck();
    return result;
  } catch (err) {
    return { success: false, error: err.error || err.message || "Activation failed" };
  }
});

ipcMain.handle("license:status", () => {
  return license.getCached();
});

ipcMain.handle("vpn:getKey", async () => {
  const cached = license.getCached();
  if (cached && cached.vpnAccessUrl) return { access_url: cached.vpnAccessUrl };

  // Try fetching from server
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

ipcMain.handle("app:openExternal", (_event, url) => {
  const allowed = [
    "https://vizoguard.com",
    "https://getoutline.org",
    "mailto:support@vizoguard.com",
  ];
  if (allowed.some((prefix) => url.startsWith(prefix))) {
    shell.openExternal(url);
  }
});

ipcMain.handle("app:quit", () => {
  trayCallbacks.quit();
});

ipcMain.handle("app:minimize", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle("app:close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
});

// ── License status change handler ─────────────

license.onStatusChange((status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status:changed", status);
  }

  if (!status.valid) {
    showPage("expired.html");
    updateMenu(false, trayCallbacks);
  } else {
    updateMenu(true, trayCallbacks);
  }
});

// ── App Lifecycle ─────────────────────────────

app.whenReady().then(async () => {
  // Hide dock icon on macOS (tray app)
  if (process.platform === "darwin") {
    app.dock.hide();
  }

  createTray(trayCallbacks);

  if (!license.hasLicense()) {
    createWindow("activate.html");
    return;
  }

  // Validate existing license
  const result = await license.validate();

  if (result.valid) {
    createWindow("dashboard.html");
    license.startPeriodicCheck();
    updateMenu(true, trayCallbacks);
  } else {
    createWindow("expired.html");
    updateMenu(false, trayCallbacks);
  }
});

app.on("second-instance", () => {
  if (mainWindow) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  // Don't quit — keep running in tray
});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  }
});
