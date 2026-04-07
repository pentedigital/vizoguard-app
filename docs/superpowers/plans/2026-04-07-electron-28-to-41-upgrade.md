# Electron 28 → 41 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `vizoguard-app` from Electron 28 to Electron 41 through three internal validation waypoints, shipping a single user-facing release (1.3.4 → 1.3.5).

**Architecture:** Three internal hops (28→33→37→41) on an `electron-upgrade` branch. Each waypoint runs the same 7-category audit and go/no-go gate. Only the final waypoint produces a signed, notarized, user-facing release. See spec: `docs/superpowers/specs/2026-04-07-electron-28-to-41-upgrade-design.md`.

**Tech Stack:** Electron, electron-builder, electron-updater, electron-store, sudo-prompt, Node 18→22 (toolchain bumps happen automatically via the Electron bundled Node).

**Note on plan shape:** Dependency upgrades are not TDD work. The failing test we cannot write in advance is *"is the app still working after this version bump?"* — that question is answered by the go/no-go gate, not by pre-written unit tests. This plan is therefore structured as: concrete commands + expected outputs for the mechanical steps, and a **procedure** for the exploratory audit steps (read breaking-changes doc → enumerate flagged items → apply fixes). The "write failing test → implement → pass" shape does not apply here.

---

## Phase 0 — Branch setup

### Task 0.1: Create the upgrade branch

**Files:** none (git branch only)

- [ ] **Step 1: Ensure working tree is clean**

```bash
cd /root/vizoguard-app
git status --short
```

Expected: only `package-lock.json` modified (from the earlier `npm audit fix` that cleared lodash + picomatch). If anything else is dirty, stash it.

- [ ] **Step 2: Commit the pending package-lock.json from the earlier audit fix**

This is pre-existing work that should land on `main` before we branch.

```bash
git add package-lock.json
git diff --cached --stat
```

Expected: one file (`package-lock.json`) changed.

```bash
git commit -m "$(cat <<'EOF'
fix(deps): npm audit fix — lodash + picomatch vulnerabilities

Non-breaking resolution of GHSA-r5fr-rjxr-66jc (lodash code injection),
GHSA-f23m-r3pf-42rh (lodash prototype pollution), GHSA-3v7f-55p6-f55p
and GHSA-c2c7-rcm5-vvqj (picomatch). Electron advisories are tracked
separately by the Electron upgrade plan.
EOF
)"
```

- [ ] **Step 3: Create and switch to the upgrade branch**

```bash
git checkout -b electron-upgrade
git branch --show-current
```

Expected: `electron-upgrade`

- [ ] **Step 4: Record the baseline**

```bash
node -e "console.log('electron:', require('./package.json').devDependencies.electron)"
node --test test/*.test.js 2>&1 | tail -10
npm audit 2>&1 | tail -5
```

Expected: electron `^28.0.0`, 60/60 tests pass, 1 high severity vulnerability remaining (Electron).

Write these three results down. They are the baseline that every waypoint will be compared against.

---

## Phase 1 — Waypoint 1: Electron 28 → 33

### Task 1.1: Read breaking changes for majors 29, 30, 31, 32, 33

**Files:** none (research only — output feeds Task 1.2)

- [ ] **Step 1: Pull the breaking-changes document for each major crossed**

For each of Electron 29, 30, 31, 32, 33, fetch the `breaking-changes.md` from the `electron/electron` repo at the corresponding release tag.

Use the `github` MCP:

```
mcp__github__get_file_contents owner=electron repo=electron path=docs/breaking-changes.md ref=v29-x-y
```

(Substitute the actual latest patch tag for each major — check with `mcp__github__list_tags owner=electron repo=electron` filtered for `v29.`, `v30.`, etc.)

Alternative: `mcp__context7__resolve-library-id electron` then `query-docs`.

- [ ] **Step 2: For each major, extract items mentioning any of these keywords**

Keywords (case-insensitive): `preload`, `contextIsolation`, `sandbox`, `ipcMain`, `ipcRenderer`, `webContents`, `powerMonitor`, `openExternal`, `session.setProxy`, `setLoginItemSettings`, `protocol.`, `autoUpdater`, `BrowserWindow`, `tray`, `clipboard`, `Removed`, `No longer supported`, `Deprecated:`.

- [ ] **Step 3: Produce a waypoint-1 audit note**

Create an inline markdown block (paste below this step when executing) listing each flagged item in the form:

```
- [29] <item title> — <applicable | not applicable | needs investigation> — <note>
- [30] <item title> — ...
- [31] <item title> — ...
- [32] <item title> — ...
- [33] <item title> — ...
```

Also explicitly check and record the status of each of these items (even if the breaking-changes doc does not mention them — absence is itself a finding):

