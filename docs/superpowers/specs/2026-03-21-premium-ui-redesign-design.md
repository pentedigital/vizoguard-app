# Electron Desktop App — Premium UI Redesign

**Date**: 2026-03-21
**Goal**: Redesign the Vizoguard Electron desktop app UI to match the Android app's premium glass-morphism aesthetic with a transparent bonnet engine view showcasing the full security stack.
**Approach**: Pure CSS/JS redesign — no frameworks, no build step. Keep existing HTML structure pattern, restyle everything.

---

## Design System

### Color Palette (CSS Custom Properties)

```css
--void:         #0a0a0f;                         /* Base background */
--surface:      #111111;                         /* Raised surface */
--border:       #222222;                         /* Subtle dividers */
--ice:          #f0f2f5;                         /* Primary text */
--mist:         #8a93a6;                         /* Secondary text */
--teal:         #00e5a0;                         /* Connected / secure */
--amber:        #ffbb33;                         /* Connecting / warning */
--red:          #ff3b3b;                         /* Error / danger */
--accent:       #ff6b2b;                         /* Primary action buttons */
--glass-surface:    rgba(255,255,255,0.06);      /* Glass panel fill */
--glass-border:     rgba(255,255,255,0.12);      /* Glass panel border */
--glass-surface-dark: rgba(255,255,255,0.03);    /* Deeper glass */
--subtle-teal:      rgba(0,229,160,0.10);        /* Teal tint */
--amber-subtle:     rgba(255,187,51,0.10);       /* Amber tint */
--red-subtle:       rgba(255,59,59,0.10);        /* Red tint */
```

**`--accent` usage**: Orange accent (`#FF6B2B`) is for action buttons on secondary screens (Activate, Expired, Settings). The main connect button uses state colors only (teal/amber/red). This matches the Android pattern where `Accent` is for buttons and `Teal` is for connection state.

### Typography

- **Display/Headings**: Outfit (300-800 weight) — already loaded
- **Mono/Technical**: JetBrains Mono (500-700) — already loaded
- **Status labels**: Outfit 600, uppercase, 0.1em letter-spacing
- **Metrics values**: JetBrains Mono 500
- **Body text**: Outfit 400, `--mist` color

### Glass-Morphism

All glass panels use:
```css
.glass {
  background: var(--glass-surface);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
}
```

Hover state: border brightens to `rgba(255,255,255,0.20)`.
Active/connected state: border tints to `rgba(0,229,160,0.30)` (teal glow).

---

## Window Configuration

| Property | Current | New |
|----------|---------|-----|
| Width | 420 | 480 |
| Height | 700 | 780 |
| Resizable | false | false |
| Frame | false | false |
| Min height | — | 700 (for small screens) |

Update `main.js` `BrowserWindow` config.

---

## Dashboard Layout

### Structure (top to bottom)

```
┌─ Titlebar (40px, drag region) ─────────────┐
│  Vizoguard                    [─] [×]      │
├────────────────────────────────────────────┤
│                                            │
│  [PrivacyScore]            [⚙ Settings]   │  ← Header bar
│                                            │
│              ┌────────┐                    │
│              │        │                    │
│              │   ◉    │  ← 180px circle   │  ← Connect button
│              │        │                    │
│              └────────┘                    │
│                                            │
│            ● PROTECTED                     │  ← Status line
│              00:14:32                      │
│                                            │
│  ┌─ Engine View (glass, collapsible) ────┐ │  ← Diagnostic console
│  │  ...                                  │ │
│  └───────────────────────────────────────┘ │
│                                            │
│  VIZO-••••-••••-••••-A3F2                  │  ← License info
│  Expires Jan 15, 2027                      │
│                                            │
└────────────────────────────────────────────┘
```

---

## Component Specifications

### 1. Connect Button (Central Element)

**Size**: 180px diameter circle, centered horizontally.

**States**:

| State | Border | Background | Glow | Text | Animation |
|-------|--------|------------|------|------|-----------|
| Idle | `var(--glass-border)` | Radial gradient void→surface | None | "TAP TO CONNECT" | None — still |
| Connecting | `var(--amber)` | Radial gradient void→amber-subtle | `0 0 30px rgba(255,187,51,0.3)` | "..." | Scale pulse 1→1.06 (800ms), rotating conic-gradient ring (3s linear), breathing amber glow (2s) |
| Connected | `var(--teal)` | Radial gradient void→subtle-teal | `0 0 24px rgba(0,229,160,0.25)` | "VPN ON" | Soft pulse every 3-4s, subtle inner shimmer sweep |
| Error | `var(--red)` | Radial gradient void→red-subtle | `0 0 24px rgba(255,59,59,0.3)` | "FAILED" | Single shake (150ms), then steady |
| Reconnecting | `var(--amber)` | Same as connecting | Same as connecting | "..." | Same as connecting + warning banner |

