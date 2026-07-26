// Mechanical helpers used by the volcengine MAIN-world overlay (shared by Agent & Coding Plan).

function __volc_postCmd(type, data) {
  const envelope = { __volc_cmd: true, type: type };
  if (data && typeof data === 'object') {
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        envelope[key] = data[key];
      }
    }
  }
  window.postMessage(envelope, '*');
}

function __volc_getCookies() {
  return document.cookie.split(';').reduce(function (acc, c) {
    const parts = c.trim().split('=');
    acc[parts[0]] = parts.slice(1).join('=');
    return acc;
  }, {});
}

function __volc_extractQuoted(src, key) {
  // Anchor to word boundary so "templateIndexKey" does not match "IndexKey".
  const re = new RegExp('\\b' + key + ':"([^"]+)"');
  const m = src.match(re);
  return m ? m[1] : undefined;
}

function __volc_findObjectStart(src, pos) {
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = pos - 1; i >= 0; i--) {
    const c = src[i];
    if (inString) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"' || c === "'") inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; continue; }
    if (c === '}' || c === ']' || c === ')') depth++;
    else if (c === '{' || c === '[' || c === '(') {
      if (c === '{') {
        if (depth === 0) return i;
        depth--;
      } else {
        depth--;
      }
    }
  }
  return -1;
}

function __volc_findMatchingBrace(src, start) {
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"' || c === "'") inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function __volc_extractBalancedArray(src, pos) {
  const bracket = src.indexOf('[', pos);
  if (bracket < 0) return null;
  const end = __volc_findMatchingBrace(src, bracket);
  if (end < 0) return null;
  return src.slice(bracket, end + 1);
}

function __volc_parseBundle() {
  const factory = window[__volc_config.globalName];
  if (typeof factory !== 'function') return [];

  const src = factory.toString();
  const seen = {};
  const items = [];
  let idx = -1;

  while ((idx = src.indexOf('commonBuyOpenApi:', idx + 1)) !== -1) {
    const start = __volc_findObjectStart(src, idx);
    if (start < 0) continue;
    const end = __volc_findMatchingBrace(src, start);
    if (end < 0) continue;
    const objSrc = src.slice(start, end + 1);
    const indexKey = __volc_extractQuoted(objSrc, 'IndexKey');
    const arraySrc = __volc_extractBalancedArray(src, idx);
    if (!indexKey || !arraySrc) continue;

    try {
      const jsonLike = arraySrc.replace(/([{,])([a-zA-Z_][a-zA-Z0-9_]*):/g, '$1"$2":');
      const list = JSON.parse(jsonLike);
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.Product !== __volc_config.productCode) continue;
        const key = b.ConfigurationCode + '|' + (b.Duration || 1);
        const existing = seen[key];
        const isBetter = !existing || (
          (b.RenewType != null && b.PurchaseTimes != null) &&
          (existing.configBody.RenewType == null || existing.configBody.PurchaseTimes == null)
        );
        if (isBetter) {
          const candidates = existing ? existing.indexKeyCandidates.slice() : [];
          if (indexKey && candidates.indexOf(indexKey) === -1) {
            candidates.push(indexKey);
          }
          seen[key] = { indexKey: indexKey, configBody: b, indexKeyCandidates: candidates };
        } else if (existing && indexKey && existing.indexKeyCandidates.indexOf(indexKey) === -1) {
          existing.indexKeyCandidates.push(indexKey);
        }
      }
    } catch (e) {}
  }

  for (const key in seen) {
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      items.push(seen[key]);
    }
  }
  return items;
}

function __volc_billingLabel(duration) {
  if (duration === 1) return '连续包月';
  if (duration === 3) return '连续包季';
  if (duration === 12) return '连续包年';
  return duration + '个月';
}

function __volc_durationToBillingPeriod(duration, unit) {
  if (unit === 'monthly') {
    if (duration === 1) return 'monthly';
    if (duration === 3) return 'quarterly';
    if (duration === 12) return 'yearly';
  }
  if (duration >= 12) return 'yearly';
  if (duration >= 3) return 'quarterly';
  return 'monthly';
}

function __volc_playBeeps(count) {
  if (count <= 0) return;
  for (let i = 0; i < count; i++) {
    setTimeout(__volc_playBeep, i * 350);
  }
}

function __volc_playBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') {
      audioCtx.close();
      return;
    }
    const buf = audioCtx.createBuffer(1, 44100, 44100);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.sin(2 * Math.PI * 880 * i / 44100) * 0.25;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start();
    setTimeout(function () { src.stop(); audioCtx.close(); }, 200);
  } catch {}
}
