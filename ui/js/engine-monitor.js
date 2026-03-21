/**
 * engine-monitor.js — Collapsible engine view controller.
 *
 * Manages: expand/collapse state, live metric updates via IPC,
 * and "What Just Happened?" message rotation.
 *
 * Loaded via <script src> after animations.js. All functions are
 * in global scope (no module wrapper).
 */

/* ── Internal state ───────────────────────────────────────── */

var _engineUpdateInterval  = null;
var _messageRotateInterval = null;
var _threatMessages        = [];   // newest-first queue, max 20
var _messageIndex          = 0;    // current position in fallback cycle
var _engineSubscribed      = false;

/* ── Fallback educational messages ──────────────────────────── */

var _FALLBACK_MESSAGES = [
  'Your traffic is encrypted with military-grade ChaCha20-Poly1305',
  'Vizoguard blocks tracking scripts before they load in your browser',
  'Your real IP address is hidden from every website you visit',
  'DNS queries are encrypted \u2014 your ISP cannot see which sites you visit',
  'The immune system monitors for tampering and self-repairs if compromised'
];

/* ── DOM helper (mirrors animations.js) ──────────────────────── */

function _engEl(id) {
  return document.getElementById(id);
}

/* ── Text setter helper (null-safe) ──────────────────────────── */

function _setText(id, value) {
  var el = _engEl(id);
  if (el) el.textContent = value;
}

/* ── Width setter helper (null-safe) ─────────────────────────── */

function _setWidth(id, pct) {
  var el = _engEl(id);
  if (el) el.style.width = pct + '%';
}

/* ── HH:MM:SS formatter ──────────────────────────────────────── */

function _formatUptime(seconds) {
  var pad = function(n) { return n < 10 ? '0' + n : String(n); };
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}

/* ── initEngine() ───────────────────────────────────────────── */

function initEngine() {
  // Restore persisted expand state
  try {
    window.vizoguard.getSetting('ui.engineExpanded').then(function(expanded) {
      if (expanded) {
        _applyEngineExpand(true, false);
      }
    }).catch(function() {});
  } catch (e) {
    // IPC not yet available — leave collapsed
  }

  // Attach click handler to engine header
  var header = _engEl('engine-header');
  if (header) {
    header.addEventListener('click', toggleEngine);
  } else {
    // dashboard.html uses inline onclick="toggleEngineView()" on .engine-header
    // but we also expose toggleEngine() for programmatic use
  }

  // Start message rotation unconditionally (fallback messages show always)
  _startMessageRotation();
}

/* ── toggleEngine() ─────────────────────────────────────────── */

function toggleEngine() {
  var view = _engEl('engine-view');
  if (!view) return;

  var expanded = !view.classList.contains('expanded');
  _applyEngineExpand(expanded, true);
}

function _applyEngineExpand(expanded, persist) {
  var view    = _engEl('engine-view');
  var chevron = _engEl('engine-chevron');
  if (!view) return;

  if (expanded) {
    view.classList.add('expanded', 'visible');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    // Only start updates if VPN is connected (animations.js tracks this via
    // _engineExpanded MutationObserver; we call directly here as well)
    startEngineUpdates();
  } else {
    view.classList.remove('expanded');
    if (chevron) chevron.style.transform = '';
    stopEngineUpdates();
  }

  if (persist) {
    try {
      window.vizoguard.setSetting('ui.engineExpanded', expanded);
    } catch (e) {}
  }
}

/* ── startEngineUpdates() ────────────────────────────────────── */

