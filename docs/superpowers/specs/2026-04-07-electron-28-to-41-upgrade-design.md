# Electron 28 → 41 Upgrade — Design Spec

**Date:** 2026-04-07
**Component:** `vizoguard-app` (desktop client)
**Current:** Electron `^28.0.0`
**Target:** Electron `41.x` (latest stable)
**Release:** single user-facing release `1.3.4 → 1.3.5` on the final hop

## Why

1. **Primary driver:** Electron 28 is end-of-life. We want to be on a supported line proactively, before a downstream dependency or signing requirement forces an unplanned upgrade.
2. **Secondary driver:** `npm audit` shows 5 Electron advisories on the current line. Most do not materially affect vizoguard-app in practice (no custom protocol handler, no USB, no offscreen rendering, no webRequest — the security proxy is a separate HTTP server on `127.0.0.1:8888`), but clean audit output is a hygiene win.

The upgrade is not urgent in the "active-exploit" sense. It is urgent in the "don't let it become urgent" sense.

## Constraints and assumptions

- vizoguard-app is signed and notarized, ships via GitHub Releases, and auto-updates existing installs through `electron-updater ^6.8.3`.
- Users on Electron 28 builds must be able to auto-update to the final Electron 41 build. The `electron-updater` handshake is the single non-reversible risk in the whole project.
- Code signing / notarization runs through the existing `.github/workflows/build.yml` pipeline. Secrets are already configured. We must not churn the pipeline unnecessarily.
- 60 unit tests exist (`node --test test/*.test.js`). They are the automated regression safety net.
- No end-to-end Electron runtime tests exist. All runtime coverage is manual smoke.
- Solo maintainer, no staging release channel, no crash telemetry endpoint.
- `sudo-prompt ^9.2.1` is unmaintained since 2020 and is the highest-risk transitive dependency.

## Strategy

### Branch model

- Work happens on a new branch `electron-upgrade` off `main`.
- One git commit per waypoint: waypoint 1 (→ 33.x), waypoint 2 (→ 37.x), waypoint 3 (→ 41.x).
- Each commit includes the Electron version bump, any code changes required by breaking changes at that hop, and any dependency bumps required by that hop.
- No broken intermediate commits. If a waypoint fails the gate, the commit is not made until the waypoint is fixed or the hop is subdivided.
- The final waypoint commit also bumps `package.json` version to `1.3.5`.
- Only the final waypoint triggers the signing / notarization / release pipeline.

### Waypoints

Three hops:

| Waypoint | From → To | Majors crossed | Primary hazards |
|---|---|---|---|
| 1 | 28 → 33 | 5 | Node 18 → 20 ABI bump (Electron 30), ASAR integrity mandatory on macOS (Electron 30), `protocol.register*` deprecation path (31), renderer/IPC tightening |
| 2 | 33 → 37 | 4 | Node 20 → 22 ABI bump (~Electron 35), sandbox-default evolution, utility process API changes, serviceWorker surface changes |
| 3 | 37 → 41 | 4 | Final Chromium bumps, stricter CSP defaults, deprecation removals, `electron-updater` compatibility confirmation |

Waypoints are validation checkpoints. Only the final waypoint results in an artifact users see.

### Rollback

- Intermediate: `git reset --hard` to the previous waypoint commit, or abandon the `electron-upgrade` branch entirely.
- Final release: see "Release process → Rollback procedure" below. The 1.3.4 artifacts are backed up on the VPS before 1.3.5 is deployed, so users can manually reinstall if auto-update is broken.

## Per-waypoint audit checklist

The same 7 categories run at every waypoint. The specific items inside each category are resolved at execution time by reading `electron/electron` `docs/breaking-changes.md` for the majors crossed in that hop.

### 1. Electron breaking-changes review

Read `docs/breaking-changes.md` for every major crossed. Flag any item mentioning: `preload`, `contextIsolation`, `sandbox`, `ipcMain`, `ipcRenderer`, `webContents`, `powerMonitor`, `openExternal`, `session.setProxy`, `app.setLoginItemSettings`, `protocol.`, `autoUpdater`, `BrowserWindow`, or any "removed" / "no longer supported" entry.

