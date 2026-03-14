const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vizoguard", {
  activateLicense: (key) => ipcRenderer.invoke("license:activate", key),
  getLicenseStatus: () => ipcRenderer.invoke("license:status"),
  getVpnKey: () => ipcRenderer.invoke("vpn:getKey"),
  copyVpnKey: () => ipcRenderer.invoke("vpn:copyKey"),
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  quit: () => ipcRenderer.invoke("app:quit"),
  minimize: () => ipcRenderer.invoke("app:minimize"),
  close: () => ipcRenderer.invoke("app:close"),
  onStatusChange: (callback) => {
    ipcRenderer.on("status:changed", (_event, status) => callback(status));
  },
  platform: process.platform,
});
