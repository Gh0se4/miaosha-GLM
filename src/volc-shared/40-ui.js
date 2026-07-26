// UI rendering, header pills, selection state and refresh loop for the volcengine overlays (shared by Agent & Coding Plan).

let __volc_catalogData = null;
let __volc_selectedProductIds = new Set();
let __volc_activeTab = null;
let __volc_isExtracting = false;
let __volc_isRefreshing = false;
let __volc_refreshTimer = null;
let __volc_refreshQueue = [];
let __volc_refreshCount = 0;
let __volc_isLoggedIn = false;
const __volc_MAX_SELECTIONS = 3;
const __volc_MIN_REFRESH_MS = 500;
const __volc_MAX_REFRESH_MS = 10000;
const __volc_DEFAULT_REFRESH_MS = 500;
let __volc_refreshIntervalMs = __volc_DEFAULT_REFRESH_MS;
const __volc_TAB_ORDER = ['monthly', 'quarterly', 'yearly'];
const __volc_TAB_LABELS = { monthly: '月付', quarterly: '季付', yearly: '年付' };

function __volc_ensureActiveTab() {
  if (!__volc_catalogData) return;
  if (__volc_activeTab && __volc_catalogData.groups[__volc_activeTab]?.length) return;
  const groups = __volc_catalogData.groups;
  if (__volc_config.defaultProductId) {
    for (let i = 0; i < __volc_TAB_ORDER.length; i++) {
      const tab = __volc_TAB_ORDER[i];
      const found = (groups[tab] || []).some(function (p) { return p.id === __volc_config.defaultProductId; });
      if (found) {
        __volc_activeTab = tab;
        return;
      }
    }
  }
  for (let i = 0; i < __volc_TAB_ORDER.length; i++) {
    const tab = __volc_TAB_ORDER[i];
    if ((groups[tab] || []).length) {
      __volc_activeTab = tab;
      return;
    }
  }
  __volc_activeTab = 'monthly';
}

function __volc_ensureDefaultSelection() {
  if (__volc_selectedProductIds.size > 0) return;
  if (!__volc_catalogData) return;
  const all = [].concat(
    __volc_catalogData.groups.monthly,
    __volc_catalogData.groups.quarterly,
    __volc_catalogData.groups.yearly,
  );
  const hasDefault = all.some(function (p) { return p.id === __volc_config.defaultProductId; });
  if (hasDefault) __volc_selectedProductIds.add(__volc_config.defaultProductId);
}

async function __volc_extractAndSend() {
  if (__volc_isExtracting) return false;
  __volc_isExtracting = true;
  try {
    const items = __volc_parseBundle();
    if (items.length === 0) return false;
    const prices = await __volc_fetchAllPrices(items);
    __volc_catalogData = __volc_buildCatalog(items, prices);
    __volc_ensureDefaultSelection();
    __volc_ensureActiveTab();
    __volc_postCmd('VOLC_CATALOG', { catalog: __volc_catalogData });
    __volc_render();
    return true;
  } finally {
    __volc_isExtracting = false;
  }
}

function __volc_createOverlay() {
  const existing = document.getElementById('__volc_overlay');
  if (existing) return existing;
  const el = document.createElement('div');
  el.id = '__volc_overlay';
  el.style.cssText =
    'position:fixed;top:80px;left:20px;width:280px;background:rgba(255,255,255,0.98);' +
    'backdrop-filter:blur(12px);border:1px solid #e2e8f0;border-radius:16px;' +
    'box-shadow:0 8px 32px rgba(0,0,0,0.15);z-index:2147483646;' +
    'font-family:Inter,system-ui,sans-serif;color:#1e293b;overflow:hidden;padding:12px;';
  document.body.appendChild(el);
  __volc_bindDrag(el);
  return el;
}

function __volc_formatProductTag(product) {
  if (!product) return '';
  const billing = __volc_TAB_LABELS[product.billingPeriod] || '';
  return '【' + billing + '】【' + product.name + '】';
}

