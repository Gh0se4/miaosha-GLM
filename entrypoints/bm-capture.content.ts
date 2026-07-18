// ISOLATED world content script for bigmodel.cn
// Injects MAIN world XHR interceptor and relays payment/ticket data to WXT storage
// Also implements R3: Tab Audio+Visual reminder when user is on bigmodel.cn
import { storage } from '#imports';
import type { AutoFirePlanShot } from '../lib/api/fire-plan';
import { createFirePreparationCancellation, runAfterFirePreparation, type FirePreparationCancellation } from '../lib/api/fire-preparation';
import { FireRunner } from '../lib/api/fire-runner';
import { buildFireSchedule } from '../lib/api/fire-scheduler';
import { reportPaymentStatus } from '../lib/api/payment-status-notifier';
import { buildStrikeQueue, type StrikeShot, type StrikeTarget } from '../lib/api/strike-plan';
import { calibrate } from '../lib/api/runtime-calibration';
import { fireStore, FIRE_CONFIG_DEFAULT, type FireConfig } from '../lib/settings/fire';
import { SALE_ALARM_MINUTES, SALE_TIME_DEFAULT, getNextSaleTime, saleTimeStore, type SaleTimeConfig } from '../lib/settings/sale-time';
import { captchaStore } from '../lib/settings/captcha';
import { bigmodelAdapter } from '../lib/platform';
import type { PlatformAuth } from '../lib/platform';
import { classifyPreviewError, classifyPreviewNetworkError, type ClassifiedShotResult } from '../lib/platform/adapters/bigmodel/order-pipeline';
import { createAuthStore } from '../lib/platform/shared/stores';
import { xhrRequest, setMainWorldFetcher, type MainWorldTransportTiming, type XhrRequestOptions, type XhrResponse } from '../lib/platform/adapters/bigmodel/request';

const RUNTIME_CALIBRATION_KEY = 'local:runtimeCalibration';
type StorageKey = `${'local' | 'session' | 'sync' | 'managed'}:${string}`;
const TICKET_TTL_MS = 5 * 60 * 1000; // alpha: 5 minutes per-ticket lifecycle

// ── Runtime namespace (set by bm-early.js at document_start) ──────────────
let _ns = '';
let MSG_CMD = '';
let MSG_EVT = '';
let MSG_OVL = '';

function discoverNamespace(): Promise<string> {
  return new Promise((resolve) => {
    // Primary: sessionStorage (set synchronously by bm-early.js at document_start)
    try {
      const ssNs = window.sessionStorage.getItem('_st');
      if (ssNs) {
        _ns = ssNs;
        MSG_CMD = _ns + 'c';
        MSG_EVT = _ns + 'e';
        MSG_OVL = _ns + 'o';
        resolve(_ns);
        return;
      }
    } catch(e) {}

    // Fallback: ask MAIN world via bootstrap protocol
    function handler(ev: MessageEvent) {
      if (ev.source !== window || !ev.data || ev.data.type !== 'NAMESPACE_DATA') return;
      window.removeEventListener('message', handler);
      _ns = ev.data.ns || '';
      MSG_CMD = ev.data.markers?.cmd || (_ns + 'c');
      MSG_EVT = ev.data.markers?.evt || (_ns + 'e');
      MSG_OVL = ev.data.markers?.ovl || (_ns + 'o');
      resolve(_ns);
    }
    window.addEventListener('message', handler);
    window.postMessage({ type: 'GET_NAMESPACE' }, '*');
    setTimeout(() => {
      window.removeEventListener('message', handler);
      try {
        const finalNs = window.sessionStorage.getItem('_st');
        if (finalNs) {
          _ns = finalNs;
          MSG_CMD = _ns + 'c';
          MSG_EVT = _ns + 'e';
          MSG_OVL = _ns + 'o';
          resolve(_ns);
          return;
        }
      } catch(e) {}
      _ns = 'b' + Math.random().toString(36).slice(2, 8);
      MSG_CMD = _ns + 'c';
      MSG_EVT = _ns + 'e';
      MSG_OVL = _ns + 'o';
      resolve(_ns);
    }, 1500);
  });
}
let TICKET_POOL_MAX = 100; // synced with captchaConfig.batchSessionLimit (single source of truth)
const REMINDER_PHASE_MINUTES_ASC = [...SALE_ALARM_MINUTES].sort((a, b) => a - b);

const CALIBRATION_FAST_WINDOW_MS = 10 * 60 * 1000;
const CALIBRATION_NORMAL_WINDOW_MS = 60 * 60 * 1000;
const CALIBRATION_FAST_INTERVAL_MS = 60 * 1000;
const CALIBRATION_NORMAL_INTERVAL_MS = 3 * 60 * 1000;
const CALIBRATION_IDLE_INTERVAL_MS = 10 * 60 * 1000;
const EARLY_FIRE_BOUNDARY_MS = 5 * 60 * 1000; // T-5 hard stop for sold-out watcher / early-fire
const BANNER_AUTO_DISMISS_MS = 3 * 60 * 1000; // R3 flash banner auto-dismiss after 3 min

let bannerDismissTimer: number | null = null;

interface RuntimeCalibrationSnapshot {
  rttCompensationMs: number;
  /** Compatibility with snapshots persisted before RTT compensation was renamed. */
  latencyMs?: number;
  clockOffsetMs: number;
  sampleCount: number;
  calibratedAt: number;
  reason: string;
}

const PHASE_BEEPS: Record<number, number> = {
  60: 1,
  30: 1,
  15: 1,
  10: 3,
   5: 4,
};

// ── In-memory ticket pool, backed by page sessionStorage ──
let _ticketPool: any[] = [];
let _ticketStoreReadyPromise: Promise<void> | null = null;

function ensureTicketStoreReady(): Promise<void> {
  if (_ticketStoreReadyPromise) return _ticketStoreReadyPromise;
  _ticketStoreReadyPromise = (async () => {
    try {
      const stored: any[] = await readPageTicketStore();
      const now = Date.now();
      _ticketPool = stored
        .filter((t: any) => now - t.createdAt < TICKET_TTL_MS)
        .sort((a: any, b: any) => a.createdAt - b.createdAt);
      if (_ticketPool.length > TICKET_POOL_MAX) {
        _ticketPool.splice(0, _ticketPool.length - TICKET_POOL_MAX);
      }
      writePageTicketStore();
    } catch {
      _ticketPool = [];
    }
  })();
  return _ticketStoreReadyPromise;
}

function readPageTicketStore(): Promise<any[]> {
  return new Promise((resolve) => {
    const reqId = Math.random().toString(36).slice(2);
    function handler(ev: MessageEvent) {
      if (ev.source !== window || !ev.data?.[MSG_EVT] || ev.data.type !== 'TICKET_STORE_DATA' || ev.data.reqId !== reqId) return;
      window.removeEventListener('message', handler);
      resolve(ev.data.list || []);
    }
    window.addEventListener('message', handler);
    window.postMessage({ [MSG_CMD]: true, type: 'READ_TICKET_STORE', reqId }, '*');
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve([]);
    }, 800);
  });
}

function writePageTicketStore() {
  window.postMessage({ [MSG_CMD]: true, type: 'WRITE_TICKET_STORE', list: _ticketPool }, '*');
}

function clearPageTicketStore() {
  _ticketPool = [];
  window.postMessage({ [MSG_CMD]: true, type: 'CLEAR_TICKET_STORE' }, '*');
}

function isExtensionContextValid(): boolean {
  try {
    return !!(
      (chrome?.runtime?.id && chrome?.storage?.local) ||
      ((globalThis as any)?.browser?.runtime?.id && (globalThis as any)?.browser?.storage?.local)
    );
  } catch {
    return false;
  }
}

// ── Safe storage wrapper (module-scope so reminder helpers can use it) ────────
async function safeGet<T>(key: StorageKey): Promise<T | null> {
  if (!isExtensionContextValid()) return null;
  try { return await storage.getItem<T>(key); } catch { return null; }
}
async function safeSet(key: StorageKey, value: unknown): Promise<void> {
  if (!isExtensionContextValid()) return;
  try { await storage.setItem(key, value); } catch {}
}

// ── Platform adapter shared seams ────────────────────────────────────────────
const authStore = createAuthStore(true);

function normalizeAuthHeaders(auth: PlatformAuth | null): any {
  if (!auth) return null;
  const authorization = auth.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  return {
    authorization,
    bigmodelOrganization: auth.headers['bigmodel-organization'],
    bigmodelProject: auth.headers['bigmodel-project'],
    capturedAt: auth.capturedAt,
    source: (auth.metadata?.source as string) || 'cache',
  };
}

