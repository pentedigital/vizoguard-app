# Electron Premium UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Vizoguard Electron desktop app from a flat card layout to a premium glass-morphism UI with animated connect button, collapsible engine bonnet view, and right-side settings panel.

**Architecture:** Pure CSS/JS redesign. Rewrite style.css with glass-morphism system + animations. Restructure dashboard.html around centered connect button + engine view. Add engine-monitor.js and animations.js for live metrics and button states. Add IPC channels for engine metrics + settings. No frameworks, no build step.

**Tech Stack:** HTML, CSS (backdrop-filter, @keyframes, custom properties), vanilla JS, Electron IPC

**Spec:** `docs/superpowers/specs/2026-03-21-premium-ui-redesign-design.md`

---

## File Map

### Modified Files
| File | Changes |
|------|---------|
| `ui/assets/style.css` | Complete rewrite — glass system, animations, all components |
| `ui/dashboard.html` | Complete restructure — connect button, status, privacy score, engine view, settings panel |
| `ui/activate.html` | Apply glass-morphism styling |
| `ui/expired.html` | Apply glass-morphism styling |
| `main.js` | Window size 480x780, add engine metrics + settings IPC handlers |
| `preload.js` | Expose engine + settings API |

### New Files
| File | Purpose |
|------|---------|
| `ui/js/animations.js` | Connect button state machine, privacy score, status line, timer |
| `ui/js/engine-monitor.js` | Engine view expand/collapse, live metrics, message rotation |

---

## Tasks

### Task 1: Rewrite style.css — Glass-morphism design system

**Files:** Modify: `ui/assets/style.css`

Read the current file fully, then replace with new glass-morphism design system per spec. Must include:
- Font faces (keep existing Outfit + JetBrains Mono)
- New CSS custom properties (all colors from spec including --amber, --accent, --glass-surface, --red-subtle, etc.)
- Glass utility class (.glass with backdrop-filter, border, border-radius)
- Titlebar styles (40px, drag region)
- Connect button (.connect-btn 180px circle, states: .idle/.connecting/.connected/.error with gradients, glows, border colors)
- Rotating conic-gradient ring (.connect-ring for connecting state)
- Shimmer sweep (::after on .connected)
- Status line (.status-dot with glow, .status-label uppercase letter-spaced, .status-timer mono)
- Privacy score (.score-bars, .score-bar horizontal bars, .score-label)
- Engine view (.engine-view, .engine-header, .engine-chevron rotation, .engine-body with max-height 340px + overflow-y auto, .engine-section, .engine-row, .progress-bar/.progress-fill, .what-happened with subtle-teal bg)
- Settings panel (.settings-panel 320px slide-right, .settings-overlay backdrop, .toggle custom switch)
- Buttons (.btn accent, .btn-ghost, .btn-danger, .btn-sm)
- Toast notifications (glass style)
- Warning banner (.warning-banner amber)
- Activate/expired card styles (glass)
- All @keyframes: pulse-slow, pulse-fast, scale-pulse, glow-breathe, rotate-ring, shimmer, shake, fade-in
- Transitions on interactive elements (400ms ease)

Verify, then commit: `git commit -m "ui: rewrite style.css with glass-morphism design system + animations"`

---

### Task 2: Restructure dashboard.html

**Files:** Modify: `ui/dashboard.html`

Read current file fully, then replace body content with new layout per spec. Keep the head (CSP, title, stylesheet link). Add script tags for `js/animations.js` and `js/engine-monitor.js`.

New structure (top to bottom):
1. Titlebar (logo + platform controls)
2. Header bar (privacy score top-left, settings button top-right)
3. Connect button area (180px circle with ring overlay and text)
4. Status line (dot + label + timer)
5. Warning banner (hidden by default)
6. Engine view (glass panel, collapsible: header with chevron + body with 4 sections: CONNECTION, SECURITY ENGINE, IMMUNE SYSTEM, WHAT JUST HAPPENED)
7. License info (masked key + expiry)
8. Settings panel (slide-over: toggles, license, version, update, support, quit)
9. Toast container

Inline script at bottom handles: titlebar controls, IPC event listener registration, init sequence (license status, VPN state, settings load), toast system, settings toggle handlers, update check.