**Rotating ring** (connecting state):
```css
.connect-ring {
  background: conic-gradient(var(--amber) 0deg, transparent 120deg, transparent 360deg);
  animation: rotate-ring 3s linear infinite;
  border-radius: 50%;
  position: absolute;
  inset: -4px;
}
@keyframes rotate-ring { to { transform: rotate(360deg); } }
```

**Inner shimmer** (connected state):
```css
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.connect-btn.connected::after {
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.05) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: shimmer 4s ease-in-out infinite;
}
```

### 2. Status Line

Below the connect button, centered:

```html
<div class="status-line">
  <span class="status-dot"></span>
  <span class="status-label">PROTECTED</span>
</div>
<div class="status-timer">00:14:32</div>
```

- **Dot**: 8px circle, color matches state, has matching `box-shadow` glow
- **Label**: Outfit 600, uppercase, 0.1em letter-spacing, 0.85rem
- **Timer**: JetBrains Mono 500, `--mist` color, 0.8rem
- **Dot animation**: Breathing pulse 1.5s (connected), fast pulse 500ms (connecting)

### 3. Privacy Score (Top-Left)

Three horizontal bars stacked vertically:
- Bar widths: 36px, 28px, 20px (decreasing)
- Height: 3px each, 4px gap
- Active: State color (teal/amber/red)
- Inactive: `var(--border)`
- Label below: "Protected" / "Connecting" / "At Risk" / "Exposed"
- Fill animation: 300ms ease on state change
- Total size: ~50x40px

Bar activation:
- 3 bars: Connected
- 2 bars: Connecting
- 1 bar: Idle
- 3 bars pulsing: Error

### 4. Engine View (Diagnostic Console)

Glass panel, collapsible. Collapsed by default on first launch, state persisted via `electron-store`.

**Header row** (always visible):
```html
<div class="engine-header" onclick="toggleEngine()">
  <span class="engine-title">Secure tunnel active</span>
  <span class="engine-chevron">▾</span>
</div>
```
- Chevron rotates 180deg smoothly (300ms) on toggle
- Header has teal glow border when expanded (`rgba(0,229,160,0.30)`)

**Expanded content** (three sections with separators):

#### Section 1: CONNECTION
```
[E]  ChaCha20-Poly1305
[S]  vpn-server.vizoguard.com
[T]  00:14:32
[M]  IP Masked ✓
[N]  DNS: Encrypted
```
- Labels: JetBrains Mono, `--mist`, 0.75rem
- Values: JetBrains Mono, `--ice`, 0.8rem
- Icons `[E]`, `[S]` etc: JetBrains Mono, `--teal`, inline

#### Section 2: SECURITY ENGINE
```
Proxy         42 req/s
Cache         8,234 entries
Threats       7 blocked
Connections   12 active
████████░░    Threat DB loaded
```
- Section label: Outfit 600, uppercase, 0.1em letter-spacing, `--mist`, 0.7rem
- Values: JetBrains Mono, `--ice`
- Progress bar: CSS `linear-gradient` with teal fill, animated width (300ms)

#### Section 3: IMMUNE SYSTEM
```
L1 Blocklist    ████████░░  98%
L2 Behaviors    ██████░░░░  64%
L3 Persistence  ██░░░░░░░░  16%
L4 Sentinel     ████████░░  81%
```
- Layer labels: JetBrains Mono, `--mist`
- Progress bars: 80px wide, height 6px, rounded, teal fill, `--border` background
- Percentage: JetBrains Mono, `--ice`, right-aligned

#### Section 4: "What Just Happened?"
```
💡 Blocked a tracking script from doubleclick.net on nytimes.com
```
- Background: `var(--subtle-teal)` (tinted glass, distinct from other sections)
- Border-left: 3px solid `var(--teal)`
- Text: Outfit 400, `--ice`, 0.8rem
- Rotates messages every 12s (fixed) with fade transition (400ms opacity)
- Sources: Recent `threat:blocked` events (newest first), or fallback educational messages:
  1. "Your traffic is encrypted with military-grade ChaCha20-Poly1305"
  2. "Vizoguard blocks tracking scripts before they load in your browser"
  3. "Your real IP address is hidden from every website you visit"
  4. "DNS queries are encrypted — your ISP cannot see which sites you visit"
  5. "The immune system monitors for tampering and self-repairs if compromised"

**Expand/collapse animation**:
```css
.engine-body {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-height 400ms ease, opacity 300ms ease;
}
.engine-view.expanded .engine-body {
  max-height: 340px;  /* Fits within 780px window: 40+50+180+50+40+340+40 = 740px */
  opacity: 1;
  overflow-y: auto;
}
```

