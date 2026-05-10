"use strict";

/**
 * DNS flush tests — validates:
 * 1. getApplyCommands includes DNS cache flush on both platforms
 * 2. getRestoreCommands includes DNS cache flush on both platforms
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// We can test the command generation without mocking elevation
// by directly constructing a Dns instance and checking commands

// Mock elevation module
require.cache[require.resolve("../src/elevation")] = {
  id: require.resolve("../src/elevation"),
  filename: require.resolve("../src/elevation"),
  loaded: true,
  exports: {
    elevatedExec: async () => ({ stdout: "", stderr: "" }),
    elevatedBatch: async () => ({ stdout: "", stderr: "" }),
  },
};

const Dns = require("../src/dns");

describe("DNS — cache flush commands", () => {
  it("macOS apply commands include dscacheutil -flushcache", () => {
    const dns = new Dns();
    dns._service = "Wi-Fi";
    // Temporarily pretend we're on darwin
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    try {
      const cmds = dns.getApplyCommands();
      const hasFlush = cmds.some(c => c.includes("dscacheutil -flushcache"));
      const hasMdns = cmds.some(c => c.includes("mDNSResponder"));
      assert.ok(hasFlush, "Should include dscacheutil -flushcache");
      assert.ok(hasMdns, "Should include mDNSResponder kill");
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });

  it("macOS restore commands include dscacheutil -flushcache", () => {
    const dns = new Dns();
    dns._service = "Wi-Fi";
    dns._serversByService["Wi-Fi"] = [];
    dns._ipv6Disabled = true;

    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    try {
      const cmds = dns.getRestoreCommands();
      const hasFlush = cmds.some(c => c.includes("dscacheutil -flushcache"));
      assert.ok(hasFlush, "Restore commands should include DNS flush");
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });

  it("Windows apply commands include ipconfig /flushdns", () => {
    const dns = new Dns();
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      const cmds = dns.getApplyCommands();
      const hasFlush = cmds.some(c => c.includes("ipconfig /flushdns"));
      assert.ok(hasFlush, "Should include ipconfig /flushdns");
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });

  it("Windows restore commands include ipconfig /flushdns", () => {
    const dns = new Dns();
    dns._ipv6Disabled = true;

    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      const cmds = dns.getRestoreCommands();
      const hasFlush = cmds.some(c => c.includes("ipconfig /flushdns"));
      assert.ok(hasFlush, "Restore commands should include DNS flush");
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });
});
