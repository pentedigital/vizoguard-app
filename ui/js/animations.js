/**
 * animations.js — Connect button state machine, privacy score,
 * status line, and connection timer.
 *
 * Loaded via <script src> before the inline script in dashboard.html.
 * All functions are in global scope (no module wrapper).
 */

/* ── Internal state ───────────────────────────────────────── */

var _currentVpnState = 'idle';
var _timerInterval   = null;
var _connectedSince  = null;
var _errorClearTimer = null;
var _engineExpanded  = false;

/* ── DOM helpers ──────────────────────────────────────────── */

function _el(id) {
  return document.getElementById(id);
}

/* ── State config ─────────────────────────────────────────── */

var _STATE_MAP = {
  idle: {
    btnClass:   'idle',
    text:       'TAP TO CONNECT',
    dotClass:   'red',
    labelText:  'Exposed',
    labelColor: 'var(--red)',
    ring:       false,
    engine:     false,
    warning:    false
  },
  connecting: {
    btnClass:   'connecting',
    text:       '...',
    dotClass:   'amber',
    labelText:  'Securing...',
    labelColor: 'var(--amber)',
    ring:       true,
    engine:     false,
    warning:    false
  },
  connected: {
    btnClass:   'connected',
    text:       'VPN ON',
    dotClass:   'teal',
    labelText:  'PROTECTED',
    labelColor: 'var(--teal)',
    ring:       false,
    engine:     true,
    warning:    false
  },
  error: {
    btnClass:   'error',
    text:       'FAILED',
    dotClass:   'red',
    labelText:  'Failed',
    labelColor: 'var(--red)',
    ring:       false,
    engine:     false,
    warning:    false
  },
  reconnecting: {
    btnClass:   'connecting',
    text:       '...',
    dotClass:   'amber',
    labelText:  'Reconnecting',
    labelColor: 'var(--amber)',
    ring:       true,
    engine:     false,
    warning:    true
  }
};

/* ── setVpnState(newState) ───────────────────────────────── */

function setVpnState(newState) {
  var cfg = _STATE_MAP[newState];
  if (!cfg) return;

  _currentVpnState = newState;

  // -- Connect button class
  var btn = _el('connect-btn');
  if (btn) {
    btn.className = 'connect-btn ' + cfg.btnClass;
  }

  // -- Connect text
  var textEl = _el('connect-text');
  if (textEl) {
    textEl.textContent = cfg.text;
  }

  // -- Spinning ring (CSS handles show/hide via .connecting class,
  //    but we also control display directly for non-connecting states)
  var ring = _el('connect-ring');
  if (ring) {
    ring.style.display = cfg.ring ? 'block' : '';
  }

  // -- Status dot
  var dot = _el('status-dot');
  if (dot) {
    dot.className = 'status-dot ' + cfg.dotClass;
  }

  // -- Status label
  var label = _el('status-label');
  if (label) {
    label.textContent = cfg.labelText;
    label.style.color = cfg.labelColor;
  }

  // -- Engine view
  var engineView = _el('engine-view');
  if (engineView) {
    if (cfg.engine) {
      engineView.classList.add('visible');
    } else {
      engineView.classList.remove('visible');
    }
  }

  // -- Warning banner
  var warningBanner = _el('warning-banner');
  if (warningBanner) {
    warningBanner.style.display = cfg.warning ? '' : 'none';
    if (cfg.warning) {
      warningBanner.textContent = 'Reconnecting to VPN...';
    }
  }

  // -- Privacy score
  updatePrivacyScore(newState);

  // -- Timer and engine updates
  if (newState === 'connected') {
    startTimer();
    if (typeof startEngineUpdates === 'function') {
      startEngineUpdates();
    }
  } else {
    stopTimer();
    if (typeof stopEngineUpdates === 'function') {
      stopEngineUpdates();
    }
  }

  // -- Error auto-clear after 10s
  if (newState === 'error') {
    if (_errorClearTimer) clearTimeout(_errorClearTimer);
    _errorClearTimer = setTimeout(function() {
      _errorClearTimer = null;
      setVpnState('idle');
    }, 10000);
  } else {
    if (_errorClearTimer) {
      clearTimeout(_errorClearTimer);
      _errorClearTimer = null;
    }
  }
}