function __volc_ensureOverlayCSS() {
  if (document.getElementById('__volc_overlay_anim_css')) return;
  const style = document.createElement('style');
  style.id = '__volc_overlay_anim_css';
  style.textContent =
    '@keyframes __volc_spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}' +
    '.__volc_spin{display:inline-block;width:10px;height:10px;border:2px solid #6366f1;border-top-color:transparent;border-radius:50%;animation:__volc_spin 0.8s linear infinite;margin-right:5px;vertical-align:middle}' +
    '.__volc_interval-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;font-size:10px;color:#64748b}' +
    '.__volc_interval-row input[type=range]{-webkit-appearance:none;-moz-appearance:none;appearance:none;flex:1;height:4px;background:#e2e8f0;border-radius:2px;outline:none;margin:0 6px}' +
    '.__volc_interval-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#6366f1;cursor:pointer;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.2)}' +
    '.__volc_interval-row input[type=range]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#6366f1;cursor:pointer;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.2)}' +
    '.__volc_interval-hints{display:flex;justify-content:space-between;font-size:8px;color:#94a3b8;padding:0 2px;margin-top:2px}';
  (document.head || document.documentElement).appendChild(style);
}

function __volc_bindDrag(overlay) {
  let ox, oy, baseLeft, baseTop, dragging = false;
  overlay.addEventListener('mousedown', function (e) {
    const hd = e.target.closest && e.target.closest('.__volc_hd');
    if (!hd) return;
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    ox = e.clientX;
    oy = e.clientY;
    const r = overlay.getBoundingClientRect();
    baseLeft = r.left;
    baseTop = r.top;
    overlay.style.transition = 'none';
    overlay.style.right = 'auto';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    overlay.style.left = (baseLeft + e.clientX - ox) + 'px';
    overlay.style.top = (baseTop + e.clientY - oy) + 'px';
  });
  document.addEventListener('mouseup', function () {
    if (dragging) {
      dragging = false;
      overlay.style.transition = '';
    }
  });
}