- ASAR integrity on macOS (expected: became mandatory in Electron 30)
- Node.js version bundled with Electron 30 (expected: Node 20.x — ABI bump from Node 18 in Electron 28)
- `protocol.register*Protocol` deprecation in favor of `protocol.handle` (expected: introduced around 31; vizoguard does not register custom protocols, so "not applicable" is the expected outcome)
- Any `powerMonitor` event rename (vizoguard uses sleep/resume events)

This note is the input to Task 1.2 — save it in your working memory or paste it into the task output.

### Task 1.2: Bump Electron to latest 33.x and reinstall

**Files:**
- Modify: `/root/vizoguard-app/package.json` (devDependencies.electron)
- Modify: `/root/vizoguard-app/package-lock.json` (regenerated)
- Modify: `/root/vizoguard-app/node_modules/` (regenerated)

- [ ] **Step 1: Install Electron 33 (latest patch)**

```bash
cd /root/vizoguard-app
rm -rf node_modules package-lock.json
npm install --save-dev electron@33
```

Expected: install completes, no `node-gyp` errors. If `sudo-prompt` or any native dep fails to rebuild, STOP and enter the sudo-prompt resolution path (Task 1.2a).

- [ ] **Step 2: Verify the installed version**

```bash
node -e "console.log(require('./node_modules/electron/package.json').version)"
```

Expected: a `33.x.y` string.

- [ ] **Step 3: Check for peer warnings**

Review the `npm install` output above for any peer warnings mentioning `electron`, `electron-builder`, or `electron-updater`. Record any warning. A warning is not a blocker; only errors are blockers.

### Task 1.2a: sudo-prompt resolution (only if Task 1.2 Step 1 fails)

**Files:**
- Modify: `/root/vizoguard-app/package.json`
- Possibly: `/root/vizoguard-app/src/elevation.js` (if swapping to a replacement)

Only execute this task if `npm install` in Task 1.2 failed on `sudo-prompt`. Skip otherwise.

- [ ] **Step 1: Capture the exact error**

Paste the `npm install` error output. Identify whether the failure is a Node API rename, a missing header, or an ABI mismatch.

- [ ] **Step 2: 30-minute local-patch attempt**

Try patching `sudo-prompt` locally (e.g. via `patch-package`). If not resolvable inside 30 minutes, abandon and proceed to Step 3.

- [ ] **Step 3: Swap to `@vscode/sudo-prompt`**

```bash
npm uninstall sudo-prompt
npm install --save @vscode/sudo-prompt
```

Then update imports. Find all usages:

```bash
grep -rn "require('sudo-prompt')" src/ main.js preload.js
grep -rn 'require("sudo-prompt")' src/ main.js preload.js
```

For each usage, replace with `require('@vscode/sudo-prompt')`. The API is designed to be drop-in compatible, but test every call site.

- [ ] **Step 4: Retry the gate from Task 1.3**

Do not commit until the full gate passes.

### Task 1.3: Apply code changes required by the breaking-changes audit

**Files:** depends on Task 1.1 output. Possible targets: `main.js`, `preload.js`, `src/tray.js`, `src/vpn.js`, `src/connection-manager.js`, `ui/*.html`, `electron-builder.yml`, `build/entitlements.mac.plist`.

- [ ] **Step 1: For each "applicable" item from the Task 1.1 audit note, apply the documented fix**

This step is inherently exploratory. Follow this procedure:

1. Take one "applicable" item.
2. Locate the affected call site(s) in vizoguard code using `grep` or `rg`.
3. Apply the fix documented in the Electron breaking-changes doc for that item.
4. Move to the next item.

- [ ] **Step 2: Handle ASAR integrity on macOS (expected item from Electron 30)**

Check `electron-builder.yml` for an `asarIntegrity` setting. If absent, verify the build still works in Task 1.5 — electron-builder ≥ 24 generates ASAR integrity automatically; no config change should be needed. Only add explicit config if the build fails.

- [ ] **Step 3: Verify `openExternal` allowlist still matches**

The security rule is that `openExternal` is restricted to `vizoguard.com`, `getoutline.org`, and exact `mailto:support@vizoguard.com`. If the breaking-changes audit flagged any `openExternal` behavior change, inspect `main.js` (or wherever the wrapper lives) and confirm the pattern matching still enforces the allowlist.

```bash
grep -n "openExternal" main.js src/**/*.js
```

- [ ] **Step 4: Verify `powerMonitor` event names (sleep/resume)**

```bash
grep -n "powerMonitor" main.js src/**/*.js
```

Confirm the event names used (`suspend`, `resume`, `lock-screen`, etc.) are still supported in Electron 33.

### Task 1.4: Run the automated gate

- [ ] **Step 1: Clean install**

Already done in Task 1.2. Re-run only if code changes in Task 1.3 touched `package.json`:

```bash
npm install
```

Expected: exit 0.

- [ ] **Step 2: npm audit**

```bash
npm audit 2>&1 | tail -15
```