function startEngineUpdates() {
  // Only poll when the engine panel is expanded
  var engineEl = document.getElementById('engine-view');
  if (!engineEl || !engineEl.classList.contains('expanded')) return;

  // Subscribe to engine events from main process
  if (!_engineSubscribed) {
    try {
      if (typeof window.vizoguard.subscribeEngine === 'function') {
        window.vizoguard.subscribeEngine();
      }
      if (typeof window.vizoguard.onEngineUpdate === 'function') {
        window.vizoguard.onEngineUpdate(_handleEngineUpdate);
      }
      _engineSubscribed = true;
    } catch (e) {}
  }

  // Polling fallback: refresh via getSecurityStats every 1 s
  if (_engineUpdateInterval) return;
  _engineUpdateInterval = setInterval(function() {
    try {
      if (typeof window.vizoguard.getSecurityStats === 'function') {
        window.vizoguard.getSecurityStats().then(function(stats) {
          if (!stats) return;
          _applyStats(stats);
        }).catch(function() {});
      }
    } catch (e) {}
  }, 1000);
}

/* ── stopEngineUpdates() ─────────────────────────────────────── */

function stopEngineUpdates() {
  if (_engineUpdateInterval) {
    clearInterval(_engineUpdateInterval);
    _engineUpdateInterval = null;
  }

  if (_engineSubscribed) {
    try {
      if (typeof window.vizoguard.unsubscribeEngine === 'function') {
        window.vizoguard.unsubscribeEngine();
      }
    } catch (e) {}
    _engineSubscribed = false;
  }
}

/* ── _handleEngineUpdate(data) ───────────────────────────────── */

function _handleEngineUpdate(data) {
  if (!data) return;
  _applyStats(data);
}

/* ── _applyStats(data) ───────────────────────────────────────── */

function _applyStats(data) {
  // -- Connection section
  // encryption / cipher
  if (data.cipher !== undefined) {
    _setText('eng-cipher', data.cipher);         // spec name
    _setText('eng-encryption', data.cipher);     // actual HTML id
  } else if (data.encryption !== undefined) {
    _setText('eng-cipher', data.encryption);
    _setText('eng-encryption', data.encryption);
  }

  // server
  if (data.serverHost !== undefined) {
    _setText('eng-server', data.serverHost);
  } else if (data.server !== undefined) {
    _setText('eng-server', data.server);
  }

  // uptime (seconds → HH:MM:SS)
  if (data.uptime !== undefined) {
    var uptimeStr = _formatUptime(Math.floor(data.uptime));
    _setText('eng-uptime', uptimeStr);
  } else if (data.uptimeSeconds !== undefined) {
    _setText('eng-uptime', _formatUptime(Math.floor(data.uptimeSeconds)));
  }

  // IP masked
  if (data.ipMasked !== undefined) {
    var ipText = data.ipMasked ? '\u2713 Masked' : '\u2717 Exposed';
    _setText('eng-ip', ipText);           // spec name
    _setText('eng-ip-masked', ipText);    // actual HTML id
  }

  // DNS
  if (data.dns !== undefined) {
    var dnsText = data.dns === 'encrypted' || data.dnsEncrypted ? 'Encrypted' : 'Standard';
    _setText('eng-dns', dnsText);
  } else if (data.dnsEncrypted !== undefined) {
    _setText('eng-dns', data.dnsEncrypted ? 'Encrypted' : 'Standard');
  }

  // -- Security Engine section
  // requests per second
  var rps = data.rps !== undefined ? data.rps : data.requestsPerSec;
  if (rps !== undefined) {
    var rpsText = rps + ' req/s';
    _setText('eng-rps', rpsText);
    _setText('eng-proxy-rps', rpsText);
  }

  // cache entries
  if (data.cachedEntries !== undefined) {
    _setText('eng-cache', data.cachedEntries + ' entries');
  } else if (data.cacheEntries !== undefined) {
    _setText('eng-cache', data.cacheEntries + ' entries');
  } else if (data.cache !== undefined) {
    _setText('eng-cache', data.cache + ' entries');
  }

  // threats blocked
  if (data.threatsBlocked !== undefined) {
    _setText('eng-threats', data.threatsBlocked + ' blocked');
  } else if (data.threats !== undefined) {
    _setText('eng-threats', data.threats + ' blocked');
  }

  // active connections
  if (data.activeConnections !== undefined) {
    _setText('eng-conns', data.activeConnections + ' active');       // spec name
    _setText('eng-connections', data.activeConnections + ' active'); // actual HTML id
  } else if (data.connections !== undefined) {
    _setText('eng-conns', data.connections + ' active');
    _setText('eng-connections', data.connections + ' active');
  }

  // Threat DB progress bar
  // spec: #eng-db-bar  actual HTML: #eng-threatdb-fill + #eng-threatdb-pct
  if (data.threatDbLoaded !== undefined) {
    var dbPct = data.threatDbLoaded ? 100 : 0;
    _setWidth('eng-db-bar', dbPct);           // spec name
    _setWidth('eng-threatdb-fill', dbPct);    // actual HTML id
    _setText('eng-threatdb-pct', dbPct + '%');
  } else if (data.threatDbPct !== undefined) {
    _setWidth('eng-db-bar', data.threatDbPct);
    _setWidth('eng-threatdb-fill', data.threatDbPct);
    _setText('eng-threatdb-pct', data.threatDbPct + '%');
  }

  // -- Immune System section
  // Layers 1–4: spec uses #immune-l1 .. #immune-l4 (fill bars)
  //             actual HTML uses #immune-l1-fill .. #immune-l4-fill
  var layers = data.layers || data.immuneLayers;
  if (layers) {
    for (var i = 1; i <= 4; i++) {
      var level = layers['l' + i] !== undefined ? layers['l' + i]
                : layers[i - 1]  !== undefined ? layers[i - 1]
                : null;
      if (level !== null) {
        var pct = Math.min(100, Math.max(0, Math.round(level)));
        _setWidth('immune-l' + i, pct);          // spec name
        _setWidth('immune-l' + i + '-fill', pct); // actual HTML id
        _setText('immune-l' + i + '-pct', pct + '%');
      }
    }
  }
}

