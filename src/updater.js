const { autoUpdater } = require("electron-updater");
const { EventEmitter } = require("events");

class Updater extends EventEmitter {
  constructor() {
    super();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      this.emit("checking");
    });

    autoUpdater.on("update-available", (info) => {
      console.log(`Update available: ${info.version}`);
      this.emit("available", info);
    });

    autoUpdater.on("update-not-available", () => {
      this.emit("not-available");
    });

    autoUpdater.on("download-progress", (progress) => {
      this.emit("progress", progress);
    });

    autoUpdater.on("update-downloaded", (info) => {
      console.log(`Update downloaded: ${info.version}`);
      this.emit("downloaded", info);
    });

    autoUpdater.on("error", (err) => {
      console.error("Update error:", err.message);
      this.emit("error", err);
    });
  }

  check() {
    autoUpdater.checkForUpdatesAndNotify();
  }

  install() {
    autoUpdater.quitAndInstall();
  }
}

module.exports = Updater;
