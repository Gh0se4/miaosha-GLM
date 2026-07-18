// ── MAIN world fetch bridge ──────────────────────────────────────────────
// Executes isolated-world requests through the page fetch implementation.

var activeMainWorldFetches = new Map();

function postMainWorldFetchEvent(type, payload) {
  payload.type = type;
  payload[MSG_EVT] = true;
  window.postMessage(payload, '*');
}

window.addEventListener('message', function(ev) {
  if (ev.source !== window || !ev.data || !ev.data[MSG_CMD]) return;
  var d = ev.data;
  var requestId = d.requestId || d.reqId;

  if (d.type === 'DO_FETCH_CANCEL') {
    var active = activeMainWorldFetches.get(requestId);
    if (active) {
      active.cancelled = true;
      active.controller.abort();
      activeMainWorldFetches.delete(requestId);
    }
    return;
  }

  if (d.type !== 'DO_FETCH') return;
  var opts = d.opts || {};
  var timing = {
    bridgeReceivedAt: Date.now(),
    bridgeReceivedPerfMs: performance.now(),
  };
  timing.fetchCalledAt = timing.bridgeReceivedAt;
  timing.fetchCalledPerfMs = timing.bridgeReceivedPerfMs;
  timing.responseHeadersAt = timing.fetchCalledAt;
  timing.bodyCompletedAt = timing.fetchCalledAt;
  var common = { requestId: requestId, reqId: requestId, runId: d.runId, shotId: d.shotId };
  var url = String(opts.url || '');
  if (url.indexOf('://bigmodel.cn/') === -1 &&
      url.indexOf('://www.bigmodel.cn/') === -1 &&
      url.indexOf('://www.volcengine.com/') === -1) {
    postMainWorldFetchEvent('DO_FETCH_RESULT', Object.assign({}, common, {
      ok: false,
      error: 'blocked',
      timing: timing,
    }));
    return;
  }

  var controller = new AbortController();
  var entry = { controller: controller, cancelled: false, settled: false };
  activeMainWorldFetches.set(requestId, entry);

  var headers = {};
  if (opts.headers) {
    var keys = Object.keys(opts.headers);
    for (var i = 0; i < keys.length; i++) {
      if (opts.headers[keys[i]] != null) headers[keys[i]] = opts.headers[keys[i]];
    }
  }
  if (!headers['Accept']) headers['Accept'] = 'application/json, text/plain, */*';
  if (!headers['Accept-Language']) headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
  if (!headers['Cache-Control']) headers['Cache-Control'] = 'no-cache';
  headers['Referer'] = location.origin + '/glm-coding';
  headers['sec-ch-ua'] = '"Google Chrome";v="149", "Chromium";v="149", "Not?A_Brand";v="24"';
  headers['sec-ch-ua-mobile'] = '?0';
  headers['sec-ch-ua-platform'] = '"macOS"';

  timing.fetchCalledAt = Date.now();
  timing.fetchCalledPerfMs = performance.now();
  timing.responseHeadersAt = timing.fetchCalledAt;
  timing.bodyCompletedAt = timing.fetchCalledAt;
  postMainWorldFetchEvent('DO_FETCH_STARTED', Object.assign({}, common, { timing: timing }));

  window.fetch(opts.url, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body || undefined,
    credentials: 'include',
    mode: 'cors',
    cache: 'no-cache',
    redirect: 'follow',
    referrer: location.origin + '/glm-coding',
    referrerPolicy: 'strict-origin-when-cross-origin',
    signal: controller.signal,
  })
    .then(function(response) {
      timing.responseHeadersAt = Date.now();
      var responseHeaders = {};
      response.headers.forEach(function(value, key) { responseHeaders[key] = value; });
      return response.text().then(function(body) {
        timing.bodyCompletedAt = Date.now();
        if (entry.cancelled || entry.settled) return;
        entry.settled = true;
        activeMainWorldFetches.delete(requestId);
        postMainWorldFetchEvent('DO_FETCH_RESULT', Object.assign({}, common, {
          ok: true,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: body,
          timing: timing,
        }));
      });
    })
    .catch(function(err) {
      if (entry.cancelled || entry.settled) return;
      entry.settled = true;
      activeMainWorldFetches.delete(requestId);
      postMainWorldFetchEvent('DO_FETCH_RESULT', Object.assign({}, common, {
        ok: false,
        error: err.message || 'fetch error',
        timing: timing,
      }));
    });
});
