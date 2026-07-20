var EARLY_MS = 10;
var AUTO_TICKET_START_LEAD_MS = 4 * 60 * 1000 + 58 * 1000;
var AUTO_TICKET_STOP_LEAD_MS = 10 * 1000;
var AUTO_REFRESH_LEAD_MS = 30 * 60 * 1000;
var _autoTicketStartTimer = null, _autoTicketStopTimer = null, _autoRefreshTimer = null, _autoTicketWindowActive = false;

function _autoSetStatus(text, color) {
  var el = document.getElementById('_auto');
  if (el) { el.textContent = text; if (color) el.style.color = color; }
}

function scheduleAutoTicketWindow(nextSaleTime) {
  if (_autoTicketStartTimer) clearTimeout(_autoTicketStartTimer);
  if (_autoTicketStopTimer) clearTimeout(_autoTicketStopTimer);
  if (_autoRefreshTimer) clearTimeout(_autoRefreshTimer);
  var now = Date.now(), startAt = nextSaleTime - AUTO_TICKET_START_LEAD_MS;
  var stopAt = nextSaleTime - AUTO_TICKET_STOP_LEAD_MS, refreshAt = nextSaleTime - AUTO_REFRESH_LEAD_MS;
  var refreshKey = (typeof _NS === 'string' ? _NS : '') + 'auto-refresh-' + nextSaleTime;
  try {
    if (refreshAt > now && !sessionStorage.getItem(refreshKey)) {
      _autoRefreshTimer = setTimeout(function() { try { sessionStorage.setItem(refreshKey, '1'); } catch (e) {} location.reload(); }, refreshAt - now);
    }
  } catch (e) {}
  function start() {
    if (Date.now() >= stopAt) return;
    _autoTicketWindowActive = true;
    window.postMessage({ [MSG_CMD]: true, type: 'AUTO_TICKET_WINDOW_START' }, '*');
    _autoSetStatus('Auto: 录票中（T−10秒停止）', '#6366f1');
  }
  function stop() {
    if (!_autoTicketWindowActive) return;
    _autoTicketWindowActive = false;
    window.postMessage({ [MSG_CMD]: true, type: 'AUTO_TICKET_WINDOW_STOP' }, '*');
    _autoSetStatus('Auto: 已停止录票，等待发射', '#d97706');
  }
  if (startAt <= now) start(); else _autoTicketStartTimer = setTimeout(start, startAt - now);
  if (stopAt <= now) stop(); else _autoTicketStopTimer = setTimeout(stop, stopAt - now);
}

function scheduleAutoFire(nextSaleTime) {
  if (_rt.autoTimer) clearTimeout(_rt.autoTimer);
  if (_rt.countdownTimer) clearInterval(_rt.countdownTimer);
  _rt.autoFired = false;
  _rt.nextSaleTime = nextSaleTime;

  var PREPARATION_LEAD_MS = 3000;
  // targetMs is server-aligned. Convert the compensated first-fetch target to
  // local epoch once, then schedule preparation separately from the first slot.
  // RTT is a round trip; use a one-way estimate instead of firing a full RTT early.
  var oneWayLatencyMs = Math.round(Math.max(0, _rt.latencyMs) / 2);
  var fireStartMs = nextSaleTime - oneWayLatencyMs - EARLY_MS - _rt.clockOffsetMs;
  var prepareAtMs = fireStartMs - PREPARATION_LEAD_MS;
  var delay = prepareAtMs - Date.now();

  var autoEl = document.getElementById('_auto');

  if (delay < -5000) {
    if (autoEl) autoEl.textContent = 'Expired';
    return;
  }

  if (delay <= 0) {
    dispatchAutoFire();
    return;
  }

  // Countdown display (100ms refresh)
  _rt.countdownTimer = setInterval(function() {
    var remaining = prepareAtMs - Date.now();
    var autoEl2 = document.getElementById('_auto');
    if (remaining <= 0) {
      clearInterval(_rt.countdownTimer);
      if (autoEl2) autoEl2.textContent = 'Firing…';
    } else {
      var secs = (remaining / 1000).toFixed(1);
      if (autoEl2) autoEl2.textContent = 'T−' + secs + 's';
    }
  }, 100);

  _rt.autoTimer = setTimeout(dispatchAutoFire, delay);
  // Register secondary preparation timers after the primary firing timer so
  // the launch scheduling remains the first-class, independently testable path.
  scheduleAutoTicketWindow(nextSaleTime);
  if (autoEl) autoEl.textContent = 'Scheduled';
}

function dispatchAutoFire() {
  if (_rt.autoFired) return;
  _rt.autoFired = true;
  if (_rt.countdownTimer) clearInterval(_rt.countdownTimer);
  var ts = new Date().toISOString().replace('T', ' ').substring(0, 23);
  var autoEl = document.getElementById('_auto');
  if (autoEl) autoEl.textContent = 'Fired @ ' + ts.slice(11);
  var lg = document.getElementById('_log');
  if (lg) lg.innerHTML += '> Auto-fire dispatched @ ' + ts + '<br>';
  // Preparation is dispatched before the first fetch slot. The content script
  // uses fireStartMs for FireRunner, never the preparation timestamp.
  window.postMessage({ [MSG_CMD]: true, type: 'PREFIRE_PREPARE', data: {
    targetMs: _rt.nextSaleTime,
    preparationLeadMs: 3000,
    prepareAtMs: _rt.nextSaleTime - Math.round(Math.max(0, _rt.latencyMs) / 2) - EARLY_MS - _rt.clockOffsetMs - 3000,
    fireStartMs: _rt.nextSaleTime - Math.round(Math.max(0, _rt.latencyMs) / 2) - EARLY_MS - _rt.clockOffsetMs,
    startMs: _rt.nextSaleTime - Math.round(Math.max(0, _rt.latencyMs) / 2) - EARLY_MS - _rt.clockOffsetMs,
    rttCompensationMs: Math.round(Math.max(0, _rt.latencyMs) / 2),
    clockOffsetMs: _rt.clockOffsetMs,
    earlyOffsetMs: EARLY_MS,
    reason: 'auto'
  } }, '*');
}