Expected: no **new** high/critical vulnerabilities relative to the baseline recorded in Task 0.1 Step 4. The Electron advisories may partially clear depending on which were fixed between 28 and 33.

- [ ] **Step 3: Unit tests**

```bash
node --test test/*.test.js 2>&1 | tail -15
```

Expected: `# tests 60` / `# pass 60` / `# fail 0`.

If any test fails, STOP. The gate is failed. Do not proceed to manual smoke.

- [ ] **Step 4: Dev launch smoke**

```bash
timeout 15 npm start 2>&1 | tee /tmp/waypoint1-start.log
```

Expected: window opens within the 15s timeout. No `Error:` lines in the main-process stderr. No Electron deprecation *error* messages (warnings are OK).

Review `/tmp/waypoint1-start.log`. If any main-process error is present, STOP.

- [ ] **Step 5: Build dry-run**

```bash
rm -rf dist
npx electron-builder --dir 2>&1 | tail -30
```

Expected: unpacked app appears under `dist/`, no ASAR integrity errors, no missing-entitlement errors.

### Task 1.5: Run the manual smoke test (7 points)

**Files:** none

This requires a real desktop environment. If running on a headless VPS, this task **must be run on a developer machine** with a GUI. Record the results below the task when complete.

- [ ] **Step 1: License validation IPC**

Launch the app. Enter a valid test license key. Dashboard transitions from "Checking..." to "Protected" after server validation.

Pass: dashboard shows "Protected". Fail: stays "Checking..." or shows an error.

- [ ] **Step 2: VPN connect / disconnect**

Tap connect. VPN establishes (check system proxy settings). Tap disconnect. VPN tears down (system proxy cleared).

Pass: round-trip succeeds. Fail: connect hangs, disconnect leaves proxy set, or either action throws.

- [ ] **Step 3: Tray interaction**

Right-click the tray icon. Menu appears. "Show dashboard" focuses the window.

Pass: menu renders correctly, "Show dashboard" brings window to front. Fail: menu missing items, wrong actions, or click does nothing.

- [ ] **Step 4: Sleep / resume**

With VPN connected, put the system to sleep for 10 seconds. Resume. Verify system proxy is still set correctly and VPN still reports connected.

Pass: proxy reapplied after resume (verify in system network settings). Fail: proxy lost, VPN in zombie state.

- [ ] **Step 5: openExternal allowlist**

Click any "Support" link in the UI → should open `mailto:support@vizoguard.com`. Click any "Privacy" link → should open `vizoguard.com/privacy`.

Open DevTools (if enabled) and try `window.vizoguard.openExternal('https://example.com')` or equivalent — expected to be blocked.

Pass: allowlisted URLs open, off-allowlist blocked. Fail: blocked allowlisted URLs, or off-allowlist URLs open.

- [ ] **Step 6: Clipboard auto-clear**

Trigger the "copy access key" flow (copies an `ss://` URL to the clipboard). Wait 30 seconds. Paste somewhere — clipboard should be empty (or not contain the `ss://` URL).

Pass: clipboard cleared within ~30s. Fail: `ss://` URL still present after 30s.

- [ ] **Step 7: Graceful shutdown**

Quit the app (`Cmd/Ctrl+Q`). Check system network settings: proxy cleared. Check processes: no zombie vizoguard processes.

```bash
ps aux | grep -i vizoguard | grep -v grep
```

Expected: empty output.

Pass: clean shutdown, no zombies, proxy cleared. Fail: any of the above.

### Task 1.6: Commit waypoint 1 (only if the entire gate passed)

**Files:** whatever was modified in Tasks 1.2, 1.2a, and 1.3.

- [ ] **Step 1: Review the diff**

```bash
git diff --stat
git diff package.json
```

- [ ] **Step 2: Stage and commit**

```bash
git add package.json package-lock.json
# Add any other modified files from Task 1.3
git add -u
git commit -m "$(cat <<'EOF'
chore(electron): bump to 33.x (waypoint 1 of 3)

Internal validation waypoint. Crosses Node 18 → 20 ABI and ASAR
integrity mandatory (Electron 30). Waypoint gate passed: 60/60 tests,
dev launch clean, --dir build clean, 7-point manual smoke passed.

Not shipped to users — waypoint for the 28 → 41 upgrade. See
docs/superpowers/specs/2026-04-07-electron-28-to-41-upgrade-design.md
EOF
)"
```

- [ ] **Step 3: Verify the commit**

```bash
git log --oneline -1
```

Expected: the commit shows `chore(electron): bump to 33.x (waypoint 1 of 3)`.

---

## Phase 2 — Waypoint 2: Electron 33 → 37

### Task 2.1: Read breaking changes for majors 34, 35, 36, 37

Same procedure as Task 1.1, for Electron 34, 35, 36, 37.

- [ ] **Step 1: Pull `docs/breaking-changes.md` for each major**

