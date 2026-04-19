const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { describe, it } = require("node:test");

describe("macOS build configuration validation", () => {
  it("entitlements file is valid XML/plist", () => {
    const plist = fs.readFileSync("build/entitlements.mac.plist", "utf8");
    assert(plist.includes("<?xml"), "Must be XML");
    assert(plist.includes("<!DOCTYPE plist"), "Must have plist DOCTYPE");
    assert(!plist.includes("<key>com.apple.security.cs.disable-library-validation</key>\n  <true/>"),
      "disable-library-validation must NOT be active");
    assert(plist.includes("<!-- library-validation disabled"), "Must have developer warning comment");
  });

  it("all darwin binaries exist for both architectures", () => {
    const arches = ["darwin-amd64", "darwin-arm64"];
    const bins = ["sing-box", "tun2socks"];
    for (const arch of arches) {
      for (const bin of bins) {
        const p = path.join("bin", arch, bin);
        assert(fs.existsSync(p), `Missing binary: ${p}`);
        const stat = fs.statSync(p);
        assert(stat.size > 1000000, `${p} is suspiciously small (${stat.size} bytes)`);
      }
    }
  });

  it("electron-builder references entitlements and extraFiles", () => {
    const config = fs.readFileSync("electron-builder.yml", "utf8");
    assert(config.includes("entitlements: build/entitlements.mac.plist"), "Must reference entitlements");
    assert(config.includes("entitlementsInherit: build/entitlements.mac.plist"), "Must reference entitlementsInherit");
    assert(config.includes('from: "bin/darwin-${arch}"'), "Must copy darwin binaries");
  });

  it("binaries are Mach-O format (magic bytes check)", () => {
    const arches = ["darwin-amd64", "darwin-arm64"];
    for (const arch of arches) {
      const singBox = fs.readFileSync(path.join("bin", arch, "sing-box"));
      const tun2socks = fs.readFileSync(path.join("bin", arch, "tun2socks"));
      // Mach-O magics: 0xfeedface (32-bit BE), 0xfeedfacf (64-bit BE), 0xcafebabe (fat BE)
      // On little-endian systems, these appear byte-swapped in file
      const machoMagics = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe, 0xbebafeca];
      const singMagic = singBox.readUInt32LE(0);
      const tunMagic = tun2socks.readUInt32LE(0);
      assert(machoMagics.includes(singMagic), `sing-box for ${arch} is not Mach-O (magic: 0x${singMagic.toString(16)})`);
      assert(machoMagics.includes(tunMagic), `tun2socks for ${arch} is not Mach-O (magic: 0x${tunMagic.toString(16)})`);
    }
  });
});
