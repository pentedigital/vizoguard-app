if (process.platform === "win32") {
  module.exports = require("./win32");
} else if (process.platform === "darwin") {
  module.exports = require("./darwin");
} else {
  // Stub for unsupported platforms (Linux dev/CI)
  module.exports = {
    getDeviceId: async () => { throw new Error(`Unsupported platform: ${process.platform}`); },
    getConnections: async () => [],
  };
}
