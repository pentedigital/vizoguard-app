const sudo = require("sudo-prompt");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const SUDO_OPTIONS = { name: "Vizoguard VPN" };

// Execute a command string with elevated privileges (sudo-prompt API requires string)
// macOS: native auth dialog | Windows: UAC dialog
// Only called with hardcoded command strings — never with user input
function elevatedExec(command) {
  return new Promise((resolve, reject) => {
    sudo.exec(command, SUDO_OPTIONS, (err, stdout, stderr) => {
      if (err) {
        const msg = err.message || "";
        if (msg.includes("canceled") || msg.includes("cancelled") || msg.includes("User did not grant")) {
          reject(new Error("Admin permission required — user cancelled"));
        } else {
          reject(new Error(`Elevated command failed: ${msg}`));
        }
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

module.exports = { elevatedExec };