function __volc_render() {
  const root = __volc_createOverlay();
  __volc_ensureOverlayCSS();
  if (!__volc_catalogData) {
    root.innerHTML = '<div style="font-size:12px;font-weight:700;color:#64748b">未解析到套餐数据</div>';
    return;
  }
  __volc_ensureActiveTab();

  let html = '<div class="__volc_hd" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;cursor:move;user-select:none"' +
    '><span style="font-size:13px;font-weight:800">' + __volc_config.title + '</span>' +
    '<span style="font-size:9px;color:#94a3b8">v' + __volc_config.version + '</span></div>';

  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:10px;color:#64748b"' +
    '><span>已选 ' + __volc_selectedProductIds.size + '/' + __volc_MAX_SELECTIONS + ' 个商品</span>' +
    (__volc_isRefreshing ? '<span style="color:#f59e0b;display:flex;align-items:center"><span class="__volc_spin"></span>刷新中</span>' : '') + '</div>';

  // Billing-period tabs (same small-pill pattern as the Zhipu overlay).
  html += '<div style="display:flex;gap:6px;margin-bottom:10px">';
  for (let i = 0; i < __volc_TAB_ORDER.length; i++) {
    const tab = __volc_TAB_ORDER[i];
    const active = tab === __volc_activeTab;
    const count = (__volc_catalogData.groups[tab] || []).length;
    html += '<button data-tab="' + tab + '" style="' +
      'flex:1;padding:6px 0;border:1px solid ' + (active ? '#6366f1' : '#e2e8f0') + ';' +
      'border-radius:8px;background:' + (active ? '#6366f1' : '#fff') + ';' +
      'color:' + (active ? '#fff' : '#475569') + ';font-size:11px;font-weight:700;cursor:' + (count ? 'pointer' : 'not-allowed') + ';' +
      'opacity:' + (count ? '1' : '0.5') + '" ' + (count ? '' : 'disabled') + '>' +
      __volc_TAB_LABELS[tab] +
      '</button>';
  }
  html += '</div>';

  const products = __volc_catalogData.groups[__volc_activeTab] || [];
  html += '<div style="max-height:240px;overflow-y:auto;margin-bottom:10px">';
  if (products.length === 0) {
    html += '<div style="font-size:11px;color:#94a3b8;text-align:center;padding:14px 0">该周期暂无可用套餐</div>';
  }
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const on = __volc_selectedProductIds.has(p.id);
    const currentText = p.currentAmount > 0 ? '¥' + p.currentAmount : '¥--';
    const originalText = p.originalPrice > p.currentAmount && p.currentAmount > 0
      ? ' <s style="color:#94a3b8">¥' + p.originalPrice + '</s>'
      : '';
    html += '<div data-pid="' + p.id + '" style="' +
      'padding:8px 10px;border:1.5px solid ' + (on ? '#6366f1' : '#e2e8f0') + ';' +
      'border-radius:10px;margin-bottom:6px;cursor:pointer;background:' + (on ? 'rgba(99,102,241,0.04)' : '#fff') + ';' +
      'display:flex;align-items:center;gap:8px"' +
      '>' +
      '<div style="width:14px;height:14px;border-radius:4px;border:1.5px solid ' + (on ? '#6366f1' : '#cbd5e1') + ';' +
      'background:' + (on ? '#6366f1' : '#fff') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
      (on ? '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5L4 7.5L8.5 3" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '') +
      '</div>' +
      '<div style="flex:1;min-width:0">' +
      '<div style="display:flex;align-items:center;justify-content:space-between">' +
      '<span style="font-size:11px;font-weight:700">' + p.name + '</span>' +
      '<span style="font-size:11px;font-weight:800;color:#dc2626">' + currentText + '</span>' +
      '</div>' +
      '<div style="font-size:9px;color:#64748b;margin-top:2px">' + p.description + originalText + '</div>' +
      '</div>' +
      '</div>';
  }
  html += '</div>';

  const authState = __volc_vh_readLoginState();
  const isLoggedIn = authState.loggedIn;
  __volc_isLoggedIn = isLoggedIn;
  const hasSelection = __volc_selectedProductIds.size > 0;

  let btnText, btnEnabled, btnBg;
  if (__volc_isRefreshing) {
    btnText = '停止刷新库存';
    btnEnabled = true;
    btnBg = '#475569,#64748b';
  } else if (!isLoggedIn) {
    btnText = '请先登录';
    btnEnabled = true;
    btnBg = '#dc2626,#ef4444';
  } else if (!hasSelection) {
    btnText = '请选择商品';
    btnEnabled = false;
    btnBg = '#94a3b8,#cbd5e1';
  } else {
    btnText = '开始刷新库存';
    btnEnabled = true;
    btnBg = '#dc2626,#ef4444';
  }

  html += '<button id="__volc_buy" style="' +
    'width:100%;padding:10px;border:0;border-radius:10px;' +
    'background:linear-gradient(135deg,' + btnBg + ');color:#fff;font-weight:800;font-size:12px;cursor:' + (btnEnabled ? 'pointer' : 'not-allowed') + ';opacity:' + (btnEnabled ? '1' : '0.6') + ';' +
    '" ' + (btnEnabled ? '' : 'disabled') + '>' +
    btnText +
    '</button>';

  const intervalSec = (__volc_refreshIntervalMs / 1000).toFixed(1);
  html += '<div class="__volc_interval-row">' +
    '<span>刷新间隔</span>' +
    '<input id="__volc_interval" type="range" min="' + __volc_MIN_REFRESH_MS + '" max="' + __volc_MAX_REFRESH_MS + '" step="100" value="' + __volc_refreshIntervalMs + '"' + (__volc_isRefreshing ? ' disabled' : '') + '>' +
    '<span id="__volc_interval_label" style="min-width:34px;text-align:right">' + intervalSec + 's</span>' +
    '</div>' +
    '<div class="__volc_interval-hints">' +
    '<span>' + (__volc_MIN_REFRESH_MS / 1000).toFixed(1) + 's</span>' +
    '<span>默认 ' + (__volc_DEFAULT_REFRESH_MS / 1000).toFixed(1) + 's</span>' +
    '<span>' + (__volc_MAX_REFRESH_MS / 1000).toFixed(1) + 's</span>' +
    '</div>';

  html += '<div id="__volc_status" style="margin-top:8px;font-size:10px;color:#64748b;min-height:14px"></div>';

  if (!__volc_isRefreshing && !isLoggedIn) {
    __volc_setStatus('请先登录后再刷新库存');
  }

  root.innerHTML = html;

  root.querySelectorAll('[data-pid]').forEach(function (el) {
    el.addEventListener('click', function () {
      if (__volc_isRefreshing) return;
      const pid = el.getAttribute('data-pid');
      if (__volc_selectedProductIds.has(pid)) {
        __volc_selectedProductIds.delete(pid);
      } else if (__volc_selectedProductIds.size < __volc_MAX_SELECTIONS) {
        __volc_selectedProductIds.add(pid);
      }
      __volc_render();
    });
  });

  root.querySelectorAll('[data-tab]').forEach(function (el) {
    el.addEventListener('click', function () {
      const tab = el.getAttribute('data-tab');
      if (tab && tab !== __volc_activeTab && __volc_catalogData.groups[tab]?.length) {
        __volc_activeTab = tab;
        __volc_render();
      }
    });
  });

  const btn = document.getElementById('__volc_buy');
  if (btn) {
    btn.addEventListener('click', function () {
      if (__volc_isRefreshing) {
        __volc_stopRefresh('已手动停止');
        return;
      }
      if (!__volc_vh_readLoginState().loggedIn) {
        __volc_setStatus('请先登录后再刷新库存');
        const siteBtn = document.querySelector('.volcfe-nav-login-btn');
        if (siteBtn) {
          siteBtn.click();
        } else {
          window.location.assign('https://www.volcengine.com/login');
        }
        return;
      }
      if (__volc_selectedProductIds.size > 0) {
        __volc_startRefresh();
      }
    });
  }

  const intervalInput = document.getElementById('__volc_interval');
  const intervalLabel = document.getElementById('__volc_interval_label');
  if (intervalInput && intervalLabel) {
    intervalInput.addEventListener('input', function () {
      let value = parseInt(intervalInput.value, 10);
      if (isNaN(value)) value = __volc_DEFAULT_REFRESH_MS;
      value = Math.max(__volc_MIN_REFRESH_MS, Math.min(__volc_MAX_REFRESH_MS, value));
      __volc_refreshIntervalMs = value;
      intervalLabel.textContent = (value / 1000).toFixed(1) + 's';
      if (__volc_isRefreshing && __volc_refreshTimer) {
        clearTimeout(__volc_refreshTimer);
        __volc_refreshTimer = setTimeout(__volc_tick, __volc_refreshIntervalMs);
      }
    });
  }
}