Use `mcp__github__get_file_contents` or equivalent, as in Task 1.1 Step 1.

- [ ] **Step 2: Extract flagged items using the same keyword set as Task 1.1 Step 2**

Same keywords.

- [ ] **Step 3: Produce a waypoint-2 audit note**

Same format as Task 1.1 Step 3. Additionally check and record:

- Node.js version bundled with Electron 35 (expected: Node 22.x — another ABI bump from Node 20)
- Sandbox default evolution (expected: sandbox has been default for renderers since Electron 20, but specific APIs accessible from a sandboxed preload have tightened across 34–37)
- Utility process API changes (vizoguard may not use `utilityProcess` — expected "not applicable")
- `webContents.navigationHistory` (new API introduced ~30-32)
- Any changes to `electron-updater`'s required Electron range

### Task 2.2: Bump Electron to latest 37.x and reinstall

**Files:** same as Task 1.2.

- [ ] **Step 1: Install Electron 37 (latest patch)**

```bash
cd /root/vizoguard-app
rm -rf node_modules package-lock.json
npm install --save-dev electron@37
```

Expected: install completes. Second Node ABI bump (20 → 22) — any native modules that survived waypoint 1 will get another rebuild here.

If `sudo-prompt` fails this time (having survived waypoint 1), enter Task 1.2a (sudo-prompt resolution) again — the 30-minute budget applies per-waypoint.

- [ ] **Step 2: Verify the installed version**

```bash
node -e "console.log(require('./node_modules/electron/package.json').version)"
```

Expected: a `37.x.y` string.

- [ ] **Step 3: Check for peer warnings**

Same as Task 1.2 Step 3.

### Task 2.3: Apply code changes required by the waypoint-2 audit

Same procedure as Task 1.3, using the Task 2.1 audit note as input.

- [ ] **Step 1: For each "applicable" item, apply the documented fix**

Same procedure as Task 1.3 Step 1.

- [ ] **Step 2: Re-verify preload sandbox compatibility**

Because sandbox-accessible API surface has tightened between 33 and 37, re-read `preload.js` and confirm every `require()` in it is still accessible from a sandboxed preload.

```bash
cat preload.js
```

If the preload imports anything beyond `electron` (`contextBridge`, `ipcRenderer`), verify each import is still sandbox-compatible in Electron 37.

- [ ] **Step 3: Test IPC round-trips explicitly**

Inspect IPC-related code:

```bash
grep -n "ipcMain" main.js src/**/*.js
grep -n "ipcRenderer" preload.js ui/**/*.js 2>/dev/null
```

Confirm every IPC channel name is registered exactly once on the main side and called from the preload or renderer. Electron 34-37 has not renamed IPC methods, but sandbox-default tightening can change which IPC calls succeed.

### Task 2.4: Run the automated gate

- [ ] **Step 1: Clean install**

Re-run only if code changes in Task 2.3 touched `package.json`:

```bash
npm install
```

Expected: exit 0.

- [ ] **Step 2: npm audit**

```bash
npm audit 2>&1 | tail -15
```

Expected: no new high/critical vulnerabilities relative to the waypoint-1 baseline. Electron advisories may partially or fully clear at this waypoint.

- [ ] **Step 3: Unit tests**

```bash
node --test test/*.test.js 2>&1 | tail -15
```

Expected: `# tests 60` / `# pass 60` / `# fail 0`. If any test fails, STOP.

- [ ] **Step 4: Dev launch smoke**

```bash
timeout 15 npm start 2>&1 | tee /tmp/waypoint2-start.log
```

Expected: window opens within 15s, no `Error:` lines in main-process stderr, no Electron deprecation error messages.

- [ ] **Step 5: Build dry-run**

```bash
rm -rf dist
npx electron-builder --dir 2>&1 | tail -30
```

Expected: unpacked app under `dist/`, no ASAR integrity errors, no missing-entitlement errors.

### Task 2.5: Run the manual smoke test (7 points)

Requires a GUI desktop environment. **Pay extra attention to Step 4** — `powerMonitor` event behavior is historically volatile and we crossed 4 majors in this hop.

- [ ] **Step 1: License validation IPC**

Launch the app. Enter a valid test license key. Dashboard transitions from "Checking..." to "Protected" after server validation. Pass: dashboard shows "Protected". Fail: stays "Checking..." or shows an error.

- [ ] **Step 2: VPN connect / disconnect**

Tap connect, VPN establishes (check system proxy settings). Tap disconnect, VPN tears down (system proxy cleared). Pass: round-trip succeeds. Fail: connect hangs, disconnect leaves proxy set, or either action throws.

- [ ] **Step 3: Tray interaction**

Right-click the tray icon. Menu appears. "Show dashboard" focuses the window. Pass: menu renders correctly, "Show dashboard" brings window to front. Fail: menu missing items or click does nothing.

