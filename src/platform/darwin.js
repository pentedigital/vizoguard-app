const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

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

async function setProxy(host, port) {
  // Get all network services
  const { stdout } = await execFileAsync("/usr/sbin/networksetup", ["-listallnetworkservices"]);
  const services = stdout.split("\n").filter((s) => s && !s.startsWith("*")).map((s) => s.trim());

  for (const service of services) {
    try {
      await execFileAsync("/usr/sbin/networksetup", ["-setsocksfirewallproxy", service, host, String(port)]);
      await execFileAsync("/usr/sbin/networksetup", ["-setsocksfirewallproxystate", service, "on"]);
    } catch { /* some services don't support proxy */ }
  }
}

async function clearProxy() {
  const { stdout } = await execFileAsync("/usr/sbin/networksetup", ["-listallnetworkservices"]);
  const services = stdout.split("\n").filter((s) => s && !s.startsWith("*")).map((s) => s.trim());

  for (const service of services) {
    try {
      await execFileAsync("/usr/sbin/networksetup", ["-setsocksfirewallproxystate", service, "off"]);
    } catch { /* ignore */ }
  }
}

function getConnections() {
  return new Promise((resolve, reject) => {
    execFile("/usr/sbin/lsof", ["-i", "-nP", "-sTCP:ESTABLISHED"], (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const lines = stdout.split("\n").slice(1).filter(Boolean);
      const connections = lines.map((line) => {
        const parts = line.split(/\s+/);
        return { process: parts[0], pid: parts[1], address: parts[8] || "" };
      });
      resolve(connections);
    });
  });
}

module.exports = { getDeviceId, setProxy, clearProxy, getConnections };