function coerceToPlatformAuth(auth: any): PlatformAuth | null {
  if (!auth) return null;
  if (auth.platform === 'bigmodel' && auth.headers?.authorization) {
    return auth as PlatformAuth;
  }
  if (auth.authorization && auth.bigmodelOrganization && auth.bigmodelProject) {
    return {
      platform: 'bigmodel',
      capturedAt: auth.capturedAt || Date.now(),
      headers: {
        authorization: String(auth.authorization).replace(/^Bearer\s+/i, ''),
        'bigmodel-organization': auth.bigmodelOrganization,
        'bigmodel-project': auth.bigmodelProject,
      },
      metadata: { source: auth.source || 'cache' },
    };
  }
  return null;
}

async function getFreshAuth(): Promise<PlatformAuth | null> {
  const captured = await bigmodelAdapter.authProbe.capture();
  if (captured && (await bigmodelAdapter.authProbe.isAuthenticated(captured))) {
    await authStore.set(captured);
    return captured;
  }
  const cached = authStore.get();
  if (cached && (await bigmodelAdapter.authProbe.isAuthenticated(cached))) {
    return cached;
  }
  return null;
}

// ── R3: Flash Sale Reminder ──────────────────────────────────────────────────

interface ReminderState {
  reminded: Record<string, boolean>;
  saleEpoch?: number;
}

async function getSaleConfig(): Promise<SaleTimeConfig> {
  try {
    if (!isExtensionContextValid()) return { ...SALE_TIME_DEFAULT };
    return await saleTimeStore.get();
  } catch {
    return { ...SALE_TIME_DEFAULT };
  }
}

async function syncCaptchaConfig(pushToOverlay = false) {
  if (!isExtensionContextValid()) return;
  try {
    const cfg = await captchaStore.get();
    const limit = Number(cfg.batchSessionLimit);
    if (limit > 0 && isFinite(limit)) {
      TICKET_POOL_MAX = Math.max(1, Math.round(limit));
      if (pushToOverlay) {
        postToOverlay({ type: 'CAPTCHA_CONFIG', data: { batchSessionLimit: TICKET_POOL_MAX } });
      }
    }
  } catch {
    // Extension context may have been invalidated; ignore.
  }
}

function getSalePhase(config: SaleTimeConfig): number | null {
  const now = Date.now();
  const sale = getNextSaleTime(config);
  const remaining = sale - now;
  if (remaining <= 0) return null;
  for (const minutesBefore of REMINDER_PHASE_MINUTES_ASC) {
    if (remaining <= minutesBefore * 60 * 1000) return minutesBefore;
  }
  return null;
}

function removeBanner() {
  const existing = document.getElementById(_ns + 'fo');
  if (existing) existing.remove();
  if (bannerDismissTimer) {
    clearTimeout(bannerDismissTimer);
    bannerDismissTimer = null;
  }
}