- [ ] **Step 4: Sleep / resume** (extra attention at this waypoint)

With VPN connected, put the system to sleep for 10 seconds. Resume. Verify system proxy is still set correctly and VPN still reports connected. Pass: proxy reapplied after resume. Fail: proxy lost or VPN in zombie state.

- [ ] **Step 5: openExternal allowlist**

Click any "Support" link → opens `mailto:support@vizoguard.com`. Click any "Privacy" link → opens `vizoguard.com/privacy`. Try an off-allowlist URL via DevTools — must be blocked. Pass: allowlisted URLs open, off-allowlist blocked.

- [ ] **Step 6: Clipboard auto-clear**

Trigger the "copy access key" flow (copies an `ss://` URL). Wait 30 seconds. Paste somewhere — clipboard should be empty. Pass: clipboard cleared within ~30s.

- [ ] **Step 7: Graceful shutdown**

Quit the app (`Cmd/Ctrl+Q`). Check system proxy cleared. Check no zombie processes:

```bash
ps aux | grep -i vizoguard | grep -v grep
```

Expected: empty output. Pass: clean shutdown, no zombies, proxy cleared.

### Task 2.6: Commit waypoint 2

**Files:** whatever was modified in Tasks 2.2 and 2.3.

- [ ] **Step 1: Review the diff**

```bash
git diff --stat
```

- [ ] **Step 2: Stage and commit**

```bash
git add package.json package-lock.json
git add -u
git commit -m "$(cat <<'EOF'
chore(electron): bump to 37.x (waypoint 2 of 3)

Internal validation waypoint. Crosses Node 20 → 22 ABI and sandbox-
default tightening. Waypoint gate passed: 60/60 tests, dev launch
clean, --dir build clean, 7-point manual smoke passed.

Not shipped to users — waypoint for the 28 → 41 upgrade. See
docs/superpowers/specs/2026-04-07-electron-28-to-41-upgrade-design.md
EOF
)"
```

- [ ] **Step 3: Verify the commit**

```bash
git log --oneline -2
```

Expected: waypoint 2 on top, waypoint 1 below.

---

## Phase 3 — Waypoint 3: Electron 37 → 41

### Task 3.1: Read breaking changes for majors 38, 39, 40, 41

Same procedure as Tasks 1.1 and 2.1, for Electron 38, 39, 40, 41.

- [ ] **Step 1: Pull `docs/breaking-changes.md` for each major**

Same as Task 1.1 Step 1.

- [ ] **Step 2: Extract flagged items using the same keyword set**

Same as Task 1.1 Step 2.

- [ ] **Step 3: Produce a waypoint-3 audit note**

Same format. Additionally check and record:

- CSP strictness changes in the bundled Chromium (expected: stricter parsing of `script-src`, inline-script handling)
- Any final deprecation removals
- Any changes to the `electron-updater` required Electron range — this is **critical** because waypoint 3 is where the updater handshake matters

### Task 3.2: Bump Electron to latest 41.x and reinstall

- [ ] **Step 1: Install Electron 41 (latest patch)**

```bash
cd /root/vizoguard-app
rm -rf node_modules package-lock.json
npm install --save-dev electron@41
```

- [ ] **Step 2: Verify the installed version**

```bash
node -e "console.log(require('./node_modules/electron/package.json').version)"
```

Expected: a `41.x.y` string.

- [ ] **Step 3: Verify `electron-updater` is compatible with Electron 41**

```bash
node -e "console.log(require('./node_modules/electron-updater/package.json').version)"
```

Check the `electron-updater` CHANGELOG on npm or GitHub (`mcp__github__get_file_contents owner=electron-userland repo=electron-builder path=packages/electron-updater/CHANGELOG.md`) for the maximum supported Electron version.

If the installed `electron-updater ^6.8.3` is insufficient for Electron 41, bump it:

```bash
npm install --save electron-updater@latest
```

Record the new version.

### Task 3.3: Apply code changes required by the waypoint-3 audit

Same procedure as Tasks 1.3 and 2.3.

- [ ] **Step 1: For each "applicable" item, apply the documented fix**

Same procedure.

- [ ] **Step 2: Audit the CSP on each UI page**

```bash
grep -rn "Content-Security-Policy" ui/
```

If any UI page uses inline `<script>` or `<style>` with a strict CSP meta tag, verify it still loads in Electron 41 by observing DevTools console during dev launch.

- [ ] **Step 3: Verify macOS entitlements**

```bash
cat build/entitlements.mac.plist
```

Check the waypoint-3 audit note for any new required entitlement. Common candidates:

- `com.apple.security.cs.allow-jit` (sometimes required on ARM64 with newer Chromium)
- `com.apple.security.cs.disable-library-validation`
- `com.apple.security.network.client` (already required — confirm present)

Only add an entitlement if the audit note specifically flags it.