Produce a short note listing each flagged item and whether vizoguard-app uses it. Items vizoguard does not use are recorded as "not applicable" and skipped. Items vizoguard does use become concrete code-change tasks for that waypoint.

### 2. Preload API surface

`preload.js` is the only bridge between renderer and main. Verify:

- `contextBridge.exposeInMainWorld` still accepted (it has been stable but minor signature changes have happened).
- Every `ipcRenderer` method used in the preload still exists and has the same signature.
- No Node-only require is reachable from sandboxed renderer code. The preload runs with sandbox enabled in current Electron defaults, but the specific list of Node modules accessible from a sandboxed preload has narrowed across versions — verify nothing the preload imports has been gated.
- `window.vizoguard` is populated when dashboard, activate, and expired pages load (all three HTML pages guard on it).

### 3. Sandbox and context isolation

- `sandbox: true` and `contextIsolation: true` remain set in `new BrowserWindow(...)`.
- IPC round-trip manual tests: `license:validate`, `vpn:connect`, `vpn:disconnect`, threat counter updates, `license:status`.
- The `_vpnConnecting` guard in `vpn:connect` still triggers correctly (double-tap connect should be a no-op, not a race).
- The `license:status` response still has the `ss://` credential stripped (regression check for the security rule).

### 4. Native module ABI

```
rm -rf node_modules package-lock.json
npm install
```

Watch for:

- `node-gyp` rebuild errors, especially around `sudo-prompt` and any of its transitive native deps.
- `NODE_MODULE_VERSION` mismatch warnings on `npm start`.
- Post-install script failures.

If `sudo-prompt` fails to build: do not invest more than 30 minutes at the waypoint. Options in priority order:
1. Local patch (if the fix is trivial — e.g. a Node API rename).
2. Swap to `@vscode/sudo-prompt` (maintained fork, mostly drop-in).
3. Fork `sudo-prompt` under the vizoguard org and publish a patched build.

Only option 1 is attempted at the waypoint; options 2 and 3 pause the waypoint and are resolved on a sub-branch before advancing.

`electron-store` and `electron-updater` are pure JS and do not need ABI rebuilds.

### 5. `electron-updater` compatibility

- Check the `electron-updater` release notes for the maximum Electron version supported by `^6.8.3`. If the installed Electron at the waypoint exceeds that upper bound, bump `electron-updater`.
- `electron-updater` is only fully exercised at waypoint 3 (41). Waypoints 1 and 2 perform a bench-level instantiation check (the module loads without throwing) and defer real updater validation.
- Waypoint 3 additionally performs the pre-publish auto-update VM test defined in "Release process".

### 6. `electron-builder` configuration

- `electron-builder.yml` may need updates:
  - ASAR integrity: Electron 30 made ASAR integrity mandatory on macOS. `electron-builder` has supported this since v24; `^26.8.1` is fine, but the config may need an explicit setting if the build fails.
  - Entitlements (`build/entitlements.mac.plist`): review for any new entitlement required by newer Electron. Candidates to watch include `com.apple.security.cs.allow-jit`, `com.apple.security.cs.disable-library-validation`, and any new network entitlement.
  - `afterSign` hooks: unchanged unless notarization flow changes.
- At each waypoint run `npx electron-builder --dir` (unpacked, unsigned). This validates the build graph without spending the signing / notarization budget. Only the final waypoint runs the real signed / notarized build.

### 7. Runtime smoke

`npm start` and run the 7-point manual smoke test (defined in "Go/no-go gate" below).

## Go/no-go gate

The same gate is applied at every waypoint. All items must pass to advance. One failure means stop and reassess.

### Automated checks

| # | Check | Command | Pass criteria |
|---|---|---|---|
| 1 | Clean install | `rm -rf node_modules package-lock.json && npm install` | Exit 0, no native rebuild errors, no peer warnings that name Electron |
| 2 | `npm audit` | `npm audit` | No new high / critical vulnerabilities introduced relative to the previous waypoint |
| 3 | Unit tests | `node --test test/*.test.js` | 60 / 60 pass |
| 4 | Dev launch | `npm start` | Window opens, main-process stderr is clean, DevTools console is clean on dashboard load |
| 5 | Build dry-run | `npx electron-builder --dir` | Unpacked app builds, no ASAR integrity errors, no missing entitlements |

### Manual smoke test