function __volc_setStatus(text) {
  const el = document.getElementById('__volc_status');
  if (el) el.textContent = text;
}

function __volc_statusWithCount(text) {
  return '第 ' + __volc_refreshCount + ' 次 · ' + text;
}

function __volc_startRefresh() {
  if (__volc_isRefreshing) return;
  if (__volc_selectedProductIds.size === 0) return;
  const authState = __volc_vh_readLoginState();
  if (!authState.loggedIn) {
    __volc_setStatus('请先登录后再刷新库存');
    return;
  }
  __volc_refreshQueue = Array.from(__volc_selectedProductIds);
  __volc_refreshCount = 0;
  __volc_isRefreshing = true;
  __volc_setStatus('开始刷新库存，已选 ' + __volc_refreshQueue.length + ' 个商品，每 ' + (__volc_refreshIntervalMs / 1000).toFixed(1) + ' 秒尝试一轮');
  __volc_render();
  __volc_tick();
}

function __volc_stopRefresh(reason) {
  if (!__volc_isRefreshing) return;
  __volc_isRefreshing = false;
  if (__volc_refreshTimer) {
    clearTimeout(__volc_refreshTimer);
    __volc_refreshTimer = null;
  }
  __volc_setStatus(reason || '已停止刷新');
  __volc_render();
}

async function __volc_tick() {
  if (!__volc_isRefreshing || __volc_refreshQueue.length === 0) return;

  if (!__volc_vh_readLoginState().loggedIn) {
    __volc_stopRefresh('登录状态已失效，已停止刷新');
    return;
  }

  __volc_refreshCount++;

  const all = [].concat(
    __volc_catalogData.groups.monthly,
    __volc_catalogData.groups.quarterly,
    __volc_catalogData.groups.yearly,
  );

  for (let i = 0; i < __volc_refreshQueue.length; i++) {
    if (!__volc_isRefreshing) return;
    const productId = __volc_refreshQueue[i];
    const product = all.find(function (p) { return p.id === productId; });
    __volc_setStatus(__volc_statusWithCount(__volc_formatProductTag(product) + '正在尝试下单…'));
    const success = await __volc_createOrder(productId);
    if (success) {
      __volc_stopRefresh('订单创建成功，停止刷新');
      return;
    }
  }

  if (!__volc_isRefreshing) return;
  __volc_refreshTimer = setTimeout(__volc_tick, __volc_refreshIntervalMs);
}

// Header auth pills (same pattern as the legacy overlay).
const __volc_VH = '__volc_v1';
const __volc_VH_CSS_ID = '__volc_v1_css';