/* ── addThreatMessage(msg) ───────────────────────────────────── */

function addThreatMessage(msg) {
  if (!msg) return;
  // Prepend (newest first), cap at 20
  _threatMessages.unshift(String(msg));
  if (_threatMessages.length > 20) {
    _threatMessages.length = 20;
  }
  // Show immediately
  _showMessage(_threatMessages[0]);
}

/* ── Message rotation ────────────────────────────────────────── */

function _showMessage(text) {
  var el = _engEl('wh-text');
  if (!el) return;

  // Fade out, swap, fade in
  el.style.transition = 'opacity 0.4s ease';
  el.style.opacity    = '0';

  setTimeout(function() {
    el.textContent  = text;
    el.style.opacity = '1';
  }, 400);
}

function _rotateMessage() {
  if (_threatMessages.length > 0) {
    // Cycle through recent threats (newest first)
    var idx = _messageIndex % _threatMessages.length;
    _showMessage(_threatMessages[idx]);
    _messageIndex++;
  } else {
    // Fallback educational messages
    var fbIdx = _messageIndex % _FALLBACK_MESSAGES.length;
    _showMessage(_FALLBACK_MESSAGES[fbIdx]);
    _messageIndex++;
  }
}

function _startMessageRotation() {
  if (_messageRotateInterval) return;
  // Show first message right away
  _rotateMessage();
  _messageRotateInterval = setInterval(_rotateMessage, 12000);
}

function _stopMessageRotation() {
  if (_messageRotateInterval) {
    clearInterval(_messageRotateInterval);
    _messageRotateInterval = null;
  }
}

/* ── showEngineView() / hideEngineView() ─────────────────────── */

function showEngineView() {
  var view = _engEl('engine-view');
  if (view) {
    view.style.display = '';
    view.classList.add('visible');
  }
}

function hideEngineView() {
  var view = _engEl('engine-view');
  if (view) {
    view.style.display = 'none';
    view.classList.remove('visible');
    stopEngineUpdates();
  }
}

/* ── Auto-init on DOM ready ──────────────────────────────────── */

(function _autoInit() {
  function run() {
    initEngine();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
}());
