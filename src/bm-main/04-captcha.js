// ── OCR auto-solve (integrated from glm-plugin's proven logic) ──────────
// Flow: captcha ready → extract bg image URL → new Image() load → canvas →
// base64 → POST localhost:9898/solve → scale coords → click bgEl → confirm

var _ocrBusy = false;

function autoClickCaptcha() {
  // Check toggle
  var toggle = document.getElementById('_ocrToggle');
  if (!toggle || !toggle.checked) return;
  if (_ocrBusy) return;

  // Detect captcha type
  var headerEl = document.querySelector('.tencent-captcha-dy__header-text');
  var headerText = headerEl ? headerEl.textContent.trim() : '';
  if (headerText.indexOf('拖动') !== -1 || headerText.indexOf('拼图') !== -1) {
    console.log('[OCR] slider captcha, skip');
    postToOverlay('OCR_STATUS', { step: 'slider-manual' });
    return;
  }
  if (headerText.indexOf('点击') === -1) {
    console.log('[OCR] unknown captcha type:', headerText);
    return;
  }

  // Check for errors (glm-plugin pattern)
  var errorIcon = document.querySelector('.tencent-captcha-dy__network-status-icon--error');
  if (errorIcon && getComputedStyle(errorIcon).display !== 'none') {
    console.log('[OCR] captcha error, waiting...');
    setTimeout(autoClickCaptcha, 500);
    return;
  }

  // Find the captcha background image (glm-plugin's approach)
  var bgEl = document.querySelector('.tencent-captcha-dy__verify-bg-img');
  if (!bgEl) {
    console.log('[OCR] no verify-bg-img');
    setTimeout(autoClickCaptcha, 500);
    return;
  }

  var bgStyle = getComputedStyle(bgEl).backgroundImage;
  if (!bgStyle || bgStyle === 'none') {
    console.log('[OCR] no background image');
    setTimeout(autoClickCaptcha, 500);
    return;
  }

  var match = bgStyle.match(/url\(["']?(.*?)["']?\)/);
  if (!match || !match[1]) {
    console.log('[OCR] cannot parse bg URL');
    return;
  }

  var bgUrl = match[1];
  var captionChars = headerText.split('：')[1] ? headerText.split('：')[1].trim().split(/\s+/) : [];
  _ocrBusy = true;
  postToOverlay('OCR_STATUS', { step: 'solving ' + captionChars.join('') });
  console.log('[OCR] captcha image:', bgUrl.substring(0, 80), 'chars:', captionChars.join(''));

  // Load image via new Image() — same as glm-plugin, avoids CORS issues
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function() {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      var b64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];

      // Send to local OCR server (glm-plugin's exact API)
      fetch('http://127.0.0.1:9898/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: b64, remark: captionChars.join('') })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        console.log('[OCR] result:', JSON.stringify(data));
        if (!data.success || !data.data || !data.data.result) {
          console.log('[OCR] recognition failed');
          _ocrBusy = false;
          return;
        }

        var points = data.data.result.split('|').map(function(p) {
          var xy = p.split(',');
          return { x: parseFloat(xy[0]), y: parseFloat(xy[1]) };
        });

        // glm-plugin: scale coordinates from image size to display size
        var rect = bgEl.getBoundingClientRect();
        var scaleW = rect.width / img.naturalWidth;
        var scaleH = rect.height / img.naturalHeight;

        var idx = 0;
        function clickNext() {
          if (idx >= points.length) {
            // All clicked — hit confirm button
            setTimeout(function() {
              var btn = document.querySelector('.tencent-captcha-dy__verify-confirm-btn');
              if (btn) { btn.click(); console.log('[OCR] confirm clicked'); }
              _ocrBusy = false;
              postToOverlay('OCR_STATUS', { step: 'done' });
            }, 300);
            return;
          }
          var sx = rect.left + points[idx].x * scaleW;
          var sy = rect.top + points[idx].y * scaleH;
          // glm-plugin: dispatch on bgEl directly
          ['mousedown', 'mouseup', 'click'].forEach(function(type) {
            bgEl.dispatchEvent(new MouseEvent(type, { clientX: sx, clientY: sy, bubbles: true, cancelable: true, view: window }));
          });
          console.log('[OCR] click ' + (idx+1) + '/' + points.length + ' at ' + Math.round(sx) + ',' + Math.round(sy));
          idx++;
          setTimeout(clickNext, 400);
        }
        clickNext();
      })
      .catch(function(e) {
        console.log('[OCR] fetch error:', e.message);
        _ocrBusy = false;
      });
    } catch(e) {
      console.log('[OCR] image error:', e.message);
      _ocrBusy = false;
    }
  };
  img.onerror = function() {
    console.log('[OCR] image load failed');
    _ocrBusy = false;
  };
  img.src = bgUrl;
}

// ── produceCaptcha: unchanged, handles ticket collection ──────────────
function produceCaptcha() {
  if (typeof window.TencentCaptcha === 'undefined') { postMsg('CAPTCHA_ERROR', { msg: 'SDK not loaded' }); return; }
  postToOverlay('OCR_STATUS', { step: 'captcha-ready' });
  try {
    var c = new window.TencentCaptcha(CAPTCHA_APPID, function(res) {
      _activeCaptcha = null;
      if (res.ret === 0 && res.ticket) {
        postMsg('CAPTCHA_PRODUCED', { ticket: res.ticket, randstr: res.randstr });
        if (_batchMode) {
          _batchCount++;
          if (_batchCount >= BATCH_SESSION_LIMIT) { setBatchMode(false); return; }
          setTimeout(produceCaptcha, 300);
        }
      } else {
        postMsg('CAPTCHA_ERROR', { msg: 'Failed (ret=' + res.ret + ')' });
        if (_batchMode) { setTimeout(produceCaptcha, 500); }
      }
    }, {
      mode: 'popup',
      ready: function() {
        console.log('[OCR] captcha ready');
        postToOverlay('OCR_STATUS', { step: 'captcha-ready' });
        setTimeout(autoClickCaptcha, 500);
      }
    });
    _activeCaptcha = c;
    c.show();
  } catch(e) { postMsg('CAPTCHA_ERROR', { msg: e.message }); }
}

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
      btn.style.borderColor = '#dc2626'; btn.style.color = '#dc2626'; btn.style.background = 'rgba(220,38,38,0.03)';
    } else {
      btn.innerHTML = '+ Solve Captcha';
      btn.style.borderColor = ''; btn.style.color = ''; btn.style.background = '';
    }
  }
  postMsg('BATCH_MODE_STATUS', { active: on });
  if (on) { produceCaptcha(); } else { destroyActiveCaptcha(); }
}

function toggleBatchMode() { setBatchMode(!_batchMode); }

window.addEventListener('message', function(e) {
  if (!e.data || e.data[MSG_OVL] !== true) return;
  if (e.data.type === 'BURST_FIRE_SUCCESS' && e.data.data && e.data.data.bizId) {
    destroyActiveCaptcha(); if (_batchMode) setBatchMode(false);
  }
});

function setupCaptchaKeyboard() {
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && _batchMode) { e.preventDefault(); e.stopPropagation(); destroyActiveCaptcha(); setBatchMode(false); }
  }, true);
}
setupCaptchaKeyboard();
