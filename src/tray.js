const { Tray, Menu, nativeImage } = require("electron");
const path = require("path");

let tray = null;

function createTray(callbacks) {
  const iconName = process.platform === "darwin" ? "tray-activeTemplate.png" : "tray-active.png";
  const iconPath = path.join(__dirname, "..", "ui", "assets", iconName);

  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("Vizoguard — Protected");

  updateMenu(true, callbacks);

  tray.on("click", callbacks.showDashboard);
  tray.on("double-click", callbacks.showDashboard);

  return tray;
}

function updateMenu(isActive, callbacks) {
  if (!tray) return;

  const iconName = isActive
    ? (process.platform === "darwin" ? "tray-activeTemplate.png" : "tray-active.png")
    : (process.platform === "darwin" ? "tray-inactiveTemplate.png" : "tray-inactive.png");
  const iconPath = path.join(__dirname, "..", "ui", "assets", iconName);

  tray.setImage(nativeImage.createFromPath(iconPath));
  tray.setToolTip(isActive ? "Vizoguard — Protected" : "Vizoguard — Not Protected");

  const menu = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: callbacks.showDashboard },
    { type: "separator" },
    {
      label: isActive ? "Status: Protected" : "Status: Not Protected",
      enabled: false,
    },
    { type: "separator" },
    { label: "Copy VPN Key", click: callbacks.copyVpnKey },
    { type: "separator" },
    { label: "Quit Vizoguard", click: callbacks.quit },
  ]);

  tray.setContextMenu(menu);
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, updateMenu, destroyTray };