**Separators**: `border-top: 1px solid rgba(255,255,255,0.06);` between sections.

### 5. Settings Panel (Right-Side Slide-Over)

- **Width**: 320px
- **Background**: `rgba(10,10,15,0.85)` + `backdrop-filter: blur(20px)`
- **Slide animation**: `transform: translateX(100%)` → `translateX(0)` (300ms ease-out)
- **Backdrop**: `rgba(0,0,0,0.5)`, click to close
- **Border-left**: `1px solid var(--glass-border)`
- **Border-radius**: 16px 0 0 16px (left corners rounded)

**Content**:
- Drag handle: 40x4px, `var(--border)`, centered, top
- Toggle rows: Auto-connect, Kill switch, Notifications — custom CSS toggles with `--accent` checked color
- Dividers: `0.5px solid var(--glass-border)`
- License info: Masked key (mono), expiry date
- Version display
- Check for Updates button (states: "Check for Updates" → "Checking..." → "Downloading..." → "Up to date" / "Update ready — restart")
- Contact Support link (`mailto:support@vizoguard.com`)
- Visit Website link (`vizoguard.com`)
- Quit Vizoguard: Red text button — calls `window.vizoguard.quit()` (quits the app entirely, not sign out)
- Easter egg: 5 taps on "Settings" title → Debug panel

**Settings toggle IPC**: Auto-connect, Kill switch, and Notifications toggles read/write to `electron-store` via existing store pattern. No new IPC channels needed — the renderer reads initial state from `window.vizoguard.getSettings()` and writes via `window.vizoguard.setSetting(key, value)`. Add these two IPC handlers:
```javascript
// In main.js
ipcMain.handle("settings:get", () => store.store);
ipcMain.handle("settings:set", (_e, key, value) => { store.set(key, value); });
// In preload.js
getSettings: () => ipcRenderer.invoke("settings:get"),
setSetting: (key, value) => ipcRenderer.invoke("settings:set", key, value),
```

### 6. Activate Screen

- Centered glass card (max-width 360px)
- Shield icon (inactive state, dim)
- "Activate Vizoguard" heading (Outfit 700, 1.5rem)
- License key input: mono font, auto-format `VIZO-XXXX-XXXX-XXXX-XXXX`, glass-border focus state
- "Activate" button: `--accent` background, black text, 12px rounded, 48px height
- Error text: `--red`, centered below button
- Loading: CSS spinner (teal, 2px stroke)
- "Get a license" link → vizoguard.com/pricing

### 7. Expired Screen

- Centered glass card
- Shield icon with red X overlay
- "Subscription Expired" heading in `--red`
- Expiry date display
- "Renew" button: `--accent` background
- Support email link

---

## New IPC Channels

### `engine:metrics` (invoke handler)

Returns current engine state for the bonnet view:

```javascript
{
  proxy: {
    requestsPerSec: number,
    cachedEntries: number,
    threatsBlocked: number,
    activeConnections: number,
    threatDbLoaded: boolean
  },
  vpn: {
    cipher: string,        // "ChaCha20-Poly1305"
    serverHost: string,    // "vpn-server.vizoguard.com"
    ipMasked: boolean,
    dnsEncrypted: boolean
  },
  immune: {
    layers: [
      { name: "Blocklist", level: number },    // 0-100
      { name: "Behaviors", level: number },
      { name: "Persistence", level: number },
      { name: "Sentinel", level: number }
    ]
  }
}
```

### `engine:update` (event stream)

Main process sends updates every 1 second when engine view is expanded:
```javascript
const engineIntervals = new Map(); // keyed by webContents.id

ipcMain.on("engine:subscribe", (event) => {
  const id = event.sender.id;
  // Clear any existing interval for this sender
  if (engineIntervals.has(id)) clearInterval(engineIntervals.get(id));
  const interval = setInterval(() => {
    if (event.sender.isDestroyed()) {
      clearInterval(interval);
      engineIntervals.delete(id);
      return;
    }
    event.sender.send("engine:update", getEngineMetrics());
  }, 1000);
  engineIntervals.set(id, interval);
});

ipcMain.on("engine:unsubscribe", (event) => {
  const id = event.sender.id;
  if (engineIntervals.has(id)) {
    clearInterval(engineIntervals.get(id));
    engineIntervals.delete(id);
  }
});
```

### Preload additions

```javascript
getEngineMetrics: () => ipcRenderer.invoke("engine:metrics"),
subscribeEngine: () => ipcRenderer.send("engine:subscribe"),
unsubscribeEngine: () => ipcRenderer.send("engine:unsubscribe"),
onEngineUpdate: (cb) => {
  ipcRenderer.removeAllListeners("engine:update");
  ipcRenderer.on("engine:update", (_e, d) => cb(d));
}
```