Use textContent for dynamic text (not innerHTML for untrusted data). Use DOM createElement for toasts.

Verify HTML well-formed, then commit: `git commit -m "ui: restructure dashboard — connect button, engine view, settings panel"`

---

### Task 3: Create animations.js — Button state machine + privacy score

**Files:** Create: `ui/js/animations.js`

Manages connect button states, privacy score, status line, connection timer. Key functions:

- `setVpnState(newState)` — updates button CSS class (idle/connecting/connected/error), text, dot color/animation, glow; shows/hides engine view and warning banner
- `updatePrivacyScore(state)` — fills/unfills 3 score bars with state color; updates label text
- `startTimer()` / `stopTimer()` — tracks connectedSince locally, updates timer display every 1s in HH:MM:SS format
- Connect button click handler: idle/error clicks → set connecting, call vpnConnect; connected clicks → disconnect

State transitions per spec: idle→connecting (on click), connecting→connected (from IPC), connecting→error (from IPC), error→idle (10s auto-clear), connected→idle (on click/disconnect).

Commit: `git commit -m "ui: add animations.js — connect button state machine, privacy score, timer"`

---

### Task 4: Create engine-monitor.js — Engine view + live metrics

**Files:** Create: `ui/js/engine-monitor.js`

Manages engine view expand/collapse, live metric updates, "What Just Happened?" rotation. Key functions:

- `initEngine()` — load persisted expand state from electron-store key `ui.engineExpanded`, attach click handler to engine header
- `toggleEngine()` — toggle expanded class on engine-view, rotate chevron 180deg, start/stop metric subscription
- `startEngineUpdates()` — call `window.vizoguard.subscribeEngine()`, listen for `engine:update` events, update all DOM elements (cipher, server, uptime, IP, DNS, proxy rps, cache, threats, connections, immune layers)
- `stopEngineUpdates()` — call `window.vizoguard.unsubscribeEngine()`
- `addThreatMessage(msg)` — push to message queue for "What Just Happened?"
- Message rotation: every 12s, cycle through recent threat messages or fallback educational messages (5 listed in spec)

Commit: `git commit -m "ui: add engine-monitor.js — collapsible engine view, live metrics, message rotation"`

---

### Task 5: Add IPC channels — engine metrics + settings

**Files:** Modify: `main.js`, `preload.js`

Read both files fully, then:

**preload.js** — Add to the vizoguard context bridge:
- `getEngineMetrics` (invoke engine:metrics)
- `subscribeEngine` (send engine:subscribe)
- `unsubscribeEngine` (send engine:unsubscribe)
- `onEngineUpdate` (listen engine:update with removeAllListeners pattern)
- `getSettings` (invoke settings:get)
- `setSetting` (invoke settings:set)

**main.js** — Add:
- `engine:metrics` handler — returns proxy stats (from securityProxy/threatChecker/connectionMonitor), VPN info (cipher, server, IP), immune layer levels
- `engine:subscribe` / `engine:unsubscribe` — uses Map keyed by webContents.id for proper interval cleanup
- `settings:get` / `settings:set` — reads/writes electron-store
- Update BrowserWindow: width 420→480, height 700→780, add minHeight 700

Commit: `git commit -m "feat: add engine metrics IPC, settings persistence, resize window to 480x780"`

---

### Task 6: Apply glass-morphism to activate.html + expired.html

**Files:** Modify: `ui/activate.html`, `ui/expired.html`

Read both files. Apply glass styling:

**activate.html**: Wrap content in glass card, update button to accent color, update input field styling (glass border, mono font), keep all existing IPC functionality.

**expired.html**: Wrap in glass card with red accent border, update button to accent color, keep existing openExternal behavior.

Commit: `git commit -m "ui: apply glass-morphism to activate + expired screens"`

---

### Task 7: Final verification + CLAUDE.md

- Ensure `ui/js/` directory exists
- Verify all 8 files exist and are well-formed
- Test app launches: `cd /root/vizoguard-app && npm start` (verify window opens at 480x780, glass visible, no console errors)
- Update CLAUDE.md with UI Design section documenting: glass theme, connect button states, engine view, settings panel, CSS/JS files
- Final commit: `git commit -m "ui: premium glass-morphism redesign complete"`
