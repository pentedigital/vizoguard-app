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

### State Management
The `vpnConnected` variable in `toggleVpn()` must be updated directly on success (`vpnConnected = true/false`) rather than relying solely on the `onVpnState` event. The event listener still updates UI as a secondary path, but the immediate update prevents the button resetting to "Connect" briefly before the event fires.

### Changes
- `dashboard.html`: Update `toggleVpn()` to show spinner during connect/disconnect, update `vpnConnected` directly on success, use sticky toast for errors
- No backend changes — existing IPC handlers work

---

## 2. Settings Gear Panel

### Trigger
Gear icon (⚙) in the titlebar, right side, before the window control buttons.

### Panel Behavior
Clicking gear toggles an overlay panel over the dashboard content. Clicking gear again or panel X button closes it. Not a separate page — a toggled div with semi-transparent backdrop.

### Panel Contents
- **App version** — "Vizoguard v1.1.0" (from `app:version` IPC)
- **Check for Updates** — button → "Checking..." → result shown via events (see below)
- **Support** — opens `mailto:support@vizoguard.com`
- **Website** — opens `https://vizoguard.com`
- **Quit Vizoguard** — red button, calls `app:quit` IPC (full shutdown: stops VPN, clears proxy, kills tray, exits)

### Update Check Flow
`updater.check()` is async and event-driven. The IPC invoke just triggers it; results come via events:
1. Renderer calls `checkForUpdate()` → button shows "Checking..."
2. Main process calls `updater.check()`, returns immediately
3. Updater emits events → main process forwards to renderer:
   - `update:not-available` → settings button shows "Up to date" for 3s, then resets
   - `update:available` → settings button shows "Downloading..."
   - `update:downloaded` → existing update banner appears (already implemented)
   - `update:error` → settings button shows "Check failed", resets after 3s

### Gear Icon Placement
- **All platforms:** Gear icon on the right side of the titlebar
- **macOS:** No custom window controls exist (traffic lights are on left via `hiddenInset`), so gear sits alone on the right
- **Windows:** Gear icon placed before the minimize/close buttons in the controls div

### Changes
- `dashboard.html`: Add gear icon in titlebar div, add settings panel HTML + CSS + toggle JS, listen for update events
- `preload.js`: Add `checkForUpdate()` → `ipcRenderer.invoke("update:check")`, add `getAppVersion()` → `ipcRenderer.invoke("app:version")`, add `onUpdateNotAvailable(cb)`, `onUpdateError(cb)`
- `main.js`: Add `update:check` IPC handler: `ipcMain.handle("update:check", () => { updater.check(); })`. Add `app:version` IPC handler: `ipcMain.handle("app:version", () => app.getVersion())`. Add `sendToRenderer` calls for updater `not-available` and `error` events.

**Note:** `app:quit` IPC handler already exists (main.js line 253). No new handler needed for Quit button.

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
- Only one toast visible at a time — latest replaces previous, with one exception: info toasts do NOT replace critical toasts. Critical toasts can only be replaced by other critical toasts or dismissed by the user.
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
5. Start security engine only after background validation confirms valid license. The `.then()` handler for `validate()` calls `startSecurityEngine()` on success. This prevents a race condition where `onStatusChange` calls `stop()` on modules that are still in the middle of `start()`. The dashboard loads instantly regardless — the engine starting 1-2 seconds later is imperceptible to the user.
6. Call `license.startPeriodicCheck()` inside the `.then()` handler alongside `startSecurityEngine()` to ensure periodic re-validation continues.

### First Launch (no license)
1. Load `activate.html` immediately — no delay

### After Activation Success
1. Show "Activated!" text with checkmark on the activate page for 1 second
2. Then navigate to dashboard
3. Start security engine

### Changes
- `main.js`: Remove blocking `await license.validate()` from startup. If `hasLicense()`, load dashboard + start engine immediately, call `validate()` in background with `.then()` handler for status changes.
- `activate.html`: Add success state — hide input/button, show checkmark + "Activated!" text for 1 second before main process navigates to dashboard
- `main.js`: In `license:activate` handler, return `{ success: true }` immediately. The renderer handles the 1-second success animation, then tells main to navigate via a new `app:showDashboard` IPC call. This keeps the main process responsive and avoids blocking the IPC channel.
- `preload.js`: Add `showDashboard()` → `ipcRenderer.invoke("app:showDashboard")`
- `main.js`: Add `app:showDashboard` IPC handler that calls `showPage("dashboard.html")` + `startSecurityEngine()`

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `ui/dashboard.html` | VPN button spinner + state fix, settings gear + panel + update events, sticky toasts with priority, toast callers updated |
| `ui/activate.html` | Success state (checkmark + "Activated!" text), 1s delay then `showDashboard()` IPC |
| `main.js` | Non-blocking startup (engine starts after validation), `update:check` IPC, `app:version` IPC, `app:showDashboard` IPC, forward updater `not-available`/`error` events to renderer |
| `preload.js` | Add `checkForUpdate()`, `getAppVersion()`, `showDashboard()`, `onUpdateNotAvailable()`, `onUpdateError()` |
