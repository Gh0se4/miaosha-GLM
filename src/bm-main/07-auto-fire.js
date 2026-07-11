function scheduleAutoFire(nextSaleTime) {
  if (_rt.autoTimer) clearTimeout(_rt.autoTimer);
  if (_rt.countdownTimer) clearInterval(_rt.countdownTimer);
  _rt.autoFired = false;
  _rt.nextSaleTime = nextSaleTime;

  var EARLY_MS = 10; // fire 10ms before target to compensate for setTimeout jitter
  // Server-aligned baseline: offset > 0 means server clock is ahead of local clock.
  var fireAtServer = nextSaleTime - _rt.latencyMs - EARLY_MS;
  var nowServer = Date.now() + _rt.clockOffsetMs;
  var delay = fireAtServer - nowServer;

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
    var remaining = fireAtServer - (Date.now() + _rt.clockOffsetMs);
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
  // Convert server-aligned fire point back to local epoch for content-script timers.
  var startMs = _rt.nextSaleTime - _rt.latencyMs - 10 - _rt.clockOffsetMs;
  window.postMessage({ [MSG_CMD]: true, type: 'PREFIRE_FIRE', data: { startMs: startMs, reason: 'auto' } }, '*');
}