function __volc_vh_buildCSS() {
  return [
    '<style id="' + __volc_VH_CSS_ID + '">',
    '@keyframes volcPulse{0%,100%{opacity:1}50%{opacity:.45}}',
    '#' + __volc_VH + '{display:flex;align-items:center;gap:8px;margin:0 8px 0 4px;padding:0;font-family:Inter,system-ui,sans-serif;color:#334155;flex-shrink:0}',
    '#' + __volc_VH + ' .bmh-pill{display:flex;align-items:center;gap:5px;padding:3px 9px 3px 7px;background:rgba(255,255,255,.6);border:1px solid rgba(148,163,184,.25);border-radius:20px;transition:all .15s}',
    '#' + __volc_VH + ' .bmh-pill.ok{border-color:rgba(16,185,129,.45);background:rgba(220,252,231,.55)}',
    '#' + __volc_VH + ' .bmh-pill.warn{border-color:rgba(245,158,11,.45);background:rgba(254,243,199,.55)}',
    '#' + __volc_VH + ' .bmh-pill.fail{border-color:rgba(220,38,38,.45);background:rgba(254,226,226,.55)}',
    '#' + __volc_VH + ' .bmh-pill-body{display:flex;flex-direction:column;gap:0;min-width:0}',
    '#' + __volc_VH + ' .bmh-pill-label{font-size:9px;font-weight:700;color:#475569;line-height:1.2;text-transform:uppercase;letter-spacing:.03em}',
    '#' + __volc_VH + ' .bmh-pill-status{font-size:9px;font-weight:700;line-height:1.2;white-space:nowrap}',
    '#' + __volc_VH + ' .bmh-pill.ok .bmh-pill-status{color:#15803d}',
    '#' + __volc_VH + ' .bmh-pill.warn .bmh-pill-status{color:#b45309}',
    '#' + __volc_VH + ' .bmh-pill.fail .bmh-pill-status{color:#b91c1c}',
    '#' + __volc_VH + ' .bmh-dot{width:7px;height:7px;border-radius:50%;background:#cbd5e1;flex-shrink:0}',
    '#' + __volc_VH + ' .bmh-dot.ok{background:#10b981;animation:volcPulse 1.4s ease-in-out infinite}',
    '#' + __volc_VH + ' .bmh-dot.warn{background:#f59e0b}',
    '#' + __volc_VH + ' .bmh-dot.fail{background:#dc2626}',
    '#' + __volc_VH + ' .bmh-login{display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#dc2626;text-decoration:none;padding:4px 10px;border:1px solid #fecaca;border-radius:20px;background:#fef2f2;white-space:nowrap;cursor:pointer;transition:all .15s}',
    '#' + __volc_VH + ' .bmh-login:hover{background:#fee2e2}',
    '</style>',
  ].join('');
}

function __volc_vh_buildHTML() {
  return [
    '<div class="bmh-pill" id="vh-ck" data-tip="checking cookies…">',
      '<div class="bmh-dot" id="vh-ck-dot"></div>',
      '<div class="bmh-pill-body">',
        '<div class="bmh-pill-label">Volc Cookie</div>',
        '<div class="bmh-pill-status" id="vh-ck-status">checking</div>',
      '</div>',
    '</div>',
    '<div class="bmh-pill" id="vh-ui" data-tip="checking user…">',
      '<div class="bmh-dot" id="vh-ui-dot"></div>',
      '<div class="bmh-pill-body">',
        '<div class="bmh-pill-label">Volc User</div>',
        '<div class="bmh-pill-status" id="vh-ui-status">checking</div>',
      '</div>',
    '</div>',
    '<a class="bmh-login" id="vh-login" data-tip="Click to open Volcengine login modal" style="display:none" href="javascript:void(0)">Login</a>',
  ].join('');
}

