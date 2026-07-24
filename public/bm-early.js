// MAIN-world script injected by bm-early.content.ts at document_start.
// 1. Saves a reference to the page's original fetch/XHR before the page's Sentry
//    SDK instruments them. The overlay later uses these references to call
//    /api/biz/pay/batch-preview without triggering Alibaba WAF 405 blocks.
// 2. Wraps fetch (and guards window.fetch with a getter/setter) to capture the
//    page's own successful /api/biz/pay/batch-preview response. The page's JS
//    already has to fetch this endpoint; reusing its response lets us avoid a
//    duplicate request that often gets rejected with WAF/rate-limit code 555
//    while the page's request succeeds.
// 3. Reuses the tab's session namespace (_NS), or generates one when absent,
//    to avoid static detection of injected DOM IDs, postMessage markers, and storage keys.
(function() {
  // ── Namespace generation ────────────────────────────────────────────
  var _NS = '';
  try { _NS = sessionStorage.getItem('_st') || ''; } catch(e) {}
  if (!_NS) {
    _NS = 'b' + Math.random().toString(36).slice(2, 8);
    try { sessionStorage.setItem('_st', _NS); } catch(e) {}
  }

  // Internal window properties use namespace-prefixed keys to avoid detection
  var WP_OF = _NS + 'of';  // original fetch
  var WP_NS = _NS + 'ns';  // namespace
  var WP_PD = _NS + 'pd';  // batch preview data
  var WP_OX = _NS + 'ox';  // original XHR

  window[WP_NS] = _NS;

  if (window[WP_OF]) return;
  try {
    var nativeFetch = window.fetch;
    window[WP_OF] = nativeFetch;
    window[WP_PD] = null;

    function cacheBatchPreview(data) {
      if (!data || data.code !== 200 || !data.data || !Array.isArray(data.data.productList) || data.data.productList.length === 0) {
        return;
      }
      window[WP_PD] = data.data.productList;
      try {
        sessionStorage.setItem(_NS + 'bp', JSON.stringify(data));
      } catch(e) {}
    }

    function wrapFetch(fn) {
      return function(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url);
        var p = fn.apply(this, arguments);
        return p.then(function(response) {
          if (url && String(url).indexOf('/api/biz/pay/batch-preview') !== -1 && response && response.clone) {
            try {
              response.clone().json().then(cacheBatchPreview).catch(function(e) {
                console.log('[early] clone/parse failed:', e.message);
              });
            } catch(e) { console.log('[early] clone error:', e.message); }
          }
          return response;
        });
      };
    }

    var wrappedFetch = wrapFetch(nativeFetch);

    // Guard window.fetch so Sentry (or any later library) cannot replace it
    // with an un-wrapped implementation. Reads always return our wrapper;
    // writes get re-wrapped automatically.
    try {
      Object.defineProperty(window, 'fetch', {
        configurable: true,
        enumerable: true,
        get: function() { return wrappedFetch; },
        set: function(newFetch) {
          wrappedFetch = wrapFetch(newFetch);
        }
      });
    } catch(e) {
      window.fetch = wrappedFetch;
    }

    window[WP_OX] = window.XMLHttpRequest;

    // Also intercept XHR for batch-preview (before bm-main.js loads)
    var origXHROpen = XMLHttpRequest.prototype.open;
    var origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u) { this.__u = u; return origXHROpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(b) {
      if (this.__u && String(this.__u).indexOf('/api/biz/pay/batch-preview') !== -1) {
        this.addEventListener('load', function() {
          try {
            var d = JSON.parse(this.responseText);
            cacheBatchPreview(d);
          } catch(e) { console.log('[early] XHR parse error:', e.message); }
        });
      }
      return origXHRSend.apply(this, arguments);
    };
  } catch (e) {}
})();