/* ── updatePrivacyScore(state) ───────────────────────────── */

function updatePrivacyScore(state) {
  var bar1  = _el('score-bar-1');
  var bar2  = _el('score-bar-2');
  var bar3  = _el('score-bar-3');
  var label = _el('score-label');

  if (!bar1 || !bar2 || !bar3 || !label) return;

  // Reset all bars to inactive
  bar1.className = 'score-bar';
  bar2.className = 'score-bar';
  bar3.className = 'score-bar';

  switch (state) {
    case 'connected':
      bar1.className = 'score-bar active';
      bar2.className = 'score-bar active';
      bar3.className = 'score-bar active';
      label.textContent = 'Protected';
      label.style.color = 'var(--teal)';
      break;

    case 'connecting':
    case 'reconnecting':
      bar1.className = 'score-bar active amber';
      bar2.className = 'score-bar active amber';
      // bar3 stays inactive
      label.textContent = 'Connecting';
      label.style.color = 'var(--amber)';
      break;

    case 'idle':
      bar1.className = 'score-bar active red';
      // bar2, bar3 stay inactive
      label.textContent = 'At Risk';
      label.style.color = 'var(--red)';
      break;

    case 'error':
      // All 3 bars active, red, pulsing
      bar1.className = 'score-bar active red pulse';
      bar2.className = 'score-bar active red pulse';
      bar3.className = 'score-bar active red pulse';
      label.textContent = 'Exposed';
      label.style.color = 'var(--red)';
      break;

    default:
      label.textContent = 'At Risk';
      label.style.color = 'var(--red)';
      break;
  }
}

/* ── startTimer() / stopTimer() ─────────────────────────── */

function startTimer() {
  stopTimer();
  _connectedSince = new Date();

  var pad = function(n) { return n < 10 ? '0' + n : String(n); };

  _timerInterval = setInterval(function() {
    if (!_connectedSince) return;
    var elapsed = Math.floor((Date.now() - _connectedSince.getTime()) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;
    var timerEl = _el('status-timer');
    if (timerEl) {
      timerEl.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
    }
  }, 1000);
}

function stopTimer() {
  if (_timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }
  _connectedSince = null;
  var timerEl = _el('status-timer');
  if (timerEl) timerEl.textContent = '';
}

/* ── Connect button click handler ───────────────────────── */

(function _attachConnectHandler() {
  // Use DOMContentLoaded in case script loads before DOM is ready.
  // In practice dashboard.html places <script> at the bottom, but
  // we guard for safety.
  function attach() {
    var btn = _el('connect-btn');
    if (!btn) return;

    btn.addEventListener('click', function() {
      var state = _currentVpnState;

      // Ignore clicks while transitioning
      if (state === 'connecting' || state === 'reconnecting') return;

      if (state === 'connected') {
        // Disconnect
        if (window.vizoguard && typeof window.vizoguard.vpnDisconnect === 'function') {
          window.vizoguard.vpnDisconnect();
        }
        setVpnState('idle');
        return;
      }

      // idle or error → connect
      setVpnState('connecting');
      if (window.vizoguard && typeof window.vizoguard.vpnConnect === 'function') {
        window.vizoguard.vpnConnect();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
}());

/* ── Engine expanded state tracker ──────────────────────── */

// engine-monitor.js (loaded after this file) calls startEngineUpdates /
// stopEngineUpdates. We track whether the engine body is expanded so
// setVpnState can start/stop updates correctly.
(function _trackEngineExpanded() {
  function track() {
    var engineView = _el('engine-view');
    if (!engineView) return;
    var observer = new MutationObserver(function() {
      _engineExpanded = engineView.classList.contains('expanded');
    });
    observer.observe(engineView, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', track);
  } else {
    track();
  }
}());
