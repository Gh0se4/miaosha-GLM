var EARLY_MS = 10;

function scheduleAutoFire(nextSaleTime) {
  if (_rt.autoTimer) clearTimeout(_rt.autoTimer);
  if (_rt.countdownTimer) clearInterval(_rt.countdownTimer);
  _rt.autoFired = false;
  _rt.nextSaleTime = nextSaleTime;

  var PREPARATION_LEAD_MS = 3000;
  // targetMs is server-aligned. Convert the compensated first-fetch target to
  // local epoch once, then schedule preparation separately from the first slot.
  var fireStartMs = nextSaleTime - _rt.latencyMs - EARLY_MS - _rt.clockOffsetMs;
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
    prepareAtMs: _rt.nextSaleTime - _rt.latencyMs - EARLY_MS - _rt.clockOffsetMs - 3000,
    fireStartMs: _rt.nextSaleTime - _rt.latencyMs - EARLY_MS - _rt.clockOffsetMs,
    startMs: _rt.nextSaleTime - _rt.latencyMs - EARLY_MS - _rt.clockOffsetMs,
    rttCompensationMs: _rt.latencyMs,
    clockOffsetMs: _rt.clockOffsetMs,
    earlyOffsetMs: EARLY_MS,
    reason: 'auto'
  } }, '*');
}
