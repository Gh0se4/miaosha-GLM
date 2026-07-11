// ── OCR auto-solve (proxied through ISOLATED world to avoid CORS) ──────
var _ocrAvailable = false;
var _ocrChecked = false;

function checkOcrAvailability() {
  if (_ocrChecked) return;
  _ocrChecked = true;
  cmdToOverlay('OCR_CHECK');
}

function ocrSolve(imageBase64) {
  var reqId = 'ocr_' + Math.random().toString(36).slice(2);
  return new Promise(function(resolve) {
    function handler(e) {
      if (!e.data || !e.data[MSG_OVL]) return;
      if (e.data.type !== 'OCR_RESULT' || e.data.reqId !== reqId) return;
      window.removeEventListener('message', handler);
      var d = e.data.data;
      if (d && d.success && d.data && d.data.result) {
        resolve(d.data.result);
      } else {
        resolve(null);
      }
    }
    window.addEventListener('message', handler);
    cmdToOverlay('OCR_SOLVE', { image: imageBase64, reqId: reqId });
    setTimeout(function() {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 10000);
  });
}

// Listen for OCR status updates from ISOLATED world
window.addEventListener('message', function(e) {
  if (!e.data || !e.data[MSG_OVL]) return;
  if (e.data.type === 'OCR_STATUS') {
    _ocrAvailable = !!e.data.available;
  }
});

function autoClickCaptcha() {
  // Check OCR toggle
  var toggle = document.getElementById('_ocrToggle');
  if (!toggle || !toggle.checked) {
    console.log('[OCR] disabled by toggle');
    return;
  }

  // Detect captcha type from header text or DOM elements
  var headerText = document.querySelector('.tencent-captcha-dy__header-text');
  var header = headerText ? headerText.textContent || '' : '';
  var iframeArea = document.querySelector('.tencent-captcha__iframe-area');
  var sliderEl = document.querySelector('[class*=slider-groove], [class*=slider-block]');

  var isSlider = header.indexOf('拖动') !== -1 || header.indexOf('拼图') !== -1 || header.indexOf('滑块') !== -1
    || (iframeArea && iframeArea.offsetParent) || (sliderEl && sliderEl.offsetParent);

  if (isSlider) {
    console.log('[OCR] SLIDER captcha (header: ' + header + '), manual only');
    postToOverlay('OCR_STATUS', { step: 'slider-manual' });
    return;
  }

  if (header.indexOf('点击') === -1) {
    console.log('[OCR] unknown captcha type (header: ' + header + '), manual only');
    postToOverlay('OCR_STATUS', { step: 'unknown-manual' });
    return;
  }

  console.log('[OCR] CLICK captcha detected: ' + header);

  var trySolve = function(attempt) {
    // The REAL captcha image is in verify-bg-img's CSS background-image
    var vbg = document.querySelector('.tencent-captcha-dy__verify-bg-img');
    var bgUrl = '';
    if (vbg) {
      var bg = getComputedStyle(vbg).backgroundImage || '';
      var m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) bgUrl = m[1];
    }
    if (!bgUrl) {
      // Fallback: the bg-placeholder image (low-res but may work)
      var ph = document.querySelector('.tencent-captcha-dy__bg-placeholder');
      if (ph && ph.complete && ph.naturalWidth > 50) bgUrl = ph.src;
    }

    if (bgUrl) {
      console.log('[OCR] captcha image URL:', bgUrl.substring(0,80));
      postToOverlay('OCR_STATUS', { step: 'found-img' });
      var reqId = 'ocr_' + Math.random().toString(36).slice(2);
      function handler(e) {
        if (!e.data || !e.data[MSG_OVL]) return;
        if (e.data.type !== 'OCR_RESULT' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', handler);
        if (e.data.data?.success && e.data.data?.data?.result) {
          postToOverlay('OCR_STATUS', { step: 'solved' });
          applyClicks(e.data.data.data.result, e.data.data.data.imgW || 680, e.data.data.data.imgH || 390);
        } else {
          postToOverlay('OCR_STATUS', { step: 'ocr-failed' });
        }
      }
      window.addEventListener('message', handler);
      setTimeout(function() { window.removeEventListener('message', handler); }, 15000);
      cmdToOverlay('OCR_SOLVE_URL', { reqId: reqId, url: bgUrl });
      return;
    }

    if (attempt < 15) {
      setTimeout(function() { trySolve(attempt + 1); }, 500);
    } else {
      console.log('[OCR] timeout: no captcha image found');
      postToOverlay('OCR_STATUS', { step: 'timeout-no-img' });
    }
  };
  setTimeout(function() { trySolve(1); }, 600);
}

function applyClicks(coordString, imgW, imgH) {
  var rawCoords = coordString.split('|');
  // Deduplicate: merge points within 60px (image space) — same character detected multiple times
  var coords = [];
  for (var i = 0; i < rawCoords.length; i++) {
    var parts = rawCoords[i].split(',');
    var px = parseInt(parts[0]), py = parseInt(parts[1]);
    if (!px || !py) continue;
    var isDuplicate = false;
    for (var j = 0; j < coords.length; j++) {
      var cp = coords[j];
      var dx = px - cp.x, dy = py - cp.y;
      if (Math.sqrt(dx*dx + dy*dy) < 60) { isDuplicate = true; break; }
    }
    if (!isDuplicate) coords.push({x: px, y: py});
  }

  // Get caption text to know how many chars to click
  var headerText = document.querySelector('.tencent-captcha-dy__header-text');
  var captionChars = headerText ? (headerText.textContent.match(/[一-鿿\w]/g) || []) : [];
  var expectedClicks = Math.max(3, captionChars.length); // at least 3

  // Only take the expected number of clicks (from left to right)
  coords.sort(function(a, b) { return a.x - b.x; });
  coords = coords.slice(0, expectedClicks);

  // Find clickable captcha area that's actually visible on screen
  var bgEl = document.querySelector('.tencent-captcha-dy__image-area');
  if (!bgEl) bgEl = document.querySelector('.tencent-captcha-dy__verify-bg-img');
  if (!bgEl) bgEl = document.querySelector('.tencent-captcha-dy__bg-placeholder');
  if (!bgEl) { console.log('[OCR] no captcha element'); return; }

  var rect = bgEl.getBoundingClientRect();
  // Captcha may be animating from offscreen — wait until visible
  if (rect.width < 10 || rect.height < 5 || rect.y < -1000) {
    console.log('[OCR] captcha offscreen (y=' + Math.round(rect.y) + '), waiting...');
    setTimeout(function() { applyClicks(coordString, imgW, imgH); }, 500);
    return;
  }

  imgW = imgW || 680; imgH = imgH || 390;
  var scaleX = rect.width / imgW, scaleY = rect.height / imgH;
  console.log('[OCR] ' + coords.length + ' clicks from ' + rawCoords.length + ' raw, caption: ' + captionChars.join('') + ', area: ' + Math.round(rect.width) + 'x' + Math.round(rect.height));

  var idx = 0;
  function clickNext() {
    if (idx >= coords.length) {
      setTimeout(function() {
        var confirmBtn = document.querySelector('.tencent-captcha-dy__verify-confirm-btn:not([class*=disabled])');
        if (confirmBtn) { console.log('[OCR] confirm clicked'); confirmBtn.click(); }
      }, 600);
      return;
    }
    var c = coords[idx]; idx++;
    var sx = rect.left + c.x * scaleX;
    var sy = rect.top + c.y * scaleY;
    console.log('[OCR] click ' + idx + '/' + coords.length + ' at ' + Math.round(sx) + ',' + Math.round(sy));
    ['mousedown', 'mouseup', 'click'].forEach(function(type) {
      bgEl.dispatchEvent(new MouseEvent(type, { clientX: sx, clientY: sy, bubbles: true, cancelable: true, view: window }));
    });
    setTimeout(clickNext, 500);
  }
  clickNext();
}

function produceCaptcha() {
  if (typeof window.TencentCaptcha === 'undefined') { postMsg('CAPTCHA_ERROR', { msg: 'SDK not loaded' }); return; }
  // Always try OCR at captcha-ready — don't wait for pre-check
  postToOverlay('OCR_STATUS', { step: 'captcha-ready' });
  try {
    var c = new window.TencentCaptcha(CAPTCHA_APPID, function(res) {
      _activeCaptcha = null;
      if (res.ret === 0 && res.ticket) {
        postMsg('CAPTCHA_PRODUCED', { ticket: res.ticket, randstr: res.randstr });
        if (_batchMode) {
          _batchCount++;
          if (_batchCount >= BATCH_SESSION_LIMIT) {
            setBatchMode(false);
            return;
          }
          setTimeout(produceCaptcha, 300);
        }
      }
      else {
        postMsg('CAPTCHA_ERROR', { msg: 'Failed (ret=' + res.ret + ')' });
        if (_batchMode) { setTimeout(produceCaptcha, 500); }
      }
    }, {
      mode: 'popup',
      ready: function() {
        console.log('[OCR] captcha ready, starting auto-solve...');
        postToOverlay('OCR_STATUS', { step: 'captcha-ready' });
        autoClickCaptcha();
        // Watch for errors/refresh and retry
        var bgUrl = null;
        var vbg = document.querySelector('.tencent-captcha-dy__verify-bg-img');
        if (vbg) bgUrl = getComputedStyle(vbg).backgroundImage;
        var retries = 0;
        var retryTimer = setInterval(function() {
          var errIcon = document.querySelector('.tencent-captcha-dy__network-status-icon--error');
          var errVisible = errIcon && getComputedStyle(errIcon).display !== 'none';
          // Also detect captcha refresh (bg image changed after error)
          var newBg = vbg ? getComputedStyle(vbg).backgroundImage : null;
          var bgChanged = (bgUrl && newBg && bgUrl !== newBg);
          if (errVisible || bgChanged) {
            retries++;
            console.log('[OCR] captcha refresh/error, retry #' + retries + (errVisible?' (error)':' (refresh)'));
            bgUrl = newBg; // track new background
            postToOverlay('OCR_STATUS', { step: 'retry-' + retries });
            autoClickCaptcha();
            if (retries >= 5) {
              clearInterval(retryTimer);
              postToOverlay('OCR_STATUS', { step: 'max-retries' });
            }
          }
        }, 2000);
        setTimeout(function() { clearInterval(retryTimer); }, 120000);
      }
    });
    _activeCaptcha = c;
    c.show();
  } catch(e) { postMsg('CAPTCHA_ERROR', { msg: e.message }); }
}

// Force-destroy the currently active captcha modal (for ESC / force-stop)
function destroyActiveCaptcha() {
  if (!_activeCaptcha) return;
  try { _activeCaptcha.destroy(); } catch(e) {}
  _activeCaptcha = null;
}

function setBatchMode(on) {
  _batchMode = on;
  if (on) _batchCount = 0;
  var btn = document.getElementById('_ab');
  if (btn) {
    if (on) {
      btn.innerHTML = '&#9632; Stop Batch <span style="font-size:7px;font-weight:600;opacity:.6;margin-left:4px">(Esc)</span>';
      btn.style.borderColor = '#dc2626';
      btn.style.color = '#dc2626';
      btn.style.background = 'rgba(220,38,38,0.03)';
    } else {
      btn.innerHTML = '+ Solve Captcha';
      btn.style.borderColor = '';
      btn.style.color = '';
      btn.style.background = '';
    }
  }
  // Notify ISOLATED world to show/hide the full-width force-stop banner
  postMsg('BATCH_MODE_STATUS', { active: on });
  if (on) {
    produceCaptcha();
  } else {
    // Immediately close any active captcha modal
    destroyActiveCaptcha();
  }
}

function toggleBatchMode() { setBatchMode(!_batchMode); }

// ── Auto-cleanup on successful order: close captcha modal and exit batch mode
// so the bigmodel.cn native payment UI is not blocked by extension UI. ──
window.addEventListener('message', function(e) {
  if (!e.data || e.data[MSG_OVL] !== true) return;
  if (e.data.type === 'BURST_FIRE_SUCCESS' && e.data.data && e.data.data.bizId) {
    destroyActiveCaptcha();
    if (_batchMode) setBatchMode(false);
  }
});

// ── Keyboard shortcut: Escape to stop batch ──
function setupCaptchaKeyboard() {
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && _batchMode) {
      e.preventDefault();
      e.stopPropagation();
      // Force-destroy the modal BEFORE setting batch mode off,
      // so the modal closes instantly without waiting for callback.
      destroyActiveCaptcha();
      setBatchMode(false);
    }
  }, true);
}
setupCaptchaKeyboard();
