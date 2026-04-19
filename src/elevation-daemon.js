// Privileged helper daemon — runs as root/admin, accepts commands via Unix socket / named pipe.
// Launched once per app session via sudo-prompt. Eliminates repeated admin dialogs.
//
// Protocol: newline-delimited JSON over Unix socket / Windows named pipe
//   Request:  { id, type: "exec"|"ping"|"shutdown", command?: string }
//   Response: { id, ok: bool, stdout?, stderr?, error? }
//
// Security: command allowlist + random socket path + parent PID watchdog
// Lifecycle: auto-exits on parent death (3s check) or idle timeout (10 min)
//
// MUST NOT require Electron — runs via ELECTRON_RUN_AS_NODE=1
// Uses exec() intentionally — needs shell features (&&, ;, ||, &) for batched
// commands. All commands validated against allowlist, never from user input.

const net = require("net");
const { exec } = require("child_process"); // eslint-disable-line security/detect-child-process
const fs = require("fs");

// ── Parse CLI args ───────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const socketPath = getArg("--socket") || getArg("--pipe");
const parentPid = parseInt(getArg("--ppid"), 10);

if (!socketPath || !parentPid) {
  process.stderr.write("Usage: elevation-daemon --socket <path> --ppid <pid>\n");
  process.exit(1);
}

// ── Command allowlist (defense-in-depth) ─────────
// Validates each sub-command in a batch individually.

const ALLOWED_PREFIXES_DARWIN = [
  "/sbin/route ",
  "/usr/sbin/networksetup ",
];
const ALLOWED_PREFIXES_WIN32 = [
  "route ",
  "netsh ",
  "reg add ",
  "reg delete ",
];

// Restrict PowerShell to only safe Start-Process patterns used by the app
function isAllowedPowerShell(cmd) {
  if (!cmd.startsWith("powershell -Command ")) return false;
  const inner = cmd.slice("powershell -Command ".length);
  // Block any dangerous cmdlets or external network calls
  const forbidden = /Invoke-Expression|Invoke-Command|IEX|DownloadString|Start-BitsTransfer|Remove-Item|Remove-ItemProperty|Set-ExecutionPolicy|New-Object|Add-Type|ReflectivePE|Invoke-WebRequest|curl|wget/i;
  if (forbidden.test(inner)) return false;
  // Must only use Start-Process (to launch tun2socks/sing-box) and Out-File (for PID capture)
  if (!inner.includes("Start-Process")) return false;
  return true;
}
// Binary names — matched as path-terminated segments (not substring)
const ALLOWED_BINARY_RE = /(^|[/\\])(?:tun2socks|sing-box)\b/;

function isSingleCommandAllowed(cmd) {
  cmd = cmd.trim();
  // Strip common trailing error suppression
  cmd = cmd.replace(/\|\|\s*(true|ver>nul)\s*$/, "").trim();
  if (!cmd) return true; // empty after stripping is fine
  // PowerShell commands require dedicated security review
  if (cmd.startsWith("powershell -Command")) {
    return isAllowedPowerShell(cmd);
  }
  const prefixes = process.platform === "win32" ? ALLOWED_PREFIXES_WIN32 : ALLOWED_PREFIXES_DARWIN;
  if (prefixes.some(p => cmd.startsWith(p))) return true;
  if (ALLOWED_BINARY_RE.test(cmd)) return true;
  return false;
}

function isAllowed(command) {
  // Strip batch prefix
  let normalized = command;
  if (normalized.startsWith("set -e;")) normalized = normalized.slice(7);

  // Split on shell separators (&&, ;, ||, &) and validate each part
  const parts = normalized.split(/\s*(?:&&|;|\|\||&)\s*/);
  return parts.every(isSingleCommandAllowed);
}

// ── Idle timeout (10 min) ────────────────────────

const IDLE_MS = 10 * 60 * 1000;
let idleTimer = null;

function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log("idle timeout — shutting down");
    shutdown();
  }, IDLE_MS);
}

// ── Parent PID watchdog ──────────────────────────

const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    log("parent died — shutting down");
    shutdown();
  }
}, 3000);

// ── Helpers ──────────────────────────────────────

function log(msg) {
  process.stderr.write(`[elevation-daemon] ${msg}\n`);
}

function shutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  clearInterval(parentWatch);
  try { server.close(); } catch {}
  if (process.platform !== "win32") {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  process.exit(0);
}

function executeCommand(command) {
  return new Promise((resolve) => {
    if (!isAllowed(command)) {
      resolve({ ok: false, error: `Command not in allowlist: ${command.slice(0, 100)}` });
      return;
    }
    // exec used intentionally for shell features — commands are from internal allowlist only
    exec(command, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message, stdout: stdout || "", stderr: stderr || "" });
      } else {
        resolve({ ok: true, stdout: stdout || "", stderr: stderr || "" });
      }
    });
  });
}

// ── Socket server ────────────────────────────────

// Clean stale socket (macOS/Linux only — named pipes don't leave files)
if (process.platform !== "win32") {
  try { fs.unlinkSync(socketPath); } catch {}
}

const server = net.createServer((socket) => {
  let buffer = "";

  socket.on("data", (data) => {
    buffer += data.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line), socket);
      } catch {
        socket.write(JSON.stringify({ id: null, ok: false, error: "Invalid JSON" }) + "\n");
      }
    }
  });

  socket.on("error", () => {});
});

async function handleMessage(msg, socket) {
  resetIdle();

  const respond = (data) => {
    try { socket.write(JSON.stringify({ id: msg.id, ...data }) + "\n"); } catch {}
  };

  switch (msg.type) {
    case "ping":
      respond({ ok: true });
      break;

    case "exec":
      respond(await executeCommand(msg.command || ""));
      break;

    case "shutdown":
      respond({ ok: true });
      setTimeout(shutdown, 100);
      break;

    default:
      respond({ ok: false, error: `Unknown type: ${msg.type}` });
  }
}

// Set restrictive umask before listen so socket is created with 0o600 (no race window)
const oldMask = process.platform !== "win32" ? process.umask(0o177) : null;

server.listen(socketPath, () => {
  if (oldMask !== null) process.umask(oldMask);
  log(`listening on ${socketPath} (ppid: ${parentPid})`);
  resetIdle();
});

server.on("error", (err) => {
  log(`server error: ${err.message}`);
  shutdown();
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