### Task 3.4: Run the automated gate

- [ ] **Step 1: Clean install**

Re-run only if code changes in Task 3.3 touched `package.json`:

```bash
npm install
```

Expected: exit 0.

- [ ] **Step 2: npm audit**

```bash
npm audit 2>&1 | tail -15
```

Expected: **0 vulnerabilities**. This is the secondary success criterion for the whole upgrade. If any Electron advisories remain, the upgrade has not achieved its clean-audit goal — investigate.

- [ ] **Step 3: Unit tests**

```bash
node --test test/*.test.js 2>&1 | tail -15
```

Expected: `# tests 60` / `# pass 60` / `# fail 0`.

- [ ] **Step 4: Dev launch smoke**

```bash
timeout 15 npm start 2>&1 | tee /tmp/waypoint3-start.log
```

Expected: window opens within 15s, no `Error:` lines in main-process stderr, no Electron deprecation error messages.

- [ ] **Step 5: Build dry-run**

```bash
rm -rf dist
npx electron-builder --dir 2>&1 | tail -30
```

Expected: unpacked app under `dist/`, no ASAR integrity errors, no missing-entitlement errors.

- [ ] **Step 6: electron-updater instantiation check** (waypoint 3 only)

```bash
node -e "const { autoUpdater } = require('electron-updater'); console.log('ok:', typeof autoUpdater)"
```

Expected: `ok: object`. Any throw is a blocker — the updater must load in the final build.

### Task 3.5: Run the manual smoke test (7 points)

Requires a GUI desktop environment. This is the final pre-release validation — all 7 must pass before advancing to Phase 4.

- [ ] **Step 1: License validation IPC**

Launch the app. Enter a valid test license key. Dashboard transitions from "Checking..." to "Protected" after server validation. Pass: dashboard shows "Protected".

- [ ] **Step 2: VPN connect / disconnect**

Tap connect, VPN establishes. Tap disconnect, VPN tears down. Pass: round-trip succeeds.

- [ ] **Step 3: Tray interaction**

Right-click tray icon, menu appears, "Show dashboard" focuses window. Pass: menu renders and action works.

- [ ] **Step 4: Sleep / resume**

With VPN connected, sleep the system for 10s, resume. Proxy still set, VPN still reports connected. Pass: proxy reapplied.

- [ ] **Step 5: openExternal allowlist**

"Support" → `mailto:support@vizoguard.com`. "Privacy" → `vizoguard.com/privacy`. Off-allowlist via DevTools blocked. Pass: enforcement intact.

- [ ] **Step 6: Clipboard auto-clear**

Copy `ss://` URL, wait 30s, clipboard empty. Pass: auto-clear works.

- [ ] **Step 7: Graceful shutdown**

Quit app, verify proxy cleared and no zombies:

```bash
ps aux | grep -i vizoguard | grep -v grep
```

Expected: empty. Pass: clean shutdown.

### Task 3.6: Commit waypoint 3

- [ ] **Step 1: Review the diff**

```bash
git diff --stat
```

- [ ] **Step 2: Stage and commit**

```bash
git add package.json package-lock.json
git add -u
git commit -m "$(cat <<'EOF'
chore(electron): bump to 41.x (waypoint 3 of 3)

Final internal waypoint. Gate passed: 60/60 tests, dev launch clean,
--dir build clean, electron-updater loads, 7-point manual smoke passed.
npm audit shows 0 vulnerabilities.

Still not shipped — Phase 4 handles the version bump, signed build,
pre-publish VM test, and release.
EOF
)"
```

- [ ] **Step 3: Verify all three waypoints**

```bash
git log --oneline main..HEAD
```

Expected: three `chore(electron): bump to X.x (waypoint N of 3)` commits on `electron-upgrade` relative to `main`.

---

## Phase 4 — Release

### Task 4.1: Rebase onto main and re-run waypoint 3 gate

**Files:** none (git operations + gate re-run)

- [ ] **Step 1: Fetch latest main**

```bash
git fetch origin main
git log --oneline origin/main..main  # check if local main is behind
```

- [ ] **Step 2: Rebase the upgrade branch onto latest main**

```bash
git checkout electron-upgrade
git rebase origin/main
```

Resolve any conflicts (unlikely on a short-lived branch). If conflicts are substantive (outside `package.json` / `package-lock.json`), STOP and re-evaluate.

- [ ] **Step 3: Re-run the waypoint 3 automated gate after rebase**

Repeat Task 3.4 Steps 1–6. All must still pass.

- [ ] **Step 4: Re-run the manual smoke test**

Repeat Task 3.5. All 7 points must still pass.

### Task 4.2: Bump version to 1.3.5 and commit

**Files:**
- Modify: `/root/vizoguard-app/package.json` (version field)
- Modify: `/root/vizoguard-app/package-lock.json` (version field)

- [ ] **Step 1: Bump the version**

