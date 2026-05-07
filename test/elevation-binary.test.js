const assert = require("assert");
const { describe, it } = require("node:test");
const fs = require("fs");
const src = fs.readFileSync("src/elevation-daemon.js", "utf8");

function extractFunction(name, source) {
  const match = source.match(new RegExp("function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}"));
  if (!match) throw new Error(name + " not found");
  return match[0];
}

const fnSrc = extractFunction("isSingleCommandAllowed", src);
const reMatch = src.match(/const ALLOWED_BINARY_RE = .+/);
const prefixesMatch = src.match(/const ALLOWED_PREFIXES_DARWIN = [^;]+;/);
eval(prefixesMatch[0] + ";" + reMatch[0] + ";" + fnSrc);

describe("Elevation daemon binary allowlist", () => {
  it("allows tun2socks with arguments on macOS", () => {
    const cmd = "/usr/local/bin/tun2socks -device utun -proxy socks5://127.0.0.1:1080";
    assert.strictEqual(isSingleCommandAllowed(cmd), true);
  });

  it("allows sing-box with arguments on macOS", () => {
    const cmd = "/usr/local/bin/sing-box run -c /tmp/config.json";
    assert.strictEqual(isSingleCommandAllowed(cmd), true);
  });

  it("allows tun2socks.exe with arguments on Windows", () => {
    const cmd = "C:\\Program Files\\Vizoguard\\tun2socks.exe -device tun://vizoguard";
    assert.strictEqual(isSingleCommandAllowed(cmd), true);
  });

  it("allows bare binary path without arguments", () => {
    assert.strictEqual(isSingleCommandAllowed("/usr/local/bin/tun2socks"), true);
    assert.strictEqual(isSingleCommandAllowed("/usr/local/bin/sing-box"), true);
  });

  it("rejects similar-looking binary names", () => {
    assert.strictEqual(isSingleCommandAllowed("/usr/local/bin/tun2sockshelper"), false);
    assert.strictEqual(isSingleCommandAllowed("/usr/local/bin/sing-box-malware"), false);
    assert.strictEqual(isSingleCommandAllowed("/usr/local/bin/prefix-tun2socks"), false);
  });

  it("rejects unrelated commands", () => {
    assert.strictEqual(isSingleCommandAllowed("rm -rf /"), false);
    assert.strictEqual(isSingleCommandAllowed("curl http://evil.com"), false);
  });
});
