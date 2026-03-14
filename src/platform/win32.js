const { execFile } = require("child_process");

function getDeviceId() {
  return new Promise((resolve, reject) => {
    execFile("reg", [
      "query",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography",
      "/v", "MachineGuid",
    ], (err, stdout) => {
      if (err) return reject(err);
      const match = stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match) resolve(match[1]);
      else reject(new Error("Could not read MachineGuid"));
    });
  });
}

module.exports = { getDeviceId };
