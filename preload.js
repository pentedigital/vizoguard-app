const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vizoguard", {
  // License
  activateLicense: (key) => ipcRenderer.invoke("license:activate", key),
  getLicenseStatus: () => ipcRenderer.invoke("license:status"),

  // VPN
  vpnConnect: () => ipcRenderer.invoke("vpn:connect"),
  vpnDisconnect: () => ipcRenderer.invoke("vpn:disconnect"),
  vpnStatus: () => ipcRenderer.invoke("vpn:status"),
  getVpnKey: () => ipcRenderer.invoke("vpn:getKey"),
  copyVpnKey: () => ipcRenderer.invoke("vpn:copyKey"),

  // Security
  getSecurityStats: () => ipcRenderer.invoke("security:stats"),

  // Updates
  installUpdate: () => ipcRenderer.invoke("update:install"),

  // App
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  quit: () => ipcRenderer.invoke("app:quit"),
  minimize: () => ipcRenderer.invoke("app:minimize"),
  close: () => ipcRenderer.invoke("app:close"),

  // Events from main process (removeAllListeners before adding to prevent accumulation across page loads)
  onThreatBlocked: (cb) => { ipcRenderer.removeAllListeners("threat:blocked"); ipcRenderer.on("threat:blocked", (_e, d) => cb(d)); },
  onConnectionsUpdate: (cb) => { ipcRenderer.removeAllListeners("connections:update"); ipcRenderer.on("connections:update", (_e, d) => cb(d)); },
  onImmuneAlert: (cb) => { ipcRenderer.removeAllListeners("immune:alert"); ipcRenderer.on("immune:alert", (_e, d) => cb(d)); },
  onVpnState: (cb) => { ipcRenderer.removeAllListeners("vpn:state"); ipcRenderer.on("vpn:state", (_e, d) => cb(d)); },
  onStatusChange: (cb) => { ipcRenderer.removeAllListeners("status:changed"); ipcRenderer.on("status:changed", (_e, d) => cb(d)); },
  onUpdateReady: (cb) => { ipcRenderer.removeAllListeners("update:ready"); ipcRenderer.on("update:ready", (_e, d) => cb(d)); },
  onVpnError: (cb) => { ipcRenderer.removeAllListeners("vpn:error"); ipcRenderer.on("vpn:error", (_e, d) => cb(d)); },
  onSecurityError: (cb) => { ipcRenderer.removeAllListeners("security:error"); ipcRenderer.on("security:error", (_e, d) => cb(d)); },

  platform: process.platform,
});