Run after automated checks pass. ~5 minutes.

1. **License validation IPC** — enter a valid test license key. Dashboard transitions from "Checking..." to "Protected" after server validation. Exercises `license:validate` IPC, backend round-trip, and the `window.vizoguard` bridge.
2. **VPN connect / disconnect** — tap connect, VPN establishes, tap disconnect, VPN tears down. Exercises `vpn:connect` guard, proxy set / clear, `powerMonitor`, preload IPC.
3. **Tray interaction** — right-click tray icon. Menu appears. "Show dashboard" focuses the window. Exercises `src/tray.js`, single-instance enforcement, and window focus.
4. **Sleep / resume** — put the system to sleep for 10 seconds, resume. Proxy is reapplied, VPN still shows correct state. Exercises `powerMonitor` events, which are historically volatile across Electron versions.
5. **`openExternal` allowlist** — "Support" link opens `mailto:support@vizoguard.com`. "Privacy" link opens `vizoguard.com/privacy` in the default browser. A manually injected off-allowlist URL (via DevTools) is blocked.
6. **Clipboard auto-clear** — trigger the "copy access key" flow for an `ss://` URL. Wait 30 seconds. Clipboard is empty. Exercises `clipboardWriteSensitive`.
7. **Graceful shutdown** — `Cmd/Ctrl+Q`. Proxy cleared from system settings. No zombie processes (`ps aux | grep -i vizoguard` is empty).

### No-go triggers

Any of these means stop and do not commit the waypoint:

- Any automated check fails.
- Any manual smoke point fails.
- Main process crashes or hangs on launch.
- Main process logs any Electron deprecation **error** (warnings are OK and logged for later).
- Preload bridge breaks (`window.vizoguard` undefined on any HTML page).
- Native module rebuild fails and is not resolved within 30 minutes at the current waypoint.
- `electron-updater` throws on instantiation (waypoint 3 only — waypoints 1 and 2 may defer updater validation).

### Pause-and-reassess protocol

If a waypoint fails:

1. Do not commit the failing state.
2. Capture the failure: error output, screenshots if the failure is UI-related, which gate item failed.
3. Decide whether the failure is fixable at the current hop granularity or requires subdivision (e.g. 33 → 35 → 37 instead of 33 → 37).
4. The design explicitly permits subdividing hops. Prefer correctness over hop count.

## Cross-cutting concerns

### Dependencies to audit

| Dep | Current | Risk | Action |
|---|---|---|---|
| `electron-updater` | `^6.8.3` | Must support Electron 41 and handshake with v28-built clients | Verify at waypoint 3; bump if needed |
| `electron-store` | `^8.1.0` | Pure JS, low risk | Check at waypoint 1; bump only if it errors |
| `electron-builder` | `^26.8.1` | Already supports Electron 41 | No action unless build fails |
| `sudo-prompt` | `^9.2.1` | **Unmaintained since 2020**, highest-risk dep | Audit at waypoint 1; if broken, patch, swap to `@vscode/sudo-prompt`, or fork |

`sudo-prompt` is flagged as the highest-risk single item in the whole upgrade.

### Code signing and notarization

- macOS entitlements (`build/entitlements.mac.plist`) audited once at waypoint 3.
- Notarization runs through the existing `.github/workflows/build.yml` pipeline. **No workflow changes** until waypoint 3 is locally validated.
- Waypoints 1 and 2 use `electron-builder --dir` (unsigned, unpacked). Fast, sufficient, does not spend the signing budget.

### Auto-updater risk model

The handshake between v28-installed clients and the v41-built release is the single non-reversible risk.

Mitigations:

1. **Conservative version bump.** `1.3.4 → 1.3.5`. `electron-updater` channel semantics unchanged.
2. **Unchanged feed format.** `latest.yml` / `latest-mac.yml` format has been stable across all Electron versions in the upgrade range.
3. **Pre-publish VM test.** Before publishing the GitHub release as `latest`, install the v1.3.4 backup DMG on a clean macOS VM, let it auto-update to the draft release, verify it launches on 1.3.5 without errors.
4. **Backup artifacts on VPS.** `/var/www/vizoguard/downloads/Vizoguard-latest.{dmg,exe}` are copied to `Vizoguard-1.3.4-backup.{dmg,exe}` before 1.3.5 is deployed.