```bash
npm version 1.3.5 --no-git-tag-version
```

Expected: `package.json` and `package-lock.json` updated to `"version": "1.3.5"`. No git tag yet.

- [ ] **Step 2: Verify**

```bash
node -p "require('./package.json').version"
```

Expected: `1.3.5`.

- [ ] **Step 3: Commit the version bump**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
release: v1.3.5 (Electron 41)

Version bump for the Electron 28 → 41 upgrade release. The preceding
three waypoint commits contain the actual Electron upgrade work.
EOF
)"
```

### Task 4.3: Merge electron-upgrade into main

**Files:** none

- [ ] **Step 1: Checkout main and merge**

```bash
git checkout main
git merge --ff-only electron-upgrade
```

Expected: fast-forward merge (because `electron-upgrade` was rebased onto `main` in Task 4.1). If not fast-forward-able, investigate.

- [ ] **Step 2: Verify main tip**

```bash
git log --oneline -5
```

Expected: top commit is `release: v1.3.5 (Electron 41)`, followed by the three waypoint commits.

### Task 4.4: Tag and push

**Files:** none

- [ ] **Step 1: Create the tag**

```bash
git tag -a v1.3.5 -m "v1.3.5 — Electron 41 upgrade"
```

- [ ] **Step 2: STOP — confirm with user before pushing**

Pushing the tag triggers `.github/workflows/build.yml`, which performs real code signing and notarization. This is the point of no easy return.

**Before pushing:**
- Confirm the user wants to proceed with the real signed build.
- Confirm the GitHub Actions secrets (`MAC_CERTIFICATE_P12_BASE64`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CERTIFICATE_P12_BASE64`, etc.) are still valid. If any have expired, renew them before pushing.

- [ ] **Step 3: Push main and the tag**

```bash
git push origin main
git push origin v1.3.5
```

Expected: push succeeds. `build.yml` workflow starts on GitHub Actions.

- [ ] **Step 4: Monitor the Actions run**

```bash
gh run watch --repo pentedigital/vizoguard-app
```

Expected: Mac DMG (x64 + arm64) + Win EXE build, sign, notarize, publish as draft release. If any step fails, STOP and investigate — do not advance to Task 4.5.

### Task 4.5: Pre-publish VM auto-update test (critical)

**Files:** none

This is the test that catches the one non-reversible risk: existing v28 clients failing to auto-update to v41.

- [ ] **Step 1: Download the old v1.3.4 DMG and the new v1.3.5 draft DMG**

```bash
# Old version (still live on the VPS at this point)
curl -O https://vizoguard.com/downloads/Vizoguard-latest.dmg
mv Vizoguard-latest.dmg Vizoguard-1.3.4.dmg

# New version (from the draft release)
gh release download v1.3.5 --repo pentedigital/vizoguard-app -D /tmp/v135 -p '*.dmg' -p '*.exe' -p '*.yml'
```

- [ ] **Step 2: On a clean macOS VM, install v1.3.4**

Boot a clean macOS VM (or a test Mac with no vizoguard history). Install `Vizoguard-1.3.4.dmg`. Launch. Confirm it runs and reports version `1.3.4`.

- [ ] **Step 3: Publish the v1.3.5 release as draft-for-update-testing**

The `electron-updater` client needs to see the new release via GitHub's release feed. Options:

- **Option A (recommended):** Temporarily publish v1.3.5 as `latest` on GitHub, then run the VM update test, then (if it works) leave it as `latest`. This is fine if you're confident in the build.
- **Option B (safer):** Configure the v1.3.4 VM client to look at a side channel (pre-release / beta channel), publish v1.3.5 to that channel, test, then promote to `latest`. Requires `electron-updater` channel config in the app, which vizoguard may not have.

Go with Option A unless vizoguard-app already has channel config. Document which option was used.

- [ ] **Step 4: Trigger auto-update on the VM**

Let the v1.3.4 client poll for updates (may take up to the polling interval — check `src/updater.js` for the interval). Or force a check via the UI.

Expected: client detects v1.3.5, downloads it, prompts to install, installs, relaunches.

- [ ] **Step 5: Verify post-update state**

On the VM, after the update:

1. App launches without errors.
2. Version reports `1.3.5`.
3. License state persisted across the update (previously entered license key still valid).
4. VPN state: clean (disconnected) — this is expected because the update restart clears ephemeral state.
5. Run the 7-point manual smoke test on the updated app.

If any of these fail, STOP. Do not deploy to the VPS. Yank the v1.3.5 release from GitHub (or revert it to draft).

### Task 4.6: Deploy to VPS

**Files:** `/var/www/vizoguard/downloads/` (on the VPS — but already at /root in this session)

Only runs if Task 4.5 succeeded.

- [ ] **Step 1: Back up the existing v1.3.4 artifacts**

