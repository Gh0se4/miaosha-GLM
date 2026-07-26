// ── MAIN world fetch bridge (volcengine codingplan) ─────────────────────
window.addEventListener('message', function(ev) {
  if (ev.source !== window || !ev.data) return;
  var d = ev.data;
  if (!d.__volc_cmd) return;
  if (d.type !== 'DO_FETCH') return;

  var reqId = d.reqId;
  var opts = d.opts || {};

  var url = String(opts.url || '');
  if (url.indexOf('://www.volcengine.com/') === -1) {
    window.postMessage({ __volc_overlay: true, type: 'DO_FETCH_RESULT', reqId: reqId, ok: false, error: 'blocked' }, '*');
    return;
  }

  var headers = {};
  if (opts.headers) {
    var keys = Object.keys(opts.headers);
    for (var i = 0; i < keys.length; i++) {
      if (opts.headers[keys[i]] != null) headers[keys[i]] = opts.headers[keys[i]];
    }
  }

  fetch(opts.url, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body || undefined,
    credentials: 'include',
  })
    .then(function(r) {
      return r.text().then(function(body) {
        window.postMessage({ __volc_overlay: true, type: 'DO_FETCH_RESULT', reqId: reqId, ok: true, status: r.status, statusText: r.statusText, body: body }, '*');
      });
    })
    .catch(function(err) {
      window.postMessage({ __volc_overlay: true, type: 'DO_FETCH_RESULT', reqId: reqId, ok: false, error: err.message || 'fetch error' }, '*');
    });
});
