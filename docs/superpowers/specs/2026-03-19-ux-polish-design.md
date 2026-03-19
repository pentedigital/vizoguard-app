# UX Polish — Design Spec

**Date:** 2026-03-19
**Scope:** Fix the most visible UX friction in the Vizoguard desktop app
**Status:** Approved
**Approach:** Surgical edits to existing files (no refactoring)

## Overview

The app has solid technical foundations but poor UX feedback loops: no loading states, silent failures, missing controls, and no settings access. This spec addresses the top friction points.

## Scope

**In scope:**
- VPN connect/disconnect button with spinner and error feedback
- Settings gear in titlebar (Quit, About, Check for Updates, Support)
- Sticky toasts for critical alerts, auto-dismiss for info
- Instant startup from cached license, background validation
- Activation success feedback

**Out of scope:** Auto-reconnect, notification center, threat history, grace period countdown, blocklist updates, update progress/release notes, uninstall cleanup, keyboard accessibility.

---

## 1. VPN Connect/Disconnect Button

**File:** `ui/dashboard.html`

### Connect Flow
1. User clicks "Connect" → button shows spinner + "Connecting..." (disabled)
2. `vpn:getKey` fetches/confirms VPN key exists
3. `vpn:connect` starts SOCKS5 proxy + sets system proxy
4. On success → button becomes "Disconnect" (red/ghost style), status shows "Connected" in green
5. On error → sticky critical toast with error message, button resets to "Connect"

### Disconnect Flow
1. User clicks "Disconnect" → button shows spinner + "Disconnecting..." (disabled)
2. `vpn:disconnect` clears proxy + stops SOCKS server
3. On success → button returns to "Connect" (green), status shows "Disconnected"

### Changes
- `dashboard.html`: Update `toggleVpn()` to show spinner during connect/disconnect, use sticky toast for errors
- No backend changes — existing IPC handlers work

---

## 2. Settings Gear Panel

### Trigger
Gear icon (⚙) in the titlebar, right side, before the window control buttons.

### Panel Behavior
Clicking gear toggles an overlay panel over the dashboard content. Clicking gear again or panel X button closes it. Not a separate page — a toggled div with semi-transparent backdrop.

### Panel Contents
- **App version** — "Vizoguard v1.1.0" (from `app:version` IPC)
- **Check for Updates** — button → "Checking..." → "Up to date" or "Update downloading..."
- **Support** — opens `mailto:support@vizoguard.com`
- **Website** — opens `https://vizoguard.com`
- **Quit Vizoguard** — red button, calls `app:quit` IPC (full shutdown: stops VPN, clears proxy, kills tray, exits)

### Changes
- `dashboard.html`: Add gear icon in titlebar div, add settings panel HTML + CSS + toggle JS
- `preload.js`: Add `checkForUpdate()` → `ipcRenderer.invoke("update:check")`, add `getAppVersion()` → `ipcRenderer.invoke("app:version")`
- `main.js`: Add `update:check` IPC handler (calls `updater.check()`), add `app:version` IPC handler (returns `app.getVersion()`)

---

## 3. Sticky Toasts for Critical Alerts

### Toast Types

**Info toast** (auto-dismiss after 3s):
- Connection updates
- Status changes
- VPN connected/disconnected
- "Up to date" after update check

**Critical toast** (stays until user clicks X):
- Threat blocked (red left border)
- VPN errors
- Immune system alerts
- Security engine failures

### Behavior
- Critical toasts display an X dismiss button
- Only one toast visible at a time — latest replaces previous
- Critical toast has red left border to distinguish from info
- Info toasts work exactly as current implementation

### Changes
- `dashboard.html`: Modify `showToast(msg, critical = false)` function. Add X button markup for critical variant. Add CSS for critical style (red border, no auto-dismiss). Update all callers:
  - `onThreatBlocked` → `showToast(msg, true)`
  - `onVpnError` → `showToast(msg, true)`
  - `onImmuneAlert` → `showToast(msg, true)`
  - `onSecurityError` → `showToast(msg, true)`
  - VPN connect/disconnect success → `showToast(msg, false)`

---

## 4. Instant Startup with Background Validation

### Subsequent Launches (cached license exists)
1. `app.whenReady()` → check `license.hasLicense()`
2. If yes → immediately load `dashboard.html`, create tray, update menu
3. Background: call `license.validate()` (non-blocking)
4. `license.onStatusChange()` handles transitions:
   - Valid → no change (already on dashboard)
   - Expired/suspended → navigate to `expired.html`
   - Network error + grace period valid → update status sub-text to "Offline mode"
5. Start security engine immediately (don't wait for validation)

### First Launch (no license)
1. Load `activate.html` immediately — no delay

### After Activation Success
1. Show "Activated!" text with checkmark on the activate page for 1 second
2. Then navigate to dashboard
3. Start security engine

### Changes
- `main.js`: Remove blocking `await license.validate()` from startup. If `hasLicense()`, load dashboard + start engine immediately, call `validate()` in background with `.then()` handler for status changes.
- `activate.html`: Add success state — hide input/button, show checkmark + "Activated!" text for 1 second before main process navigates to dashboard
- `main.js`: In `license:activate` handler, add `await new Promise(r => setTimeout(r, 1000))` before `showPage("dashboard.html")` so user sees success feedback

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `ui/dashboard.html` | VPN button spinner, settings gear + panel, sticky toasts, toast callers updated |
| `ui/activate.html` | Success state (checkmark + "Activated!" text) |
| `main.js` | Non-blocking startup, `update:check` IPC, `app:version` IPC, activation delay |
| `preload.js` | Add `checkForUpdate()`, `getAppVersion()` |