function createOverlay(min: number) {
  removeBanner();

  const reminderText = min <= 5
    ? `🔥 距抢购还有 ${min} 分钟！请立刻录入验证码，越多越好`
    : `🔥 距抢购还有 ${min} 分钟`;
  const actionText = min <= 5 ? '去录入验证码' : '立即准备';

  const overlay = document.createElement('div');
  overlay.id = _ns + 'fo';
  overlay.innerHTML = `
    <div style="
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      background: linear-gradient(135deg, #dc2626, #ef4444);
      color: #fff; padding: 12px 20px; font-size: 15px;
      font-weight: 800; text-align: center;
      display: flex; align-items: center; justify-content: center; gap: 12px;
      box-shadow: 0 4px 20px rgba(220,38,38,0.4);
      animation: ' + _ns + 'ap 1s ease-in-out infinite alternate;
      cursor: pointer; font-family: system-ui, -apple-system, sans-serif;
    ">
      <span>${reminderText}</span>
      <button id=_ns + 'ob' style="
        background: #fff; color: #dc2626; border: none;
        padding: 5px 14px; border-radius: 20px; font-weight: 700;
        cursor: pointer; font-size: 13px;
      ">${actionText}</button>
    </div>
    <style>
      @keyframes ' + _ns + 'ap {
        from { opacity: 0.85; transform: scale(1); }
        to { opacity: 1; transform: scale(1.01); }
      }
    </style>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === _ns + 'ob') return;
    removeBanner();
  });
  document.getElementById(_ns + 'ob')?.addEventListener('click', () => {
    removeBanner();
  });

  bannerDismissTimer = window.setTimeout(removeBanner, BANNER_AUTO_DISMISS_MS);
}

function playBeeps(count: number) {
  if (count <= 0) return;
  for (let i = 0; i < count; i++) {
    setTimeout(() => playBeep(), i * 350);
  }
}

function playBeep() {
  try {
    const audioCtx = new AudioContext();
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
    setTimeout(() => { src.stop(); audioCtx.close(); }, 200);
  } catch {}
}

function createReminderState(saleEpoch: number): ReminderState {
  return {
    reminded: Object.fromEntries(SALE_ALARM_MINUTES.map((minutesBefore) => [String(minutesBefore), false])),
    saleEpoch,
  };
}

async function loadReminderState(saleEpoch: number): Promise<ReminderState> {
  const defaultState = createReminderState(saleEpoch);
  const stored = await safeGet<ReminderState>('local:reminderState');
  if (!stored || stored.saleEpoch !== saleEpoch) return defaultState;
  return {
    ...defaultState,
    ...stored,
    reminded: {
      ...defaultState.reminded,
      ...(stored.reminded ?? {}),
    },
  };
}

async function saveReminderState(state: ReminderState) {
  await safeSet('local:reminderState', state);
}

async function checkAndRemind() {
  const config = await getSaleConfig();
  const saleEpoch = getNextSaleTime(config);
  const phase = getSalePhase(config);
  if (!phase) return;

  const state = await loadReminderState(saleEpoch);
  const key = String(phase);
  if (state.reminded[key]) return;

  createOverlay(phase);
  if (config.soundEnabled) {
    playBeeps(PHASE_BEEPS[phase] ?? 1);
  }

  state.reminded[key] = true;
  await saveReminderState(state);
}

async function initReminderLoop() {
  setInterval(checkAndRemind, 60_000);
  await checkAndRemind();
}
// ── End R3 ─────────────────────────────────────────────────────────────────

// ── Force-Stop Banner (shown during batch captcha mode) ────────────────────

function createForceStopBanner(options?: {
  getTicketCount?: () => Promise<number>;
  onFire?: () => void;
  onBurst?: () => void;
}) {
  removeForceStopBanner();
  const el = document.createElement('div');
  el.id = _ns + 'fb';
  el.innerHTML = `
    <div style="
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      background: linear-gradient(135deg, #dc2626, #ef4444);
      color: #fff; padding: 10px 20px; font-size: 14px;
      font-weight: 800; text-align: center;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      box-shadow: 0 4px 20px rgba(220,38,38,0.4);
      animation: ' + _ns + 'ap 1s ease-in-out infinite alternate;
      font-family: system-ui, -apple-system, sans-serif;
    ">
      <span style="
        font-size: 10px; font-weight: 800; color: #fff;
        background: rgba(0,0,0,0.35); padding: 2px 8px;
        border-radius: 999px; line-height: 1;
        border: 1px solid rgba(255,255,255,0.4);
      ">v${chrome.runtime.getManifest().version}</span>
      <span id=_ns + 'bw' style="
        font-size: 12px; font-weight: 800; color: #fff; background: #6366f1;
        padding: 3px 10px; border-radius: 999px; line-height: 1;
      ">Wave 1</span>
      <span>&#9632; Batch Mode Active — solving captchas</span>
      <button id=_ns + 'bf' style="
        display: inline-flex; align-items: center; gap: 5px;
        padding: 5px 12px; border: 2px solid #3f6212;
        background: #a3e635; color: #14532d; border-radius: 6px;
        font-size: 13px; font-weight: 900; cursor: pointer; line-height: 1;
        box-shadow: 0 0 0 2px rgba(163,230,53,.45), 0 4px 10px rgba(0,0,0,.2);
        animation: fvBtnPulse 1.2s ease-in-out infinite alternate;
      " disabled title="串行模式：按 Strike Interval 顺序发射，遇到 555 自动退避，节奏稳。">
        &#9889; Fire 串行 (<span id=_ns + 'bc'>0</span>)
      </button>
      <button id=_ns + 'bb' style="
        display: inline-flex; align-items: center; gap: 5px;
        padding: 5px 12px; border: 2px solid #92400e;
        background: #f59e0b; color: #78350f; border-radius: 6px;
        font-size: 13px; font-weight: 900; cursor: pointer; line-height: 1;
        box-shadow: 0 0 0 2px rgba(245,158,11,.45), 0 4px 10px rgba(0,0,0,.2);
        animation: fvBtnPulseAmber 1.2s ease-in-out infinite alternate;
      " disabled title="并发模式：固定 200ms 间隔快速齐射，忽略 555 退避，火力密度高。">
        &#9889; BURST 并发 (<span id=_ns + 'bk'>0</span>) · 200ms
      </button>
      <kbd style="
        padding: 2px 8px; background: rgba(255,255,255,0.25);
        border: 1px solid rgba(255,255,255,0.5); border-radius: 4px;
        font-size: 12px; font-weight: 700; font-family: monospace;
      ">Esc</kbd>
      <span>to force stop</span>
    </div>
    <style>
      @keyframes ' + _ns + 'ap {
        from { opacity: 0.85; transform: scale(1); }
        to { opacity: 1; transform: scale(1.01); }
      }
      @keyframes fvBtnPulse {
        from { box-shadow: 0 0 0 2px rgba(163,230,53,.45), 0 4px 10px rgba(0,0,0,.2); }
        to { box-shadow: 0 0 0 6px rgba(163,230,53,.65), 0 6px 14px rgba(0,0,0,.25); }
      }
      @keyframes fvBtnPulseAmber {
        from { box-shadow: 0 0 0 2px rgba(245,158,11,.45), 0 4px 10px rgba(0,0,0,.2); }
        to { box-shadow: 0 0 0 6px rgba(245,158,11,.65), 0 6px 14px rgba(0,0,0,.25); }
      }
    </style>
  `;
  document.body.appendChild(el);

  bannerWaveCount = 0;
  updateBannerWaveBadge();

  const fireBtn = document.getElementById(_ns + 'bf') as HTMLButtonElement | null;
  const fireCountEl = document.getElementById(_ns + 'bc');
  const burstBtn = document.getElementById(_ns + 'bb') as HTMLButtonElement | null;
  const burstCountEl = document.getElementById(_ns + 'bk');

  if (options?.onFire && fireBtn) {
    fireBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      options.onFire!();
    });
  }

  if (options?.onBurst && burstBtn) {
    burstBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      options.onBurst!();
    });
  }

  const getTicketCount = options?.getTicketCount;
  if (getTicketCount && fireCountEl && burstCountEl && fireBtn && burstBtn) {
    const ticketUi = { getTicketCount, fireCountEl, burstCountEl, fireBtn, burstBtn };
    async function updateCount() {
      try {
        const count = await ticketUi.getTicketCount();
        ticketUi.fireCountEl.textContent = String(count);
        ticketUi.burstCountEl.textContent = String(count);
        const disabled = count === 0;
        ticketUi.fireBtn.disabled = disabled;
        ticketUi.burstBtn.disabled = disabled;
        [ticketUi.fireBtn, ticketUi.burstBtn].forEach((btn) => {
          btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
          btn.style.opacity = disabled ? '0.55' : '1';
          btn.style.animation = disabled ? 'none' : '';
        });
      } catch {
        ticketUi.fireCountEl.textContent = '0';
        ticketUi.burstCountEl.textContent = '0';
        ticketUi.fireBtn.disabled = true;
        ticketUi.burstBtn.disabled = true;
        [ticketUi.fireBtn, ticketUi.burstBtn].forEach((btn) => {
          btn.style.cursor = 'not-allowed';
          btn.style.opacity = '0.55';
          btn.style.animation = 'none';
        });
      }
    }
    updateCount();
    const timer = window.setInterval(updateCount, 1000);
    el.dataset.countTimer = String(timer);
  }
}

function removeForceStopBanner() {
  const el = document.getElementById(_ns + 'fb');
  if (el) {
    const timer = Number(el.dataset.countTimer);
    if (timer) clearInterval(timer);
    el.remove();
  }
}

let bannerWaveCount = 0;

function updateBannerWaveBadge() {
  const badge = document.getElementById(_ns + 'bw');
  if (badge) badge.textContent = 'Wave ' + bannerWaveCount;
}

function postToOverlay(msg: any) {
  window.postMessage({ [MSG_OVL]: true, ...msg }, '*');
}

function tokenSuffix(authz: string | undefined): string {
  if (!authz || typeof authz !== 'string') return '';
  const raw = authz.replace(/^Bearer\s+/i, '');
  return raw.slice(-6);
}

function maskTicket(ticket: string): string {
  if (!ticket || typeof ticket !== 'string') return '';
  if (ticket.length <= 8) return ticket;
  return 'tk_…' + ticket.slice(-4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Extract raw response body from order pipeline result for diagnostics
function getRawBody(result: any): string {
  try {
    const meta = result.metadata || {};
    if (meta.rawBodyText) return meta.rawBodyText.substring(0, 500);
    const raw = meta.raw;
    if (!raw) return '';
    return (typeof raw === 'string' ? raw : JSON.stringify(raw)).substring(0, 500);
  } catch { return ''; }
}

// ── MAIN world fetch relay ───────────────────────────────────────────────
// Routes API requests through the page's native fetch (MAIN world) to avoid
// Alibaba WAF detection of extension-origin requests.
function mainWorldFetch(opts: XhrRequestOptions): Promise<{
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
  timing: MainWorldTransportTiming;
  requestId?: string;
  runId?: string;
  shotId?: string;
}> {
  return new Promise((resolve, reject) => {
    const requestId = opts.requestId || Math.random().toString(36).slice(2);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      if (timeout !== undefined) clearTimeout(timeout);
      fn();
    };
    const abort = (reason: 'aborted' | 'timeout' = 'aborted') => {
      if (settled) return;
      window.postMessage({ [MSG_CMD]: true, type: 'DO_FETCH_CANCEL', requestId }, '*');
      const error = new Error(reason === 'timeout' ? 'MAIN world fetch timeout' : 'MAIN world fetch aborted');
      error.name = reason === 'timeout' ? 'TimeoutError' : 'AbortError';
      finish(() => reject(error));
    };
    opts.onAbortReady?.(abort);
    function handler(ev: MessageEvent) {
      const incomingRequestId = ev.data?.requestId ?? ev.data?.reqId;
      if (ev.source !== window || !ev.data?.[MSG_EVT] || incomingRequestId !== requestId) return;
      if (ev.data.type === 'DO_FETCH_STARTED') {
        opts.onFetchStarted?.({ timing: ev.data.timing, requestId });
        return;
      }
      if (ev.data.type !== 'DO_FETCH_RESULT') return;
      if (ev.data.ok) {
        finish(() => resolve({
          status: ev.data.status,
          statusText: ev.data.statusText,
          body: ev.data.body,
          headers: ev.data.headers || {},
          timing: ev.data.timing,
          requestId: incomingRequestId,
          runId: ev.data.runId,
          shotId: ev.data.shotId,
        }));
      } else {
        finish(() => reject(new Error(ev.data.error || 'fetch error')));
      }
    }
    window.addEventListener('message', handler);
    window.postMessage({ [MSG_CMD]: true, type: 'DO_FETCH', requestId, runId: opts.runId, shotId: opts.shotId, opts }, '*');
    timeout = setTimeout(() => {
      if (settled) return;
      abort('timeout');
    }, 8000);
  });
}

export default defineContentScript({
  matches: ['*://bigmodel.cn/*', '*://*.bigmodel.cn/*'],
  runAt: 'document_idle',

  async main() {
    // Inject MAIN world script FIRST so it can handle GET_NAMESPACE fallback
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('/bm-main.js');
    const manifest = chrome.runtime && typeof chrome.runtime.getManifest === 'function'
      ? chrome.runtime.getManifest()
      : null;
    if (script.dataset) script.dataset.version = manifest && manifest.version ? manifest.version : '';
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);

    // Now discover runtime namespace (set by bm-early.js at document_start).
    // Primary source: sessionStorage (ISOLATED world can access it).
    // Fallback: GET_NAMESPACE via postMessage (bm-main.js handles it).
    await discoverNamespace();

    // Route ALL API requests through the page's MAIN world fetch to avoid
    // Alibaba WAF detection of extension-origin requests.
    setMainWorldFetcher(async (fetchOpts: XhrRequestOptions): Promise<XhrResponse> => {
      const result = await mainWorldFetch(fetchOpts);
      let data: any;
      try { data = JSON.parse(result.body); } catch { data = result.body; }
      return {
        status: result.status,
        statusText: result.statusText,
        data,
        headers: result.headers,
        timing: result.timing,
        requestId: result.requestId,
        runId: result.runId,
        shotId: result.shotId,
        body: result.body,
      };
    });

    async function getPrefireAuthStatus() {
      const auth = await getFreshAuth();
      if (!auth || !(await bigmodelAdapter.authProbe.isAuthenticated(auth))) {
        return {
          ok: false,
          reason: 'missing-auth',
        };
      }

      const legacy = normalizeAuthHeaders(auth);
      const capturedAt = typeof auth.capturedAt === 'number' ? auth.capturedAt : Date.now();
      return {
        ok: true,
        headers: legacy,
        source: legacy.source === 'live-page' ? 'live-page' : 'storage-fallback',
        capturedAt,
        ageMs: Math.max(0, Date.now() - capturedAt),
        org: legacy.bigmodelOrganization,
        project: legacy.bigmodelProject,
        tokenSuffix: tokenSuffix(legacy.authorization),
      };
    }

    // ── Runtime Calibration (1.0.0.alpha) ────────────────────────────────────
    let calibrationInFlight = false;
    let calibrationTimer: ReturnType<typeof setTimeout> | null = null;
    let quietWindowSaleTime: number | null = null;

    function selectCalibrationInterval(msUntilSale: number): number {
      if (msUntilSale <= CALIBRATION_FAST_WINDOW_MS) return CALIBRATION_FAST_INTERVAL_MS;
      if (msUntilSale <= CALIBRATION_NORMAL_WINDOW_MS) return CALIBRATION_NORMAL_INTERVAL_MS;
      return CALIBRATION_IDLE_INTERVAL_MS;
    }

    async function pushRuntimeCalibrationToOverlay() {
      const cached = await safeGet<RuntimeCalibrationSnapshot>(RUNTIME_CALIBRATION_KEY);
      if (!cached) return false;
      const rttCompensationMs = Number.isFinite(cached.rttCompensationMs)
        ? cached.rttCompensationMs
        : cached.latencyMs;
      if (!Number.isFinite(rttCompensationMs) || !Number.isFinite(cached.clockOffsetMs)) return false;
      postToOverlay({ type: 'RUNTIME_CALIBRATION', data: { ...cached, rttCompensationMs, latencyMs: rttCompensationMs } });
      return true;
    }

    async function getNextRuntimeCalibrationSaleTime() {
      const cfg = await getSaleConfig();
      return getNextSaleTime(cfg);
    }

    async function shouldContinueRuntimeCalibration() {
      const nextSaleTime = await getNextRuntimeCalibrationSaleTime();
      const shouldContinue = nextSaleTime - Date.now() > EARLY_FIRE_BOUNDARY_MS;
      if (shouldContinue) quietWindowSaleTime = null;
      return shouldContinue;
    }

    async function recordQuietWindowEntry(reason: string) {
      const nextSaleTime = await getNextRuntimeCalibrationSaleTime();
      if (quietWindowSaleTime === nextSaleTime) return;
      quietWindowSaleTime = nextSaleTime;
      postToOverlay({ type: 'calibration_quiet_window_entered', data: { reason, nextSaleTime } });
    }

    async function runRuntimeCalibration(reason: string) {
      if (calibrationInFlight) return false;
      if (!(await shouldContinueRuntimeCalibration())) {
        await recordQuietWindowEntry(reason);
        return false;
      }
      calibrationInFlight = true;
      try {
        const auth = await getFreshAuth();
        if (!auth || !(await bigmodelAdapter.authProbe.isAuthenticated(auth))) return false;

        const legacy = normalizeAuthHeaders(auth);
        const result = await calibrate({
          authorization: legacy.authorization,
          bigmodelOrganization: legacy.bigmodelOrganization,
          bigmodelProject: legacy.bigmodelProject,
        }, undefined, {
          shouldContinue: shouldContinueRuntimeCalibration,
          onEvent: (event) => {
            if (event.type === 'calibration_quiet_window_entered') {
              void recordQuietWindowEntry(reason).catch((error) => {
                console.warn('Failed to record calibration quiet-window entry', error);
              });
              return;
            }
            postToOverlay({ type: event.type, data: { reason, ...(event.details || {}) } });
          },
        });

        if (!Number.isFinite(result.rttCompensationMs) || !Number.isFinite(result.clockOffsetMs) || result.probes.length === 0) {
          return false;
        }

        const snapshot: RuntimeCalibrationSnapshot = {
          rttCompensationMs: Math.max(0, Math.round(result.rttCompensationMs)),
          clockOffsetMs: Math.round(result.clockOffsetMs),
          sampleCount: result.probes.length,
          calibratedAt: Date.now(),
          reason,
        };

        await safeSet(RUNTIME_CALIBRATION_KEY, snapshot);
        postToOverlay({ type: 'RUNTIME_CALIBRATION', data: { ...snapshot, latencyMs: snapshot.rttCompensationMs } });
        return true;
      } catch {
        return false;
      } finally {
        calibrationInFlight = false;
      }
    }

    async function scheduleNextRuntimeCalibration() {
      if (calibrationTimer) {
        clearTimeout(calibrationTimer);
        calibrationTimer = null;
      }

      try {
        const cfg = await getSaleConfig();
        const msUntilSale = Math.max(0, getNextSaleTime(cfg) - Date.now());
        const nextDelay = selectCalibrationInterval(msUntilSale);
        calibrationTimer = setTimeout(async () => {
          await runRuntimeCalibration('periodic');
          await scheduleNextRuntimeCalibration();
        }, nextDelay);
      } catch {
        calibrationTimer = setTimeout(async () => {
          await runRuntimeCalibration('periodic-fallback');
          await scheduleNextRuntimeCalibration();
        }, CALIBRATION_NORMAL_INTERVAL_MS);
      }
    }

    async function startRuntimeCalibrationLoop() {
      await pushRuntimeCalibrationToOverlay();
      await runRuntimeCalibration('init');
      await scheduleNextRuntimeCalibration();
    }

    // NOTE: batch-preview is intentionally fetched only from the MAIN world
    // using the page's original uninstrumented fetch. The content script no
    // longer requests this endpoint because Alibaba WAF blocks any request
    // originating from the extension's isolated world.

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'local' && changes['local:captchaConfig']) {
        syncCaptchaConfig(true);
      }
    });

    // ── Helper: get current valid ticket count / list ──
    async function getTicketInfo() {
      await ensureTicketStoreReady();
      const now = Date.now();
      _ticketPool = _ticketPool.filter((t: any) => now - t.createdAt < TICKET_TTL_MS);
      const tickets = _ticketPool.map((t: any) => {
        const remainingMs = Math.max(0, TICKET_TTL_MS - (now - t.createdAt));
        return {
          ticket: t.ticket,
          randstr: t.randstr,
          createdAt: t.createdAt,
          remainingMs,
          expired: false,
        };
      });
      return { count: tickets.length, tickets };
    }

    async function getLaunchSnapshot(cancellation?: FirePreparationCancellation) {
      await ensureTicketStoreReady();
      if (cancellation?.cancelled) return null;
      const now = Date.now();
      const valid = _ticketPool.filter((t: any) => now - t.createdAt < TICKET_TTL_MS);
      const selData = await safeGet<any>('local:selectedProducts');
      if (cancellation?.cancelled) return null;
      const targets: StrikeTarget[] = (selData?.priorityList || [])
        .filter((item: any) => item && item.productId)
        .slice(0, 3)
        .map((item: any, idx: number) => ({ productId: String(item.productId), priority: idx + 1 }));
      let fireConfig: FireConfig;
      try {
        fireConfig = isExtensionContextValid() ? await fireStore.get() : { ...FIRE_CONFIG_DEFAULT };
      } catch {
        fireConfig = { ...FIRE_CONFIG_DEFAULT };
      }
      if (cancellation?.cancelled) return null;
      return { valid, targets, fireConfig };
    }

    // ── Poll payment status ──
    async function pollPayCheck(
      authArg: any,
      bizId: string,
      onUpdate: (status: 'SUCCESS' | 'EXPIRE' | 'timeout') => void,
    ) {
      const legacy = normalizeAuthHeaders(coerceToPlatformAuth(authArg));
      if (!legacy) return;
      const MAX_MS = 5 * 60 * 1000;
      const INTERVAL_MS = 1500;
      const start = Date.now();
      while (Date.now() - start < MAX_MS) {
        try {
          const res = await xhrRequest<{ code?: number; data?: { status?: string | boolean } | string }>({
            method: 'GET',
            url: `https://bigmodel.cn/api/biz/pay/check?bizId=${encodeURIComponent(bizId)}`,
            withCredentials: true,
            headers: {
              Accept: 'application/json, text/plain, */*',
              Authorization: legacy.authorization,
              'Bigmodel-Organization': legacy.bigmodelOrganization,
              'Bigmodel-Project': legacy.bigmodelProject,
            },
          });
          const data = res.data;
          const payload = data?.data;
          const status = typeof payload === 'string' ? payload : payload?.status;
          if (status === 'SUCCESS' || status === 'success' || status === true || data?.code === 200) {
            onUpdate('SUCCESS');
            return;
          }
          if (status === 'EXPIRE' || status === 'expire' || status === 'FAILED' || status === 'failed') {
            onUpdate('EXPIRE');
            return;
          }
        } catch {}
        await sleep(INTERVAL_MS);
      }
      onUpdate('timeout');
    }

    async function updatePaymentState(patch: any) {
      const current = await safeGet<any>('local:paymentState');
      const next = { ...(current || {}), ...patch, updatedAt: Date.now() };
      await safeSet('local:paymentState', next);
      postToOverlay({ type: 'PAYMENT_STATE', data: next });
    }

    // ── Alpha Auto-Fire execution ────────────────────────────────────────────
    async function runAutoFirePlan(
      fireStartMs: number,
      authArg: any,
      preparationCancellation?: FirePreparationCancellation,
      runId?: string,
      autoTiming?: AutoTimingMetadata,
    ) {
      // Auto mode uses the same explicit runner lifecycle as manual mode.
      if (preparationCancellation?.cancelled) return;
      await prepareAndRun({
        runId: runId || `auto-${fireStartMs}-${Date.now()}`,
        mode: 'auto',
        startMs: fireStartMs,
        authArg,
        preparationCancellation,
        autoTiming,
      });
    }

    // ── Unified strike sequence: shared by default strike and burst mode ──
    let currentStrikeCancel: (() => void) | null = null;
    let currentFireRunner: FireRunner | null = null;
    let currentFirePreparationCancellation: FirePreparationCancellation | null = null;
    let preparingFireRun = false;
    let lastShotSentAt = 0;

    interface StrikeSequenceOptions {
      label: string;
      mode: 'manual' | 'burst' | 'auto';
      runId?: string;
      burstIntervalMs?: number;
      enableBusyBackoff: boolean;
      pollPayment: boolean;
      preparationCancellation?: FirePreparationCancellation;
      autoTiming?: AutoTimingMetadata;
    }

    interface AutoTimingMetadata {
      targetMs: number;
      preparationLeadMs: number;
      rttCompensationMs: number;
      clockOffsetMs: number;
      earlyOffsetMs: number;
    }

    async function runStrikeSequence(startMs: number, authArg: any, options: StrikeSequenceOptions) {
      if (preparingFireRun || currentFireRunner) {
        postToOverlay({ type: 'FIRE_LOG_V2_EVENT', data: { type: 'run_rejected', runId: options.runId, reason: 'run_locked' } });
        postToOverlay({ type: 'FIRE_RESULT', line: '> Strike already in progress — wait for completion or cooldown' });
        return;
      }
      const preparationStartedAt = Date.now();
      preparingFireRun = true;
      const preparationCancellation = options.preparationCancellation ?? createFirePreparationCancellation();
      const runId = options.runId || `${options.mode}-${Date.now()}`;
      currentFirePreparationCancellation = preparationCancellation;
      const finishPreparationCancellation = () => {
        if (currentFirePreparationCancellation === preparationCancellation) {
          currentFirePreparationCancellation = null;
        }
      };
      const reportPreparationCancelled = () => {
        finishPreparationCancellation();
        postToOverlay({ type: 'FIRE_RESULT', line: '> Cancelled — preparation stopped' });
      };
      try {
      if (preparationCancellation.cancelled) {
        reportPreparationCancelled();
        return;
      }
      postToOverlay({ type: 'FIRE_LOG_V2_EVENT', data: {
        type: 'run_prepare_started', runId, wallClockMs: preparationStartedAt,
        monotonicMs: typeof performance !== 'undefined' && performance.now ? performance.now() : 0,
        details: { mode: options.mode, startMs, ...(options.mode === 'auto' && options.autoTiming ? options.autoTiming : {}) },
      } });
      const auth = coerceToPlatformAuth(authArg);
      if (preparationCancellation.cancelled) {
        reportPreparationCancelled();
        return;
      }
      if (!auth) {
        postToOverlay({ type: 'FIRE_RESULT', line: '> No auth headers' });
        return;
      }

      const preparedLaunch = {
        snapshot: null as Awaited<ReturnType<typeof getLaunchSnapshot>> | null,
      };
      const preparationResult = await runAfterFirePreparation({
        cancellation: preparationCancellation,
        preflight: () => getLaunchSnapshot(preparationCancellation),
        onReady: (snapshot) => { preparedLaunch.snapshot = snapshot; },
      });
      const launchSnapshot = preparedLaunch.snapshot;
      if (preparationResult === 'cancelled' || !launchSnapshot || preparationCancellation.cancelled) {
        reportPreparationCancelled();
        return;
      }
      const { valid, targets, fireConfig } = launchSnapshot;
      if (valid.length === 0) {
        postToOverlay({ type: 'FIRE_RESULT', line: '> No valid tickets' });
        return;
      }
      if (targets.length === 0) {
        postToOverlay({ type: 'FIRE_RESULT', line: '> No products selected' });
        return;
      }

      const plan = buildStrikeQueue({ tickets: valid, targets });
      if (preparationCancellation.cancelled) {
        reportPreparationCancelled();
        return;
      }
      if (plan.shots.length === 0) {
        postToOverlay({ type: 'FIRE_RESULT', line: '> Strike queue empty' });
        return;
      }

      const burstIntervalMs = options.burstIntervalMs ?? Math.max(50, Math.round(fireConfig.burstIntervalMs) || 2100);
      const intervalMs = options.mode === 'burst' ? 500 : burstIntervalMs;
      const maxInFlight = options.mode === 'burst' ? 2 : 1;
      const calibrationSnapshot = await safeGet<RuntimeCalibrationSnapshot>(RUNTIME_CALIBRATION_KEY).catch(() => null);
      const authCapturedAt = typeof auth.capturedAt === 'number' ? auth.capturedAt : Date.now();
      postToOverlay({
        type: 'FIRE_LOG_V2_RUN',
        data: {
          runId,
          mode: options.mode,
          targetAt: startMs,
          preparationStartedAt,
          preparedAt: Date.now(),
          startMs,
          intervalMs,
          maxInFlight,
          products: targets.map((target) => ({ productId: target.productId, priority: target.priority })),
          tickets: plan.shots.map((shot) => ({ ticket: shot.ticket, randstr: shot.randstr, createdAt: shot.createdAt })),
          calibration: calibrationSnapshot,
          auth: { source: auth.metadata?.source || 'unknown', ageMs: Math.max(0, Date.now() - authCapturedAt) },
          ...(options.mode === 'auto' && options.autoTiming ? {
            nextSaleTime: options.autoTiming.targetMs,
            targetMs: options.autoTiming.targetMs,
            preparationLeadMs: options.autoTiming.preparationLeadMs,
            rttCompensationMs: options.autoTiming.rttCompensationMs,
            clockOffsetMs: options.autoTiming.clockOffsetMs,
            earlyOffsetMs: options.autoTiming.earlyOffsetMs,
          } : {}),
        },
      });
      postToOverlay({ type: 'FIRE_LOG_V2_EVENT', data: { type: 'run_prepared', runId, preparedAt: Date.now() } });
      postToOverlay({
        type: 'FIRE_RESULT',
        line: `> ${options.label} ${plan.shots.length} shots · ${burstIntervalMs}ms`,
      });
      postToOverlay({
        type: 'FIRE_BATCH_START',
        data: {
          queue: plan.shots.map((shot, idx) => ({
            shotIdx: idx,
            productId: shot.productId,
            priority: shot.priority,
            ticketMask: maskTicket(shot.ticket),
          })),
          totalShots: plan.shots.length,
          runId,
          startMs,
          mode: options.mode,
          burstIntervalMs,
        },
      });

      let cancelled = false;
      let runner: FireRunner | null = null;
      const cancelAll = () => {
        if (cancelled) return;
        cancelled = true;
        currentStrikeCancel = null;
        runner?.cancel();
      };

      const total = plan.shots.length;
      const releasedAtByShot = new Map<string, number>();
      const buildShotLog = (shot: StrikeShot, idx: number, outcome: string, rtt: number, sentAt: number, result?: any, extra: Record<string, unknown> = {}) => {
        const transport = result?.metadata?.transport || {};
        const request = transport.request;
        const response = transport.body === undefined && transport.status === undefined ? undefined : {
          headers: transport.headers || {}, body: transport.body || '', status: transport.status, statusText: transport.statusText,
        };
        return {
          runId, shotId: `shot-${idx}`, shotIdx: idx, productId: shot.productId, priority: shot.priority,
          ticket: shot.ticket, randstr: shot.randstr, ticketMask: maskTicket(shot.ticket),
          requestSeq: idx, plannedAt: startMs + idx * intervalMs, outcome, rtt, sentAt,
          releasedAt: releasedAtByShot.get(`shot-${idx}`),
          request, response, timing: transport.timing,
          httpStatus: transport.status, statusText: transport.statusText,
          ...extra,
        };
      };

      const fireOne = async (shot: StrikeShot, idx: number, fireRequest: { requestId: string; onFetchStarted(meta?: { fetchStartedAt?: number; [key: string]: unknown }): void; setAbort(abort: () => void): void }): Promise<string> => {
        if (cancelled) return 'cancelled';
        const tag = '>[#' + (idx + 1) + '/' + total + '][P' + shot.priority + '] ' + shot.productId.slice(-6);
        const t1 = Date.now();
        let fetchTiming: MainWorldTransportTiming | undefined;
        const persistCancelledStartedShot = (result?: any) => {
          if (!fetchTiming) return;
          const cancelledShot = buildShotLog(shot, idx, 'cancelled', Date.now() - t1, t1, result, {
            code: result?.metadata?.transport?.status || 0,
            request: result?.metadata?.transport?.request || {
              method: 'POST', url: 'https://bigmodel.cn/api/biz/pay/preview',
              headers: {
                Authorization: normalizeAuthHeaders(auth)?.authorization || '',
                'Bigmodel-Organization': normalizeAuthHeaders(auth)?.bigmodelOrganization || '',
                'Bigmodel-Project': normalizeAuthHeaders(auth)?.bigmodelProject || '',
              },
              body: JSON.stringify({ productId: shot.productId, ticket: shot.ticket, randstr: shot.randstr || '' }),
            },
            timing: result?.metadata?.transport?.timing || fetchTiming,
            cancel: { reason: 'user_cancelled_after_fetch_started', cancelledAt: Date.now() },
          });
          postToOverlay({ type: 'FIRE_LOG_V2_EVENT', data: {
            type: 'fetch_aborted', runId, shotId: `shot-${idx}`, requestSeq: idx,
            plannedAt: cancelledShot.plannedAt, timing: cancelledShot.timing,
            shot: cancelledShot,
          } });
        };
        try {
          const result = await (bigmodelAdapter.orderPipeline as any).run({
            platform: 'bigmodel',
            productId: shot.productId,
            ticket: { ticket: shot.ticket, randstr: shot.randstr, provider: 'tencent-captcha', createdAt: shot.createdAt },
          }, auth, {
            requestId: fireRequest.requestId,
            runId,
            shotId: `shot-${idx}`,
            onFetchStarted: ({ timing, requestId }: { timing: MainWorldTransportTiming; requestId: string }) => {
              fetchTiming = timing;
              fireRequest.onFetchStarted({ fetchStartedAt: timing.fetchCalledAt, timing, requestId });
            },
            onAbortReady: fireRequest.setAbort,
          });
          if (cancelled) {
            persistCancelledStartedShot(result);
            return 'cancelled';
          }
          if (result.metadata?.transportFailure === 'timeout') {
            const timeoutShot = buildShotLog(shot, idx, 'timed_out', Date.now() - t1, t1, result, {
              code: 0,
              request: {
                method: 'POST', url: 'https://bigmodel.cn/api/biz/pay/preview',
                headers: {
                  Authorization: normalizeAuthHeaders(auth)?.authorization || '',
                  'Bigmodel-Organization': normalizeAuthHeaders(auth)?.bigmodelOrganization || '',
                  'Bigmodel-Project': normalizeAuthHeaders(auth)?.bigmodelProject || '',
                },
                body: JSON.stringify({ productId: shot.productId, ticket: shot.ticket, randstr: shot.randstr || '' }),
              },
              timing: fetchTiming,
              timeout: { timeoutMs: 8000, timedOutAt: Date.now() },
            });
            postToOverlay({ type: 'FIRE_LOG_V2_EVENT', data: {
              type: 'fetch_timed_out', runId, shotId: `shot-${idx}`, requestSeq: idx,
              plannedAt: timeoutShot.plannedAt, timing: timeoutShot.timing, shot: timeoutShot,
            } });
            return 'neterr';
          }
          const rtt = Date.now() - t1;

          if (result.success) {
            const session = result.data!;
            const bizId = session.bizId as string;
            const amount = session.amount as number;
            const productId = session.productId as string;
            const ps = {
              bizId,
              amount,
              productId,
              qrCode: session.qrCode || null,
              payType: fireConfig.payType,
              status: 'pending' as const,
              updatedAt: Date.now(),
            };
            // The order is terminal once the preview response is successful.
            // Each follow-up is isolated: a storage or overlay failure must not
            // suppress the user-visible success signal, shot log, or payment poll.
            const reportPostOrderFailure = (effect: string, error: unknown) => {
              try { postToOverlay({ type: 'FIRE_RESULT', line: `> Order succeeded; ${effect} failed: ${String(error)}` }); } catch {}
            };
            const runPostOrderEffect = (effect: string, work: () => Promise<unknown> | unknown) => {
              try {
                void Promise.resolve(work()).catch((error) => reportPostOrderFailure(effect, error));
              } catch (error) {
                reportPostOrderFailure(effect, error);
              }
            };
            runPostOrderEffect('payment persistence', () => updatePaymentState(ps));
            runPostOrderEffect('success notification', () => postToOverlay({ type: 'BURST_FIRE_SUCCESS', data: ps }));
            runPostOrderEffect('success log', () => postToOverlay({ type: 'FIRE_RESULT', line: tag + ': ORDER bizId=' + bizId + ' (' + rtt + 'ms)' }));
            runPostOrderEffect('shot result log', () => postToOverlay({
              type: 'FIRE_SHOT_RESULT',
              data: buildShotLog(shot, idx, 'success', rtt, t1, result, { code: 200, bizId, rawBody: getRawBody(result), serverMsg: '' }),
            }));
            if (options.pollPayment) {
              runPostOrderEffect('payment polling', () => pollPayCheck(auth, bizId, (status) => {
                void updatePaymentState({ status: status === 'SUCCESS' ? 'success' : status === 'EXPIRE' ? 'expired' : 'timeout' }).catch(() => undefined);
                try {
                  reportPaymentStatus(status, bizId, postToOverlay);
                } catch (error) {
                  try { postToOverlay({ type: 'FIRE_RESULT', line: '> Payment status update failed: ' + String(error) }); } catch {}
                }
              }));
            }
            return 'success';
          } else if (result.metadata?.classified?.outcome === 'soldout') {
            postToOverlay({ type: 'FIRE_RESULT', line: tag + ': sold-out today (' + rtt + 'ms)' });
            postToOverlay({ type: 'FIRE_SHOT_RESULT', data: buildShotLog(shot, idx, 'soldout', rtt, t1, result, { code: 200, rawBody: getRawBody(result), rawServerMsg: (result.metadata?.classified as any)?.rawServerMsg || '', serverMsg: (result.metadata?.classified as any)?.serverMsg || 'sold out', responsibility: (result.metadata?.classified as any)?.responsibility }) });
            return 'soldout';
          } else if (result.metadata?.classified?.outcome === 'busy' && (result.metadata?.classified as any)?.code === 555) {
            postToOverlay({ type: 'FIRE_RESULT', line: tag + ': server-busy-555 (' + rtt + 'ms)' });
            postToOverlay({ type: 'FIRE_SHOT_RESULT', data: buildShotLog(shot, idx, 'busy', rtt, t1, result, { code: 555, rawBody: getRawBody(result), rawServerMsg: (result.metadata?.classified as any)?.rawServerMsg || '', serverMsg: (result.metadata?.classified as any)?.serverMsg || 'server busy', responsibility: (result.metadata?.classified as any)?.responsibility }) });
            return 'busy';
          } else {
            const rawBody = result.metadata?.raw;
            const rawBodyText = (result.metadata as any)?.rawBodyText || (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {}));
            const cls = (result.metadata?.classified as ClassifiedShotResult | undefined)
              ?? (rawBody
                ? classifyPreviewError(rawBody as any, rawBodyText)
                : classifyPreviewNetworkError(result.error || 'unknown error'));
            postToOverlay({ type: 'FIRE_RESULT', line: tag + ': ' + cls.outcome + ' (' + rtt + 'ms)' });
            postToOverlay({
              type: 'FIRE_SHOT_RESULT',
              data: buildShotLog(shot, idx, cls.outcome, rtt, t1, result, { code: cls.code, rawBody: getRawBody(result), serverMsg: cls.serverMsg, rawServerMsg: cls.rawServerMsg, responsibility: cls.responsibility }),
            });
            return cls.outcome;
          }
        } catch (e: any) {
          if (e?.name === 'AbortError' || cancelled) {
            persistCancelledStartedShot();
            return 'cancelled';
          }
          const cls = classifyPreviewNetworkError(e);
          postToOverlay({ type: 'FIRE_RESULT', line: tag + ': net-err: ' + cls.rawServerMsg });
          postToOverlay({
            type: 'FIRE_SHOT_RESULT',
            data: buildShotLog(shot, idx, cls.outcome, Date.now() - t1, t1, undefined, { code: cls.code, rawBody: '', serverMsg: cls.serverMsg, rawServerMsg: cls.rawServerMsg, responsibility: cls.responsibility }),
          });
          return cls.outcome;
        }
      };

      const schedule = buildFireSchedule({
        runId,
        mode: options.mode,
        startMs,
        intervalMs,
        shots: plan.shots.map((shot, index) => ({
          shotId: `shot-${index}`,
          productId: shot.productId,
          productPriority: shot.priority,
        })),
      });
      const shotsById = new Map(schedule.slots.map((slot, index) => [slot.shotId, plan.shots[index]]));
      runner = new FireRunner({
        ...schedule,
        maxInFlight,
        onEvent: (event) => {
          if (event.type === 'shot_released' && typeof event.payload.shotId === 'string') {
            const releasedAt = Number(event.payload.releasedAt ?? event.payload.scheduledAt);
            if (Number.isFinite(releasedAt)) releasedAtByShot.set(event.payload.shotId, releasedAt);
          }
          postToOverlay({ type: 'FIRE_LOG_V2_EVENT', data: { type: event.type, ...event.payload } });
          if (event.type === 'tickets_reserved') {
            const reservedKeys = new Set(plan.shots.map((shot) => shot.ticket + ':' + shot.randstr + ':' + shot.createdAt));
            _ticketPool = _ticketPool.filter((ticket: any) => !reservedKeys.has(ticket.ticket + ':' + ticket.randstr + ':' + ticket.createdAt));
            writePageTicketStore();
            void getTicketInfo().then((info) => postToOverlay({ type: 'TICKET_COUNT', count: info.count, tickets: info.tickets }));
          }
          if (event.type === 'tickets_returned') {
            for (const shotId of (event.payload.shotIds as string[]) || []) {
              const shot = shotsById.get(shotId);
              if (shot && !_ticketPool.some((ticket: any) => ticket.ticket === shot.ticket && ticket.randstr === shot.randstr && ticket.createdAt === shot.createdAt)) {
                _ticketPool.push({ ticket: shot.ticket, randstr: shot.randstr, createdAt: shot.createdAt });
              }
            }
            writePageTicketStore();
            void getTicketInfo().then((info) => postToOverlay({ type: 'TICKET_COUNT', count: info.count, tickets: info.tickets }));
            postToOverlay({ type: 'FIRE_RESULT', line: '> Cancelled — returned unused tickets' });
          }
        },
        executeShot: async ({ shotId, requestSeq, requestId, onFetchStarted, setAbort }) => {
          const shot = shotsById.get(shotId);
          if (!shot) return { outcome: 'error' as const };
          const outcome = await fireOne(shot, requestSeq, { requestId, onFetchStarted, setAbort });
          postToOverlay({ type: 'FIRE_RESULT', line: `> ${outcome} (${requestSeq + 1}/${total})` });
          return { outcome: (['success', 'busy', 'soldout', 'neterr', 'waf', 'cancelled'].includes(outcome) ? outcome : 'error') as 'success' | 'busy' | 'soldout' | 'error' | 'neterr' | 'waf' | 'cancelled' };
        },
      });
      currentFireRunner = runner;
      currentStrikeCancel = cancelAll;
      finishPreparationCancellation();
      const result = await runner.run();
      postToOverlay({ type: 'FIRE_LOG_V2_RUN', data: { runId, finishedAt: Date.now(), lifecycleState: result.reason || 'complete', stopReason: result.reason || 'complete' } });
      if (!result.accepted) {
        if (currentFireRunner === runner) currentFireRunner = null;
        currentStrikeCancel = null;
        postToOverlay({ type: 'FIRE_RESULT', line: '> Strike already in progress — wait for completion or cooldown' });
        return;
      }
      if (result.reason === 'complete') {
        postToOverlay({ type: 'FIRE_RESULT', line: `> ${options.label} complete — ${total} shots` });
        postToOverlay({ type: 'BURST_FIRE_DEPLETED', data: { total } });
      }
      currentStrikeCancel = null;
      if (currentFireRunner === runner) currentFireRunner = null;
      } finally {
        finishPreparationCancellation();
        preparingFireRun = false;
      }
    }

    async function prepareAndRun(input: {
      runId: string;
      mode: 'manual' | 'burst' | 'auto';
      startMs: number;
      authArg?: any;
      preparationCancellation?: FirePreparationCancellation;
      autoTiming?: AutoTimingMetadata;
    }) {
      const mode = input.mode;
      const label = mode === 'burst' ? 'BURST' : mode === 'auto' ? 'Auto' : 'Strike';
      await runStrikeSequence(input.startMs, input.authArg, {
        runId: input.runId,
        label,
        mode,
        burstIntervalMs: mode === 'burst' ? 500 : undefined,
        enableBusyBackoff: mode === 'manual',
        pollPayment: true,
        preparationCancellation: input.preparationCancellation,
        autoTiming: input.autoTiming,
      });
    }

    async function strike(startMs: number, authOverride?: any) {
      const auth = coerceToPlatformAuth(authOverride) || (await getFreshAuth());
      if (!auth || !(await bigmodelAdapter.authProbe.isAuthenticated(auth))) {
        postToOverlay({ type: 'FIRE_RESULT', line: '> No auth headers' });
        return;
      }
      await prepareAndRun({ runId: `manual-${Date.now()}`, mode: 'manual', startMs, authArg: auth });
    }

    async function burstStrike(startMs: number, authOverride?: any) {
      const auth = coerceToPlatformAuth(authOverride) || (await getFreshAuth());
      if (!auth || !(await bigmodelAdapter.authProbe.isAuthenticated(auth))) {
        postToOverlay({ type: 'FIRE_RESULT', line: '> No auth headers' });
        return;
      }
      await prepareAndRun({ runId: `burst-${Date.now()}`, mode: 'burst', startMs, authArg: auth });
    }

    async function prefireAndBurst(
      startMs: number,
      reason: string,
      preparationCancellation?: FirePreparationCancellation,
      runId?: string,
      autoTiming?: AutoTimingMetadata,
    ) {
      const reportPrefireCancelled = () => {
        postToOverlay({ type: 'FIRE_RESULT', line: '> Cancelled — preparation stopped' });
      };
      const finishPrefireCancellation = () => {
        if (currentFirePreparationCancellation === preparationCancellation) {
          currentFirePreparationCancellation = null;
        }
      };
      try {
      const authStatus = await getPrefireAuthStatus();
      if (preparationCancellation?.cancelled) {
        reportPrefireCancelled();
        return;
      }
      if (!authStatus.ok) {
        postToOverlay({
          type: 'PREFIRE_STATUS',
          data: {
            ok: false,
            reason: authStatus.reason,
            fireReason: reason,
          },
        });
        postToOverlay({ type: 'FIRE_RESULT', line: '> Prefire blocked: auth unavailable' });
        return;
      }

      postToOverlay({
        type: 'PREFIRE_STATUS',
        data: {
          ok: true,
          source: authStatus.source,
          capturedAt: authStatus.capturedAt,
          ageMs: authStatus.ageMs,
          tokenSuffix: authStatus.tokenSuffix,
          org: authStatus.org,
          project: authStatus.project,
          fireReason: reason,
        },
      });

      bannerWaveCount++;
      updateBannerWaveBadge();

      if (preparationCancellation?.cancelled) {
        reportPrefireCancelled();
        return;
      }

      if (reason === 'auto') {
        await runAutoFirePlan(startMs, authStatus.headers, preparationCancellation, runId, autoTiming);
        return;
      }

      if (reason === 'burst' || reason === 'batch-burst') {
        await burstStrike(startMs, authStatus.headers);
        return;
      }

      await strike(startMs, authStatus.headers);
      } finally {
        finishPrefireCancellation();
      }
    }

    // ── Listen for messages from MAIN world script ──
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;

      // From overlay (MAIN world) — commands
      if (event.data?.[MSG_CMD]) {
        if (event.data.type === 'GET_TICKET_COUNT') {
          const info = await getTicketInfo();
          postToOverlay({ type: 'TICKET_COUNT', count: info.count, tickets: info.tickets });
        }
        if (event.data.type === 'PREFIRE_FIRE') {
          const startMs: number = (event.data.data?.startMs) ?? Date.now();
          const reason: string = event.data.data?.reason ?? 'prefire-fire';
          prefireAndBurst(startMs, reason);
        }
        if (event.data.type === 'PREFIRE_PREPARE') {
          const prefireData = event.data.data || {};
          const fireStartMs: number = prefireData.fireStartMs ?? prefireData.startMs ?? Date.now();
          if (currentFirePreparationCancellation || preparingFireRun || currentFireRunner) {
            postToOverlay({ type: 'FIRE_RESULT', line: '> Strike already in progress — wait for completion or cooldown' });
            return;
          }
          const preparationCancellation = createFirePreparationCancellation();
          currentFirePreparationCancellation = preparationCancellation;
          const runId = `auto-${fireStartMs}-${Date.now()}`;
          const autoTiming: AutoTimingMetadata = {
            targetMs: Number(prefireData.targetMs ?? fireStartMs),
            preparationLeadMs: Number(prefireData.preparationLeadMs ?? 3000),
            rttCompensationMs: Number(prefireData.rttCompensationMs ?? 0),
            clockOffsetMs: Number(prefireData.clockOffsetMs ?? 0),
            earlyOffsetMs: Number(prefireData.earlyOffsetMs ?? 0),
          };
          await prefireAndBurst(fireStartMs, 'auto', preparationCancellation, runId, autoTiming);
        }
        if (event.data.type === 'CANCEL_FIRE') {
          currentFirePreparationCancellation?.cancel();
          currentFireRunner?.cancel();
          currentStrikeCancel?.();
        }
        if (event.data.type === 'GET_SALE_TIME') {
          const cfg = await getSaleConfig();
          const nst = getNextSaleTime(cfg);
          postToOverlay({ type: 'SALE_TIME_CONFIG', data: { config: cfg, nextSaleTime: nst } });
        }
        if (event.data.type === 'GET_RUNTIME_CALIBRATION') {
          const pushed = await pushRuntimeCalibrationToOverlay();
          if (!pushed) {
            await runRuntimeCalibration('manual-request');
          }
        }
        if (event.data.type === 'GET_FIRE_CONFIG') {
          try {
            const cfg = isExtensionContextValid() ? await fireStore.get() : { ...FIRE_CONFIG_DEFAULT };
            postToOverlay({ type: 'FIRE_CONFIG', data: cfg });
          } catch {
            postToOverlay({ type: 'FIRE_CONFIG', data: { ...FIRE_CONFIG_DEFAULT } });
          }
        }
        if (event.data.type === 'SET_FIRE_CONFIG' && event.data.data) {
          const incoming = event.data.data;
          let current: FireConfig;
          try {
            current = isExtensionContextValid() ? await fireStore.get() : { ...FIRE_CONFIG_DEFAULT };
          } catch {
            current = { ...FIRE_CONFIG_DEFAULT };
          }
          const next: FireConfig = {
            payType: incoming.payType === 'WE_CHAT' ? 'WE_CHAT' : 'ALI',
            burstIntervalMs: Number.isFinite(Number(incoming.burstIntervalMs))
              ? Math.max(50, Math.round(Number(incoming.burstIntervalMs)))
              : current.burstIntervalMs,
          };
          try {
            if (isExtensionContextValid()) await fireStore.set(next);
          } catch {}
          postToOverlay({ type: 'FIRE_CONFIG', data: next });
        }
        if (event.data.type === 'OCR_CAPTURE' && event.data.data?.reqId) {
          // Capture visible tab (includes cross-origin captcha popup)
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, (response) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else if (response && response.dataUrl) resolve(response.dataUrl);
                else reject(new Error('capture failed'));
              });
            });
            // dataUrl is "data:image/png;base64,..." — strip prefix
            const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            const resp = await fetch('http://127.0.0.1:9898/solve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: b64 })
            });
            const result = await resp.json();
            postToOverlay({ type: 'OCR_RESULT', reqId: event.data.data.reqId, data: result });
          } catch (e: any) {
            postToOverlay({ type: 'OCR_RESULT', reqId: event.data.data.reqId, error: e.message });
          }
        }
        if (event.data.type === 'OCR_SOLVE_URL' && event.data.data?.url) {
          try {
            console.log('[OCR-ISO] downloading:', event.data.data.url.substring(0,60));
            const imgResp = await fetch(event.data.data.url);
            const blob = await imgResp.blob();
            console.log('[OCR-ISO] downloaded:', blob.size, 'bytes');

            // Load image to get dimensions, then convert blob→base64 for OCR
            const { b64, imgW, imgH } = await new Promise<{b64:string,imgW:number,imgH:number}>((resolve, reject) => {
              const img = new Image();
              img.onload = () => {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                const ctx = c.getContext('2d')!;
                ctx.drawImage(img, 0, 0);
                resolve({ b64: c.toDataURL('image/png').split(',')[1], imgW: img.naturalWidth, imgH: img.naturalHeight });
              };
              img.onerror = () => reject(new Error('image load failed'));
              img.src = URL.createObjectURL(blob);
            });

            console.log('[OCR-ISO] calling ocr server, image size:', imgW + 'x' + imgH);
            const remark = event.data.data.remark || '';
            const ocrResp = await fetch('http://127.0.0.1:9898/solve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: b64, remark: remark })
            });
            const result = await ocrResp.json();
            console.log('[OCR-ISO] ocr result:', JSON.stringify(result));
            if (result?.data) { result.data.imgW = imgW; result.data.imgH = imgH; }
            postToOverlay({ type: 'OCR_RESULT', reqId: event.data.data.reqId, data: result });
          } catch (e: any) {
            console.error('[OCR-ISO] error:', e.message);
            postToOverlay({ type: 'OCR_RESULT', reqId: event.data.data.reqId, error: e.message });
          }
        }
        if (event.data.type === 'OCR_SOLVE' && event.data.data?.image) {
          // Direct OCR proxy (for canvas-based captchas that ARE accessible)
          const imageB64 = event.data.image;
          try {
            const resp = await fetch('http://127.0.0.1:9898/solve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: imageB64 })
            });
            const result = await resp.json();
            postToOverlay({ type: 'OCR_RESULT', reqId: event.data.data.reqId, data: result });
          } catch (e: any) {
            postToOverlay({ type: 'OCR_RESULT', reqId: event.data.data.reqId, error: e.message });
          }
        }
        if (event.data.type === 'OCR_CHECK') {
          try {
            const resp = await fetch('http://127.0.0.1:9898/health');
            const data = await resp.json();
            postToOverlay({ type: 'OCR_STATUS', available: !!(data && data.ok) });
          } catch {
            postToOverlay({ type: 'OCR_STATUS', available: false });
          }
        }
        if (event.data.type === 'OPEN_OPTIONS_PAGE') {
          try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS_PAGE' }); } catch {}
        }
        if (event.data.type === 'CLEAR_TICKET_POOL') {
          clearPageTicketStore();
          const info = await getTicketInfo();
          postToOverlay({ type: 'TICKET_COUNT', count: info.count, tickets: info.tickets });
        }
      }

      // From XHR interceptor (MAIN world) — events
      if (!event.data?.[MSG_EVT]) return;
      const { type, payload } = event.data;

      if (type === 'PRODUCT_SELECTION_CHANGED' && payload) {
        await safeSet('local:selectedProducts', payload);
      }

      if (type === 'CAPTCHA_PRODUCED' && payload?.ticket) {
        await ensureTicketStoreReady();
        if (!_ticketPool.some((t: any) => t.ticket === payload.ticket)) {
          const now = Date.now();
          _ticketPool.push({ ticket: payload.ticket, randstr: payload.randstr, createdAt: now });
          _ticketPool = _ticketPool
            .filter((t: any) => now - t.createdAt < TICKET_TTL_MS)
            .sort((a: any, b: any) => a.createdAt - b.createdAt);
          if (_ticketPool.length > TICKET_POOL_MAX) {
            _ticketPool.splice(0, _ticketPool.length - TICKET_POOL_MAX);
          }
          writePageTicketStore();
          postToOverlay({ type: 'FIRE_RESULT', line: `> 🎫 ticket #${_ticketPool.length} acquired (${_ticketPool.length}/${TICKET_POOL_MAX})` });
        }
        const info = await getTicketInfo();
        postToOverlay({ type: 'TICKET_COUNT', count: info.count, tickets: info.tickets });
      }

      if (type === 'CAPTCHA_ERROR' && payload) {
        postToOverlay({ type: 'FIRE_RESULT', line: '> Captcha error: ' + payload.msg });
      }

      if (type === 'BATCH_MODE_STATUS') {
        // Force-stop banner disabled — OCR status shown in overlay instead
        removeForceStopBanner();
      }
    });

    // ── Listen for commands from popup ──
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'PRODUCE_CAPTCHA') {
        window.postMessage({ [MSG_CMD]: true, type: 'PRODUCE_CAPTCHA' }, '*');
        sendResponse({ ok: true });
      }
      if (msg.type === 'GET_TICKET_COUNT') {
        getTicketInfo().then((info) => sendResponse({ count: info.count }));
        return true;
      }
    });

    // Initial overlay sync
    setTimeout(async () => {
      try {
        const info = await getTicketInfo();
        postToOverlay({ type: 'TICKET_COUNT', count: info.count, tickets: info.tickets });
        const cfg = await getSaleConfig();
        const nst = getNextSaleTime(cfg);
        postToOverlay({ type: 'SALE_TIME_CONFIG', data: { config: cfg, nextSaleTime: nst } });
        await syncCaptchaConfig(true);
      } catch {}
    }, 2000);

    void startRuntimeCalibrationLoop();

    // R3: Start flash sale reminder loop
    initReminderLoop();
  },
});
