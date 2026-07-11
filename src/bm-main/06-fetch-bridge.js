// ── MAIN world fetch bridge ──────────────────────────────────────────────
// Handles DO_FETCH requests from the ISOLATED world, executes them via
// the page's fetch (which includes Sentry instrumentation), making requests
// indistinguishable from normal page traffic.

window.addEventListener('message', function(ev) {
  if (ev.source !== window || !ev.data) return;
  var d = ev.data;
  if (!d[MSG_CMD]) return;
  if (d.type !== 'DO_FETCH') return;

  var reqId = d.reqId;
  var opts = d.opts || {};

  var url = String(opts.url || '');
  if (url.indexOf('://bigmodel.cn/') === -1 &&
      url.indexOf('://www.bigmodel.cn/') === -1 &&
      url.indexOf('://www.volcengine.com/') === -1) {
    var blocked = { type: 'DO_FETCH_RESULT', reqId: reqId };
    blocked[MSG_EVT] = true;
    blocked.ok = false; blocked.error = 'blocked';
    window.postMessage(blocked, '*');
    return;
  }

  // Build browser-like headers to blend with normal page traffic
  var headers = {};
  // Copy caller-provided headers (Authorization, Content-Type, etc.)
  if (opts.headers) {
    var keys = Object.keys(opts.headers);
    for (var i = 0; i < keys.length; i++) {
      if (opts.headers[keys[i]] != null) headers[keys[i]] = opts.headers[keys[i]];
    }
  }
  // Add standard browser headers that the page would normally send
  if (!headers['Accept']) headers['Accept'] = 'application/json, text/plain, */*';
  if (!headers['Accept-Language']) headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
  if (!headers['Cache-Control']) headers['Cache-Control'] = 'no-cache';
  headers['Referer'] = location.origin + '/glm-coding';
  headers['sec-ch-ua'] = '"Google Chrome";v="149", "Chromium";v="149", "Not?A_Brand";v="24"';
  headers['sec-ch-ua-mobile'] = '?0';
  headers['sec-ch-ua-platform'] = '"macOS"';

  // Use the page's window.fetch (which includes Sentry instrumentation)
  // to make the request indistinguishable from normal page traffic.
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
  })
    .then(function(r) {
      return r.text().then(function(body) {
        var resp = { type: 'DO_FETCH_RESULT', reqId: reqId };
        resp[MSG_EVT] = true;
        resp.status = r.status;
        resp.statusText = r.statusText;
        resp.body = body;
        resp.ok = true;
        window.postMessage(resp, '*');
      });
    })
    .catch(function(err) {
      var resp = { type: 'DO_FETCH_RESULT', reqId: reqId };
      resp[MSG_EVT] = true;
      resp.ok = false;
      resp.error = err.message || 'fetch error';
      window.postMessage(resp, '*');
    });
});