### CSP on renderer HTML

Newer Chromium versions are stricter about CSP. The `ui/` pages (`dashboard.html`, `activate.html`, `expired.html`) are checked at waypoint 3 for new CSP console warnings. Unlikely to break; cheap to check.

### Known unknowns (resolved during execution)

- Whether any IPC channel vizoguard uses was renamed or removed between 28 and 41.
- Whether `powerMonitor` event names shifted (used for sleep / resume proxy reapply).
- Whether `app.setLoginItemSettings` quoting behavior on Windows changed (relevant if vizoguard uses it — to verify during preload / main audit).
- Whether the `openExternal` allowlist pattern matching changed.

These become concrete items during the breaking-changes review at each waypoint.

## Release process (final waypoint only)

Only runs after waypoint 3 passes the gate.

### Pre-release

1. Rebase `electron-upgrade` onto latest `main` and re-run the waypoint 3 gate on the rebased head.
2. Bump `package.json` version `1.3.4 → 1.3.5`, commit as `release: v1.3.5 (Electron 41)`.
3. Merge `electron-upgrade` into `main`.

### Release

4. `git tag v1.3.5 && git push origin main --tags`. Triggers `.github/workflows/build.yml`. Builds Mac DMG (x64 + arm64), Win EXE (x64), signs, notarizes, publishes as draft.
5. **Pre-publish VM auto-update test** (critical — see "Auto-updater risk model"). If it fails, do not publish as `latest`.
6. Backup existing VPS artifacts:
   ```
   cp /var/www/vizoguard/downloads/Vizoguard-latest.dmg /var/www/vizoguard/downloads/Vizoguard-1.3.4-backup.dmg
   cp /var/www/vizoguard/downloads/Vizoguard-latest.exe /var/www/vizoguard/downloads/Vizoguard-1.3.4-backup.exe
   ```
7. Download the new artifacts from the GH Actions run and deploy to the VPS:
   ```
   gh run download <RUN_ID> --repo pentedigital/vizoguard-app -D /tmp/build
   cp /tmp/build/mac-dmg/*.dmg /var/www/vizoguard/downloads/Vizoguard-latest.dmg
   cp /tmp/build/win-exe/*.exe /var/www/vizoguard/downloads/Vizoguard-latest.exe
   ```
8. Publish the draft GitHub release as `latest`. This is what `electron-updater` clients poll.

### Post-release monitoring (48 hours)

- GitHub issues for crash reports.
- Grafana `vizoguard-api` dashboard for error-rate spikes on `license:validate` or VPN credential endpoints.
- nginx and fail2ban logs for unusual request patterns.
- Manual download test: `https://vizoguard.com/downloads/Vizoguard-latest.{dmg,exe}` both resolve to the new hash.

### Rollback procedure

If real users are breaking:

1. Revert `latest.yml` / `latest-mac.yml` on the GitHub release (stops new auto-updates).
2. Restore VPS artifacts: `cp Vizoguard-1.3.4-backup.{dmg,exe} Vizoguard-latest.{dmg,exe}`.
3. Communicate status (release notes or status page).
4. Investigate on a new branch. Do not revert `main` — the upgrade work stays merged but unreleased.

## Success criteria

The upgrade is considered complete when all of the following are true:

- Three waypoint commits exist on `electron-upgrade`, each having passed its go/no-go gate.
- Waypoint 3 passes the pre-publish VM auto-update test.
- Release 1.3.5 publishes as `latest` on GitHub and serves from the VPS.
- 48 hours of post-release monitoring show no error-rate regression on `vizoguard-api` attributable to the new client.
- `npm audit` on `vizoguard-app` returns 0 vulnerabilities.

## Out of scope

- Upgrading `electron-store` beyond the minimum required for compatibility.
- Refactoring `preload.js` beyond what is required by Electron breaking changes.
- Replacing `sudo-prompt` pre-emptively if it still works. Only replace it if it breaks at waypoint 1.
- Adding automated end-to-end tests. That is valuable but is its own project.
- Enabling any Electron feature the app does not currently use (Fuses, asar integrity beyond the mandatory minimum, etc.).
- Non-security dependency bumps not required by the Electron upgrade.