---

## File Changes

### Modified Files

| File | Changes |
|------|---------|
| `main.js` | Window size 480x780, add `engine:metrics` + `engine:subscribe`/`unsubscribe` IPC handlers |
| `preload.js` | Expose engine metrics API |
| `ui/dashboard.html` | Complete HTML restructure — connect button, status line, privacy score, engine view |
| `ui/activate.html` | Apply glass-morphism styling |
| `ui/expired.html` | Apply glass-morphism styling |
| `ui/assets/style.css` | Complete CSS rewrite — glass system, animations, all components |

### New Files

| File | Purpose |
|------|---------|
| `ui/js/engine-monitor.js` | Engine view JS: expand/collapse, live metric updates, message rotation |
| `ui/js/animations.js` | Connect button state animations, privacy score transitions |

### Unchanged Files

- `src/` core modules (vpn, license, api, tray, updater, etc.) — no logic changes
- `electron-builder.yml` — no build changes
- Font loading — already in place

---

## Animation Specifications

### @keyframes

```css
@keyframes pulse-slow {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

@keyframes pulse-fast {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

@keyframes scale-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}

@keyframes glow-breathe {
  0%, 100% { box-shadow: 0 0 16px rgba(0,229,160,0.15); }
  50% { box-shadow: 0 0 32px rgba(0,229,160,0.45); }
}

@keyframes rotate-ring {
  to { transform: rotate(360deg); }
}

@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}

@keyframes fade-message {
  0% { opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  100% { opacity: 0; }
}
```

### Transition Defaults

```css
* { transition: color 400ms ease, border-color 400ms ease, background-color 400ms ease, box-shadow 400ms ease; }
```

---

## State Management (JS)

The dashboard JS maintains state via the existing IPC event pattern:

```javascript
// State variables
let vpnState = 'idle';           // idle, connecting, connected, error, reconnecting
let engineExpanded = false;      // persisted in electron-store key: 'ui.engineExpanded'
let engineInterval = null;       // 1s update timer
let connectedSince = null;       // Date object, set when connected, cleared on disconnect
let timerInterval = null;        // 1s timer display update

// State transitions
// User clicks connect button:
//   idle → connecting (set locally before IPC call)
//   connecting → connected (from vpn:state event)
//   connecting → error (from vpn:error event)
//   connected → idle (user clicks disconnect, or vpn:state { connected: false })
//   error → connecting (user clicks "Try Again")
//   error → idle (after 10s timeout)

document.getElementById('connect-btn').addEventListener('click', async () => {
  if (vpnState === 'idle' || vpnState === 'error') {
    setVpnState('connecting');
    try {
      await window.vizoguard.vpnConnect();
    } catch (err) {
      setVpnState('error');
    }
  } else if (vpnState === 'connected') {
    await window.vizoguard.vpnDisconnect();
    setVpnState('idle');
  }
});

// IPC event handlers
window.vizoguard.onVpnState((state) => {
  if (state.connected) {
    setVpnState('connected');
    connectedSince = new Date();
    startTimer();
  } else {
    setVpnState('idle');
    connectedSince = null;
    stopTimer();
  }
});

window.vizoguard.onVpnError((err) => {
  setVpnState('error');
  // Auto-clear error after 10s
  setTimeout(() => { if (vpnState === 'error') setVpnState('idle'); }, 10000);
});

function setVpnState(newState) {
  vpnState = newState;
  updateButton();
  updateStatus();
  updatePrivacyScore();
  if (newState === 'connected' && engineExpanded) startEngineUpdates();
  else if (newState !== 'connected') stopEngineUpdates();
}

// Connection timer (local tracking)
function startTimer() {
  timerInterval = setInterval(() => {
    if (!connectedSince) return;
    const elapsed = Math.floor((Date.now() - connectedSince.getTime()) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    document.getElementById('status-timer').textContent = `${h}:${m}:${s}`;
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
  document.getElementById('status-timer').textContent = '';
}
```

Engine updates only run while expanded (subscribe/unsubscribe pattern) to avoid unnecessary IPC overhead. The `engine:subscribe` handler in main.js stores the interval keyed by `webContents.id` for proper cleanup.

---

## Success Criteria

- All 5 connect button states render correctly with animations
- Glass-morphism panels have visible blur effect in Electron
- Engine view expands/collapses smoothly with live updating metrics
- Privacy score reflects VPN state with correct colors
- Settings slides in from right with glass effect
- Activate and expired screens have glass styling
- Window resizes from 420x700 to 480x780 without breaking existing functionality
- All existing IPC channels continue working
- No new dependencies added (pure CSS/JS)
- macOS and Windows both render correctly
