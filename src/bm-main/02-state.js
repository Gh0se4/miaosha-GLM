// Namespace (_NS, MSG_*, SK_*) is defined in 00-css.js (runs first)

var CAPTCHA_APPID = '196026326';
var S = {}; // state
var _batchMode = false; // batch continuous captcha solving
var _batchModeOwner = null; // null | 'manual' | 'auto-ticket'
var _batchCount = 0; // captchas solved in current batch session
var _activeCaptcha = null; // reference to the currently open TencentCaptcha instance (for force-destroy on ESC)
var BATCH_SESSION_LIMIT = 100; // auto-stop after this many per session (default 100, updatable via CAPTCHA_CONFIG)
var _authFailed = false; // true when batch-preview API returns code=1001 (not logged in)
// MAIN-world scripts cannot reliably access chrome.runtime. The content script
// injects the manifest version as a data attribute before this bundle runs.
var _runtimeManifestVersion = (typeof document !== 'undefined' && document.currentScript && document.currentScript.dataset && document.currentScript.dataset.version) || '';

// ── Page-level ticket store (sessionStorage) ──
// Tickets live in the page's sessionStorage: they survive a refresh of the same tab,
// but are destroyed automatically when the tab/window is closed.
var TICKET_STORE_KEY = _NS + SK_TK;
function readPageTicketStore() {
  try { return JSON.parse(window.sessionStorage.getItem(TICKET_STORE_KEY) || '[]'); } catch (e) { return []; }
}
function writePageTicketStore(list) {
  try { window.sessionStorage.setItem(TICKET_STORE_KEY, JSON.stringify(list || [])); } catch (e) {}
}
function clearPageTicketStore() {
  try { window.sessionStorage.removeItem(TICKET_STORE_KEY); } catch (e) {}
}

// Bridge: isolated content script asks MAIN world to read/write the page store.
window.addEventListener('message', function(ev) {
  if (ev.source !== window || !ev.data) return;
  var d = ev.data;

  // Namespace discovery — ISOLATED world asks for _NS before it knows the markers
  if (d.type === 'GET_NAMESPACE') {
    window.postMessage({ type: 'NAMESPACE_DATA', ns: _NS, markers: { cmd: MSG_CMD, evt: MSG_EVT, ovl: MSG_OVL } }, '*');
    return;
  }

  if (!d[MSG_CMD]) return;
  if (d.type === 'READ_TICKET_STORE') {
    var resp = {}; resp[MSG_EVT] = true;
    resp.type = 'TICKET_STORE_DATA'; resp.reqId = d.reqId; resp.list = readPageTicketStore();
    window.postMessage(resp, '*');
  } else if (d.type === 'WRITE_TICKET_STORE') {
    writePageTicketStore(d.list);
  } else if (d.type === 'CLEAR_TICKET_STORE') {
    clearPageTicketStore();
  }
});

// ── Runtime state (latency calibration + auto-fire scheduler) ──
var _rt = {
  latencyMs: 0,       // one-way latency estimate from runtime calibration probes
  clockOffsetMs: 0,   // local clock vs server Date header estimate (ms, can be negative)
  nextSaleTime: 0,    // next sale epoch ms (UTC)
  autoTimer: null,    // setTimeout handle for auto-fire
  countdownTimer: null, // setInterval handle for countdown display
  autoFired: false,   // guard: fire only once per scheduled event
  calibratedAt: 0,    // runtime calibration timestamp (epoch ms)
  sampleCount: 0,     // number of probes used by latest calibration
};

function updateRuntimeDisplay() {
  var latEl = document.getElementById('_lat');
  if (latEl) {
    var latValue = _rt.calibratedAt > 0 ? String(_rt.latencyMs) : '--';
    latEl.innerHTML = latValue + '<span style="font-size:9px;color:#94a3b8">ms</span>';
  }
  var clkEl = document.getElementById('_clk');
  if (clkEl) {
    if (_rt.calibratedAt <= 0) {
      clkEl.innerHTML = '--<span style="font-size:9px;color:#94a3b8">ms</span>';
    } else {
      var sign = _rt.clockOffsetMs >= 0 ? '+' : '';
      clkEl.innerHTML = sign + _rt.clockOffsetMs + '<span style="font-size:9px;color:#94a3b8">ms</span>';
    }
  }
}

function applyRuntimeCalibration(data) {
  if (!data) return false;
  var latency = Number(data.latencyMs);
  var offset = Number(data.clockOffsetMs);
  if (!isFinite(latency) || !isFinite(offset)) return false;

  _rt.latencyMs = Math.max(0, Math.round(latency));
  _rt.clockOffsetMs = Math.round(offset);
  _rt.calibratedAt = typeof data.calibratedAt === 'number' ? data.calibratedAt : Date.now();
  _rt.sampleCount = typeof data.sampleCount === 'number' ? Math.max(0, Math.round(data.sampleCount)) : 0;

  updateRuntimeDisplay();

  // Keep scheduler aligned to freshest calibration.
  if (_rt.nextSaleTime > 0 && !_rt.autoFired) {
    scheduleAutoFire(_rt.nextSaleTime);
  }

  return true;
}

function renderPrefireAuthStatus(data) {
  var authEl = document.getElementById('_auths');
  if (!authEl) return;

  if (!data || !data.ok) {
    authEl.style.color = '#dc2626';
    authEl.textContent = 'Auth: blocked';
    return;
  }

  var source = data.source === 'live-page' ? 'live' : 'cache';
  var ageSec = typeof data.ageMs === 'number' && data.ageMs >= 0
    ? Math.round(data.ageMs / 1000) + 's'
    : '--';
  var suffix = data.tokenSuffix ? (' ...' + data.tokenSuffix) : '';

  authEl.style.color = data.source === 'live-page' ? '#059669' : '#d97706';
  authEl.textContent = 'Auth: ' + source + ' age ' + ageSec + suffix;
}

// ── Namespace-aware messaging helpers ──────────────────────────────────────
function postMsg(type, payload) {
  var m = { type: type, payload: payload };
  m[MSG_EVT] = true;
  window.postMessage(m, '*');
}
function cmdToOverlay(type, data) {
  var m = { type: type };
  if (data !== undefined) m.data = data;
  m[MSG_CMD] = true;
  window.postMessage(m, '*');
}
function postToOverlay(type, data) {
  var m = { type: type, data: data };
  m[MSG_OVL] = true;
  window.postMessage(m, '*');
}

// ── Product Selection State ──
var _productMatrix = { monthly: [], quarterly: [], yearly: [] };
var _billing = 'monthly';
var _priorityList = []; // ordered priority list of { productId }
var _ticketCount = 0;
var _tickets = []; // per-ticket lifecycle list from content script
var _planOrder = ['Lite', 'Pro', 'Max'];
var _fireConfig = { payType: 'ALI', burstIntervalMs: 3200 };
