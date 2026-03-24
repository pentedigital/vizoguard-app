// Elevation layer — routes all privileged commands through a persistent daemon.
// First call launches the daemon via sudo-prompt (one admin dialog per app session).
// Subsequent calls go through the daemon socket — zero additional prompts.
//
// Falls back to direct sudo-prompt per command if daemon launch fails.

const sudo = require("sudo-prompt");
const net = require("net");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const SUDO_OPTIONS = { name: "Vizoguard VPN" };

// ── Daemon state ─────────────────────────────────

let _socket = null;       // net.Socket to daemon
let _socketPath = null;   // daemon listen address
let _pending = new Map();  // id → { resolve, reject }
let _buffer = "";          // partial JSON accumulator
let _launching = false;
let _launchPromise = null;
let _daemonAvailable = true; // set false if daemon can't start (fallback to direct)

// ── Helpers ──────────────────────────────────────

function getApp() {
  try { return require("electron").app; } catch { return null; }
}

function getTempDir() {
  const app = getApp();
  return app ? app.getPath("temp") : require("os").tmpdir();
}

function getSocketPath() {
  const id = crypto.randomBytes(8).toString("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\vizoguard-elevation-${id}`;
  }
  return path.join(getTempDir(), `vizoguard-elevation-${id}.sock`);
}

function getDaemonScript() {
  const app = getApp();
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, "elevation-daemon.js");
  }
  return path.join(__dirname, "elevation-daemon.js");
}

function isCancelError(msg) {
  return msg.includes("canceled") || msg.includes("cancelled") || msg.includes("User did not grant");
}

// ── Direct sudo-prompt (fallback) ────────────────

function directExec(command) {
  return new Promise((resolve, reject) => {
    sudo.exec(command, SUDO_OPTIONS, (err, stdout, stderr) => {
      if (err) {
        const msg = err.message || "";
        if (isCancelError(msg)) {
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

// ── Daemon launch ────────────────────────────────

function launchDaemon() {
  if (_launching) return _launchPromise;
  _launching = true;

  _socketPath = getSocketPath();
  const script = getDaemonScript();
  const ppid = process.pid;

  _launchPromise = new Promise((resolve, reject) => {
    let command;
    const execPath = process.execPath;

    if (process.platform === "win32") {
      const esc = (s) => s.replace(/'/g, "''");
      command = `powershell -Command "& { $env:ELECTRON_RUN_AS_NODE='1'; Start-Process -FilePath '${esc(execPath)}' -ArgumentList '${esc(script)}','--pipe','${esc(_socketPath)}','--ppid','${ppid}' -WindowStyle Hidden }"`;
    } else {
      command = `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${script}" --socket "${_socketPath}" --ppid ${ppid} > /dev/null 2>&1 &`;
    }

    sudo.exec(command, SUDO_OPTIONS, (err) => {
      if (err) {
        _launching = false;
        _launchPromise = null;
        const msg = err.message || "";
        if (isCancelError(msg)) {
          reject(new Error("Admin permission required — user cancelled"));
        } else {
          reject(new Error(`Failed to start elevation daemon: ${msg}`));
        }
        return;
      }
      // Daemon launched — connect to socket
      connectDaemon(resolve, reject);
    });
  });

  return _launchPromise;
}

function connectDaemon(resolve, reject) {
  let attempts = 0;
  const maxAttempts = 40; // 40 × 250ms = 10s

  const tryConnect = () => {
    attempts++;
    const sock = net.createConnection(_socketPath);

    sock.on("connect", () => {
      _socket = sock;
      _launching = false;
      _buffer = "";

      sock.on("data", onData);
      sock.on("error", onSocketDied);
      sock.on("close", onSocketDied);

      console.log(`Elevation daemon connected (${_socketPath})`);
      resolve();
    });

    sock.on("error", () => {
      sock.destroy();
      if (attempts < maxAttempts) {
        setTimeout(tryConnect, 250);
      } else {
        _launching = false;
        _launchPromise = null;
        reject(new Error("Elevation daemon did not start in time"));
      }
    });
  };

  tryConnect();
}

function onData(data) {
  _buffer += data.toString();
  let idx;
  while ((idx = _buffer.indexOf("\n")) !== -1) {
    const line = _buffer.slice(0, idx);
    _buffer = _buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const p = _pending.get(msg.id);
      if (p) {
        _pending.delete(msg.id);
        if (msg.ok) {
          p.resolve({ stdout: msg.stdout || "", stderr: msg.stderr || "" });
        } else {
          p.reject(new Error(msg.error || "Daemon command failed"));
        }
      }
    } catch {}
  }
}

function onSocketDied() {
  if (!_socket) return; // guard against double fire (error + close)
  _socket = null;
  // Reject all pending requests
  for (const [id, p] of _pending) {
    p.reject(new Error("Elevation daemon connection lost"));
  }
  _pending.clear();
}

// ── Daemon communication ─────────────────────────

async function ensureDaemon() {
  if (_socket && !_socket.destroyed) {
    try {
      await sendToDaemon({ type: "ping" }, 3000);
      return;
    } catch {
      _socket = null;
    }
  }
  await launchDaemon();
}

function sendToDaemon(msg, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString("hex");
    msg.id = id;

    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error("Daemon command timed out"));
    }, timeout);

    _pending.set(id, {
      resolve: (val) => { clearTimeout(timer); resolve(val); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });

    try {
      _socket.write(JSON.stringify(msg) + "\n");
    } catch (e) {
      _pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`Failed to send to daemon: ${e.message}`));
    }
  });
}

// ── Public API ───────────────────────────────────

async function elevatedExec(command) {
  if (!_daemonAvailable) return directExec(command);

  try {
    await ensureDaemon();
    return await sendToDaemon({ type: "exec", command });
  } catch (e) {
    // If user cancelled, propagate immediately (don't fallback)
    if (e.message.includes("user cancelled")) throw e;

    // Daemon failed — fall back to direct sudo-prompt for this session
    console.warn("Elevation daemon unavailable, falling back to direct sudo-prompt:", e.message);
    _daemonAvailable = false;
    return directExec(command);
  }
}

async function elevatedBatch(commands, { ignoreErrors = false } = {}) {
  if (!commands.length) return { stdout: "", stderr: "" };

  // Build single command string
  let command;
  if (commands.length === 1) {
    command = commands[0];
  } else if (process.platform === "win32") {
    const separator = ignoreErrors ? " & " : " && ";
    command = commands.join(separator);
  } else {
    const separator = ignoreErrors ? " ; " : " && ";
    const prefix = ignoreErrors ? "" : "set -e; ";
    command = `${prefix}${commands.join(separator)}`;
  }

  return elevatedExec(command);
}

async function shutdownDaemon() {
  if (_socket && !_socket.destroyed) {
    try {
      await sendToDaemon({ type: "shutdown" }, 3000);
    } catch {}
    try { _socket.destroy(); } catch {}
    _socket = null;
  }
  _pending.clear();
  _launching = false;
  _launchPromise = null;
}

module.exports = { elevatedExec, elevatedBatch, shutdownDaemon };
