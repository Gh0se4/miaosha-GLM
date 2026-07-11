// ── 12-fire-log.js ── Persistent Fire Diagnostic Log ──────────────────
// Captures ALL fire events into a structured log stored in sessionStorage.
// Log survives page refreshes and can be downloaded as a standalone JSON
// file to the user's Downloads folder — completely independent of the
// extension, so it survives extension updates and removal.
//
// Log entries include:
//   timestamp, shot index, product ID, ticket mask, outcome, HTTP code,
//   RTT (ms), raw server message, classification, responsibility chain.

var _log_entries = [];
var _log_sessionId = '';
var _log_waveCount = 0;
var _log_shotSeq = 0;

(function initFireLog() {
  // Load existing log from sessionStorage
  try {
    var saved = JSON.parse(sessionStorage.getItem(_NS + 'lg') || 'null');
    if (saved && Array.isArray(saved.entries)) {
      _log_entries = saved.entries;
      _log_sessionId = saved.sessionId || '';
      _log_shotSeq = saved.shotSeq || 0;
    }
  } catch(e) {}

  // Generate a new session ID if none exists
  if (!_log_sessionId) {
    _log_sessionId = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  }

  function saveLog() {
    try {
      sessionStorage.setItem(_NS + 'lg', JSON.stringify({
        sessionId: _log_sessionId,
        updatedAt: new Date().toISOString(),
        entries: _log_entries,
        shotSeq: _log_shotSeq,
        waveCount: _log_waveCount
      }));
    } catch(e) {}
  }

  function downloadLog() {
    var report = {
      exportedAt: new Date().toISOString(),
      sessionId: _log_sessionId,
      extensionVersion: '1.4.2',
      userAgent: navigator.userAgent,
      totalShots: _log_entries.length,
      summary: {
        success: 0, busy: 0, soldout: 0, error: 0,
        neterr: 0, captchaService: 0, captchaInvalid: 0, captchaRisk: 0
      },
      entries: _log_entries
    };

    for (var i = 0; i < _log_entries.length; i++) {
      var o = _log_entries[i].outcome;
      if (report.summary[o] !== undefined) report.summary[o]++;
    }

    var blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'qianggou-fire-log-' + _log_sessionId + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function clearLog() {
    _log_entries = [];
    _log_shotSeq = 0;
    _log_waveCount = 0;
    try { sessionStorage.removeItem(_NS + 'lg'); } catch(e) {}
    _log_addLine('Log cleared', '#94a3b8');
  }

  function _log_formatTs() {
    var d = new Date();
    function p(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    return p(d.getHours(),2) + ':' + p(d.getMinutes(),2) + ':' +
           p(d.getSeconds(),2) + '.' + p(d.getMilliseconds(),3);
  }

  function _log_addLine(text, color) {
    // Forward to Fire Matrix console if visible
    postToOverlay('FIRE_RESULT', { line: text });
  }

  // Listen for fire events
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data[MSG_OVL]) return;
    var d = e.data;

    if (d.type === 'FIRE_BATCH_START' && d.data) {
      _log_waveCount++;
      _log_addLine('▶ Wave ' + _log_waveCount + ' · ' + (d.data.totalShots || 0) + ' shots', '#6366f1');
      var cfg = {
        mode: d.data.mode || 'manual',
        burstIntervalMs: d.data.burstIntervalMs || 0,
        totalShots: d.data.totalShots || 0,
        startMs: d.data.startMs || Date.now()
      };
      _log_addLine('  CONFIG ' + JSON.stringify(cfg), '#94a3b8');
    }

    if (d.type === 'FIRE_SHOT_RESULT' && d.data) {
      var shot = d.data;
      _log_shotSeq++;
      var entry = {
        seq: _log_shotSeq,
        wave: _log_waveCount,
        shotIdx: shot.shotIdx,
        productId: shot.productId || '?',
        priority: shot.priority || '?',
        ticketMask: shot.ticketMask || '?',
        outcome: shot.outcome || 'error',
        httpCode: shot.code,
        rttMs: shot.rtt,
        sentAt: shot.sentAt,
        serverMsg: shot.serverMsg || '',
        rawServerMsg: shot.rawServerMsg || '',
        rawBody: shot.rawBody || shot.rawServerMsg || shot.serverMsg || '',
        httpStatus: shot.httpCode || 0,
        rttMs: shot.rtt || 0,
        responsibility: shot.responsibility || null,
        bizId: shot.bizId || null,
        time: _log_formatTs()
      };
      _log_entries.push(entry);
      saveLog();

      // Build log line
      var tag = '>[#' + entry.shotIdx + '/' + (entry.wave) + '][P' + entry.priority + ']';
      var outcomeColor = {
        success: '#059669', soldout: '#64748b', busy: '#d97706',
        error: '#dc2626', neterr: '#dc2626',
        captchaService: '#7c3aed', captchaInvalid: '#ea580c', captchaRisk: '#be123c'
      }[entry.outcome] || '#475569';
      var line = tag + ' ' + (entry.productId ? entry.productId.slice(-6) : '?') +
                 ': ' + entry.outcome + ' (' + (entry.rttMs || '?') + 'ms)';
      if (entry.httpCode) line += ' code=' + entry.httpCode;
      if (entry.serverMsg) line += ' ' + entry.serverMsg.substring(0, 80);
      _log_addLine(line, outcomeColor);
    }

    if (d.type === 'BURST_FIRE_DEPLETED') {
      var tot = (d.data && d.data.total) || 0;
      _log_addLine('⊘ Depleted — ' + tot + ' shots, no order', '#dc2626');
      _log_addLine('  Log: ' + _log_entries.length + ' entries. Auto-downloading...', '#94a3b8');
      // Auto-download log file so it survives tab close / browser restart
      setTimeout(function() { downloadLog(); }, 500);
    }

    if (d.type === 'BURST_FIRE_SUCCESS' && d.data) {
      var biz = d.data.bizId ? String(d.data.bizId).slice(-8) : '?';
      _log_addLine('✔ ORDER SUCCESS · bizId=' + biz, '#059669');
      // Auto-download on success too
      setTimeout(function() { downloadLog(); }, 1000);
    }

    if (d.type === 'PREFIRE_STATUS' && d.data && !d.data.ok) {
      _log_addLine('⊘ Prefire blocked: ' + (d.data.reason || 'unknown'), '#dc2626');
    }
  });

  // Expose download/clear globally for the Fire Matrix buttons
  window.__fireLogDownload = downloadLog;
  window.__fireLogClear = clearLog;
  window.__fireLogEntries = function() { return _log_entries; };
  window.__fireLogSummary = function() {
    var s = { success: 0, busy: 0, soldout: 0, error: 0, neterr: 0, captchaService: 0, captchaInvalid: 0, captchaRisk: 0 };
    for (var i = 0; i < _log_entries.length; i++) {
      var o = _log_entries[i].outcome;
      if (s[o] !== undefined) s[o]++;
    }
    return s;
  };
})();
