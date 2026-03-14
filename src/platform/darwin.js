const { execFile } = require("child_process");

function getDeviceId() {
  return new Promise((resolve, reject) => {
    execFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], (err, stdout) => {
      if (err) return reject(err);
      const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match) resolve(match[1]);
      else reject(new Error("Could not read IOPlatformUUID"));
    });
  });
}

module.exports = { getDeviceId };