function __volc_vh_getCookieValue(name) {
  try {
    const m = document.cookie.match(new RegExp('(^|;)\\s*' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[2]) : '';
  } catch (e) { return ''; }
}

function __volc_vh_mask(s, n) {
  if (!s) return '(empty)';
  if (s.length <= n * 2) return s;
  return s.slice(0, n) + '…' + s.slice(-n);
}

function __volc_vh_setPill(idPrefix, ok, warn, label, okText, failText, tip) {
  const pill = document.getElementById(idPrefix);
  const dot = document.getElementById(idPrefix + '-dot');
  const status = document.getElementById(idPrefix + '-status');
  if (!pill || !dot || !status) return;
  const stateClass = ok ? 'ok' : (warn ? 'warn' : 'fail');
  pill.className = 'bmh-pill ' + stateClass;
  dot.className = 'bmh-dot ' + stateClass;
  status.textContent = ok ? okText : failText;
  status.title = label + ': ' + status.textContent;
  pill.setAttribute('data-tip', tip || (label + ': ' + status.textContent));
}

function __volc_vh_readLoginState() {
  const loginBtn = document.querySelector('.volcfe-nav-login-btn');
  const avatarWrap = document.querySelector('.volcfe-nav-pc-user-icon-wrap-avatar, .volcfe-nav-pc-user-icon-wrap');
  const loginBtnVisible = !!(loginBtn && loginBtn.offsetParent !== null);
  const avatarVisible = !!(avatarWrap && avatarWrap.offsetParent !== null);
  if (avatarVisible) return { loggedIn: true, source: 'avatar[visible]' };
  if (loginBtnVisible) return { loggedIn: false, source: 'login-btn[visible]' };
  return { loggedIn: false, source: 'indeterminate(no login node yet)' };
}

function __volc_vh_updateAuth() {
  let hasCsrf = false;
  let csrf = '';
  try {
    csrf = __volc_vh_getCookieValue('csrfToken');
    hasCsrf = !!csrf;
  } catch (e) {}

  const state = __volc_vh_readLoginState();
  const isLoggedIn = state.loggedIn;
  __volc_isLoggedIn = isLoggedIn;

  const ckTip = 'Volcengine CSRF cookie\n' +
    'csrfToken: ' + (hasCsrf ? __volc_vh_mask(csrf, 6) : '(missing)') + '\n' +
    'Note: this cookie is set for every visitor.\nStatus: ' + (hasCsrf ? 'site recognized this browser' : 'no csrfToken (unusual)');
  __volc_vh_setPill('vh-ck', hasCsrf, false, 'Volc Session', 'recognized', 'no csrfToken', ckTip);

  const uiTip = 'Login state (from page DOM)\nSource: ' + state.source + '\nStatus: ' + (isLoggedIn ? 'logged in' : 'not logged in') + '\n\n' +
    (isLoggedIn ? 'Top nav shows the user menu. You can place orders.' : 'Top nav shows 登录. Click Login or sign in at volcengine.com.');
  __volc_vh_setPill('vh-ui', isLoggedIn, false, 'Volc Identity', 'logged in', 'not logged in', uiTip);

  const loginEl = document.getElementById('vh-login');
  if (loginEl) loginEl.style.display = isLoggedIn ? 'none' : 'inline-flex';
}

function __volc_vh_setupLoginClick() {
  const btn = document.getElementById('vh-login');
  if (!btn) return;
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    const siteBtn = document.querySelector('.volcfe-nav-login-btn');
    if (siteBtn) {
      siteBtn.click();
      return;
    }
    const candidates = Array.from(document.querySelectorAll('a, button')).filter(function (el) {
      if (el.offsetParent === null) return false;
      const t = (el.innerText || '').trim();
      return t === '登录' || t === '登 录' || t === 'Login' || t === 'Sign in';
    });
    if (candidates[0]) {
      candidates[0].click();
    } else {
      window.location.assign('https://www.volcengine.com/login');
    }
  });
}

function __volc_vh_injectHeader() {
  if (document.getElementById(__volc_VH)) return;
  if (location.hostname.indexOf('volcengine.com') === -1) return;

  const middle = document.querySelector('.volcfe-nav-middle');
  const fallbackHost = document.querySelector('.volcfe-nav-content') ||
                       document.querySelector('header') ||
                       document.body;
  const host = middle || fallbackHost;
  let insertBeforeEl = null;
  if (middle) {
    const menuLinks = middle.querySelector('.volcfe-nav-pc, [class*="nav-pc" i]');
    const searchBar = middle.querySelector('.volcfe-search-bar-container, [class*="search-bar" i]');
    insertBeforeEl = searchBar || (menuLinks && menuLinks.nextSibling) || null;
  }

  if (!document.getElementById(__volc_VH_CSS_ID)) {
    const cssWrap = document.createElement('div');
    cssWrap.innerHTML = __volc_vh_buildCSS();
    const frag = document.createDocumentFragment();
    while (cssWrap.firstChild) frag.appendChild(cssWrap.firstChild);
    (document.head || document.documentElement).appendChild(frag);
  }

  const el = document.createElement('div');
  el.id = __volc_VH;
  el.innerHTML = __volc_vh_buildHTML();
  if (insertBeforeEl && insertBeforeEl.parentNode === host) {
    host.insertBefore(el, insertBeforeEl);
  } else {
    host.appendChild(el);
  }

  __volc_vh_setupLoginClick();
  __volc_vh_updateAuth();
  setInterval(__volc_vh_updateAuth, 3000);
}