```bash
cp /var/www/vizoguard/downloads/Vizoguard-latest.dmg /var/www/vizoguard/downloads/Vizoguard-1.3.4-backup.dmg
cp /var/www/vizoguard/downloads/Vizoguard-latest.exe /var/www/vizoguard/downloads/Vizoguard-1.3.4-backup.exe
ls -la /var/www/vizoguard/downloads/Vizoguard-1.3.4-backup.*
```

Expected: both backup files exist.

- [ ] **Step 2: Download the signed artifacts from the GitHub Actions run**

Already done in Task 4.5 Step 1 for the DMG. Fetch the EXE too if not already:

```bash
gh run download --repo pentedigital/vizoguard-app -D /tmp/build
ls /tmp/build/
```

Expected: `mac-dmg/` and `win-exe/` subdirectories with the signed artifacts.

- [ ] **Step 3: Copy to the downloads directory**

```bash
cp /tmp/build/mac-dmg/*.dmg /var/www/vizoguard/downloads/Vizoguard-latest.dmg
cp /tmp/build/win-exe/*.exe /var/www/vizoguard/downloads/Vizoguard-latest.exe
ls -la /var/www/vizoguard/downloads/Vizoguard-latest.*
```

- [ ] **Step 4: Verify over HTTPS**

```bash
curl -sIL https://vizoguard.com/downloads/Vizoguard-latest.dmg | grep -iE "^(HTTP|Content-Length|Last-Modified)"
curl -sIL https://vizoguard.com/downloads/Vizoguard-latest.exe | grep -iE "^(HTTP|Content-Length|Last-Modified)"
```

Expected: HTTP 200, updated `Last-Modified` matching the copy time.

### Task 4.7: Post-release monitoring setup

**Files:** none (monitoring commands only)

- [ ] **Step 1: Open Grafana dashboard**

Visit `http://localhost:3001` and open the "Vizoguard API" dashboard. Note the current error rate for `license:validate` and `/api/vpn/vless` endpoints.

- [ ] **Step 2: Tail the API logs**

```bash
pm2 logs vizoguard-api --lines 100
```

Watch for any uptick in 4xx / 5xx responses from these endpoints over the next hour.

- [ ] **Step 3: Check GitHub for issue reports**

```bash
gh issue list --repo pentedigital/vizoguard-app --state open --limit 20
```

Watch for new issues tagged crash, update, or startup.

- [ ] **Step 4: 48-hour checklist** (not a blocking step — the release is considered successful after this completes)

At T+1h, T+6h, T+24h, T+48h:
1. Check Grafana for error-rate regressions.
2. Check GitHub issues for new crash reports.
3. Check nginx access logs for unusual patterns.

### Task 4.8: Rollback procedure (only if real users break)

Not run in the happy path. Run only if Task 4.7 monitoring reveals a user-facing regression.

- [ ] **Step 1: Stop new auto-updates**

Revert `latest.yml` and `latest-mac.yml` on the GitHub release (delete the v1.3.5 release assets or mark the release as a pre-release).

- [ ] **Step 2: Restore VPS artifacts**

```bash
cp /var/www/vizoguard/downloads/Vizoguard-1.3.4-backup.dmg /var/www/vizoguard/downloads/Vizoguard-latest.dmg
cp /var/www/vizoguard/downloads/Vizoguard-1.3.4-backup.exe /var/www/vizoguard/downloads/Vizoguard-latest.exe
```

- [ ] **Step 3: Communicate**

Post a release note or status-page update. Users on v1.3.5 who are broken will need to manually reinstall v1.3.4 from the backup URL (or use a `/downloads/Vizoguard-1.3.4.dmg` served separately).

- [ ] **Step 4: Investigate on a new branch**

Do not revert `main`. The upgrade work stays merged but unreleased. Create `electron-upgrade-fix` off `main` and work the regression there.

---

## Success criteria

The upgrade is complete when:

1. Three waypoint commits exist on `main` (from the merged `electron-upgrade` branch), each having passed its go/no-go gate.
2. A `release: v1.3.5 (Electron 41)` commit is on `main`.
3. Tag `v1.3.5` is pushed and the signed / notarized build published.
4. Pre-publish VM auto-update test passed (Task 4.5).
5. New artifacts live at `https://vizoguard.com/downloads/Vizoguard-latest.{dmg,exe}`.
6. 48 hours of post-release monitoring show no error-rate regression attributable to the new client.
7. `npm audit` in `vizoguard-app` returns 0 vulnerabilities.

## Out of scope

- Upgrading `electron-store` beyond the minimum required for compatibility.
- Refactoring `preload.js` beyond what is required by Electron breaking changes.
- Pre-emptively replacing `sudo-prompt` if it still works.
- Adding automated end-to-end Electron tests.
- Enabling any Electron feature vizoguard-app does not currently use.
- Non-security dependency bumps not required by the Electron upgrade.
