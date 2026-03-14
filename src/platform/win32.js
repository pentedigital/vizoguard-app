const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

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

async function setProxy(host, port) {
  // Set SOCKS proxy via registry
  await execFileAsync("reg", [
    "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f",
  ]);
  await execFileAsync("reg", [
    "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "/v", "ProxyServer", "/t", "REG_SZ", "/d", `socks=${host}:${port}`, "/f",
  ]);
}

async function clearProxy() {
  await execFileAsync("reg", [
    "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f",
  ]);
}

async function getConnections() {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano"]);
    const lines = stdout.split("\n").filter((l) => l.includes("ESTABLISHED"));
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return { address: parts[2] || "", pid: parts[4] || "" };
    });
  } catch {
    return [];
  }
}

module.exports = { getDeviceId, setProxy, clearProxy, getConnections };
