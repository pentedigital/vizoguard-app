"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const PrivacyIntelligence = require("../src/core/privacy-intelligence");

describe("PrivacyIntelligence score", () => {
  it("reports strong posture when VPN and proxy are active", () => {
    const pi = new PrivacyIntelligence();
    pi.setVpnState(true);
    pi.setProxyState(true);
    pi.updateScan({ active: 8, total: 1 });

    const insights = pi.getInsights();
    assert.equal(insights.score, 100);
    assert.equal(insights.label, "Protected");
    assert.equal(insights.findings[0].severity, "good");
  });

  it("penalizes disabled VPN and disabled proxy", () => {
    const pi = new PrivacyIntelligence();

    const insights = pi.getInsights();
    assert.equal(insights.score, 45);
    assert.equal(insights.label, "At Risk");
    assert.ok(insights.findings.find((f) => f.title === "VPN tunnel is off"));
    assert.ok(insights.findings.find((f) => f.title === "Threat proxy is unavailable"));
  });

  it("adds a watch finding for high connection activity", () => {
    const pi = new PrivacyIntelligence();
    pi.setVpnState(true);
    pi.setProxyState(true);
    pi.updateScan({ active: 100, total: 2 });

    const insights = pi.getInsights();
    assert.equal(insights.score, 90);
    assert.ok(insights.findings.find((f) => f.title === "High connection activity"));
  });
});

describe("PrivacyIntelligence explanations", () => {
  it("records direct public IP connections as explainable findings", () => {
    const pi = new PrivacyIntelligence();
    pi.setVpnState(true);
    pi.setProxyState(true);
    pi.recordConnection({ process: "Safari", pid: "123", address: "MacBook:50233->203.0.113.10:443" });

    const insights = pi.getInsights();
    assert.equal(insights.score, 96);
    assert.equal(insights.riskyConnections.length, 1);
    assert.equal(insights.explanations[0].title, "Direct IP connection");
    assert.match(insights.explanations[0].detail, /Safari connected directly/);
  });

  it("ignores private network connections", () => {
    const pi = new PrivacyIntelligence();
    pi.recordConnection({ process: "Finder", pid: "123", address: "MacBook:50233->192.168.1.15:445" });

    const insights = pi.getInsights();
    assert.equal(insights.riskyConnections.length, 0);
    assert.equal(insights.explanations.length, 0);
  });

  it("records bracketed IPv6 public IP connections", () => {
    const pi = new PrivacyIntelligence();
    pi.setVpnState(true);
    pi.setProxyState(true);
    pi.recordConnection({ process: "Safari", pid: "123", address: "MacBook:50233->[2606:4700:4700::1111]:443" });

    const insights = pi.getInsights();
    assert.equal(insights.riskyConnections.length, 1);
    assert.equal(insights.riskyConnections[0].host, "2606:4700:4700::1111");
    assert.match(insights.explanations[0].detail, /2606:4700:4700::1111/);
  });

  it("ignores private IPv6 link-local connections", () => {
    const pi = new PrivacyIntelligence();
    pi.recordConnection({ process: "System", pid: "123", address: "MacBook:50233->[fe80::1]:445" });

    const insights = pi.getInsights();
    assert.equal(insights.riskyConnections.length, 0);
    assert.equal(insights.explanations.length, 0);
  });

  it("does not mistake hex-only hostnames for IP addresses", () => {
    const pi = new PrivacyIntelligence();
    pi.recordConnection({ process: "Safari", pid: "123", address: "MacBook:50233->deadbeef:443" });

    const insights = pi.getInsights();
    assert.equal(insights.riskyConnections.length, 0);
    assert.equal(insights.explanations.length, 0);
  });

  it("records blocked threats with plain-English details", () => {
    const pi = new PrivacyIntelligence();
    pi.recordThreat({
      url: "https://secure-paypal-login.example/",
      risk: "high",
      total: 3,
      checks: [{ name: "brand_impersonation", detail: "Possible paypal impersonation" }],
    });

    const insights = pi.getInsights();
    assert.equal(insights.threatsBlocked, 3);
    assert.equal(insights.explanations[0].title, "Threat blocked");
    assert.match(insights.explanations[0].detail, /secure-paypal-login.example/);
    assert.match(insights.explanations[0].detail, /Possible paypal impersonation/);
  });
});
