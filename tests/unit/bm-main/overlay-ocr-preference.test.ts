import { describe, expect, it } from 'vitest';
import * as vm from 'vm';

import OVERLAY_SOURCE from '../../../src/bm-main/08-overlay.js?raw';

function createOverlayHarness(options: {
  storage?: Map<string, string>;
  storageUnavailable?: boolean;
} = {}) {
  document.body.innerHTML = '';
  const messages: Array<Record<string, unknown>> = [];
  const actions: string[] = [];
  const scheduledWindows: Array<{ nextSaleTime: number; enabled: boolean }> = [];
  const messageListeners: Array<(event: { source: unknown; data: Record<string, unknown> }) => void> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const storage = options.storage ?? new Map<string, string>();
  const runtime = { nextSaleTime: 0 };
  const overlayWindow = {
    postMessage(message: Record<string, unknown>) {
      messages.push(message);
    },
    addEventListener(type: string, listener: (event: { source: unknown; data: Record<string, unknown> }) => void) {
      if (type === 'message') messageListeners.push(listener);
    },
    removeEventListener() {},
  };
  const context = vm.createContext({
    CSS: '',
    O: '_overlay',
    _NS: 'overlay-auto-test-',
    SK_BP: 'bp',
    MSG_CMD: '__cmd',
    MSG_OVL: '__overlay',
    BATCH_SESSION_LIMIT: 100,
    _ticketCount: 0,
    _tickets: [],
    _priorityList: [],
    _productMatrix: { monthly: [], quarterly: [], yearly: [] },
    _productLoadStatus: { status: 'idle' },
    _fireConfig: { burstIntervalMs: 2_100, payType: 'ALI' },
    _rt: runtime,
    document,
    window: overlayWindow,
    location: { pathname: '/glm-coding' },
    localStorage: { getItem: () => null },
    sessionStorage: {
      getItem(key: string) {
        if (options.storageUnavailable) throw new Error('sessionStorage unavailable');
        actions.push('storage:get:' + key);
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (options.storageUnavailable) throw new Error('sessionStorage unavailable');
        storage.set(key, value);
        actions.push('storage:set:' + key);
      },
      removeItem(key: string) {
        if (options.storageUnavailable) throw new Error('sessionStorage unavailable');
        storage.delete(key);
      },
    },
    cmdToOverlay(type: string, data?: unknown) {
      const message: Record<string, unknown> = { __cmd: true, type };
      if (data !== undefined) message.data = data;
      messages.push(message);
      actions.push('message:' + type);
    },
    setupXhrInterception() {},
    syncSelectionStatus() {},
    setupProductUI() {},
    setBatchMode() {},
    toggleBatchMode() {},
    scheduleAutoFire(nextSaleTime: number) {
      runtime.nextSaleTime = nextSaleTime;
      scheduledWindows.push({
        nextSaleTime,
        enabled: (document.getElementById('_autoToggle') as HTMLInputElement | null)?.checked === true,
      });
      actions.push('schedule:' + nextSaleTime);
    },
    scheduleAutoTicketWindow(nextSaleTime: number) {
      scheduledWindows.push({
        nextSaleTime,
        enabled: (document.getElementById('_autoToggle') as HTMLInputElement | null)?.checked === true,
      });
      actions.push('schedule:' + nextSaleTime);
    },
    applyRuntimeCalibration() {},
    renderPrefireAuthStatus() {},
    persistSelection() {},
    renderProducts() {},
    loadBatchPreviewFromCache() {},
    loadProducts() {},
    renderProductsAuthError() {},
    renderFireConfig() {},
    setTimeout(callback: () => void, delay: number) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    console,
  });
  vm.runInContext(OVERLAY_SOURCE, context);

  const injectTimer = timers.find((timer) => timer.delay === 1_500);
  if (!injectTimer) throw new Error('overlay injection timer was not registered');
  injectTimer.callback();

  return {
    actions,
    messages,
    scheduledWindows,
    storage,
    dispatchOverlayMessage(message: Record<string, unknown>) {
      for (const listener of messageListeners) {
        listener({ source: overlayWindow, data: { __overlay: true, ...message } });
      }
    },
    runStartupTimers() {
      for (const timer of timers.filter((entry) => entry !== injectTimer)) timer.callback();
    },
    runTimer(delay: number) {
      const timer = timers.find((entry) => entry.delay === delay);
      if (!timer) throw new Error(`timer ${delay}ms was not registered`);
      timer.callback();
    },
    autoToggle: document.getElementById('_autoToggle') as HTMLInputElement,
    toggle: document.getElementById('_ocrToggle') as HTMLInputElement,
  };
}

describe('automatic ticket window preference', () => {
  it('restores the namespaced session preference before sale-time scheduling after reload', () => {
    const sharedStorage = new Map<string, string>();
    const firstPage = createOverlayHarness({ storage: sharedStorage });
    expect(firstPage.autoToggle.checked).toBe(false);

    firstPage.dispatchOverlayMessage({ type: 'SALE_TIME_CONFIG', data: { nextSaleTime: 5_000_000 } });
    firstPage.actions.length = 0;
    firstPage.autoToggle.checked = true;
    firstPage.autoToggle.dispatchEvent(new Event('change'));

    const preferenceKey = [...sharedStorage.keys()].find((key) => key.startsWith('overlay-auto-test-'));
    expect(preferenceKey).toBeDefined();
    expect(preferenceKey).not.toBe('auto-ticket-enabled');
    expect(sharedStorage.get(preferenceKey!)).toBe('1');
    expect(firstPage.actions.indexOf('storage:set:' + preferenceKey))
      .toBeLessThan(firstPage.actions.indexOf('schedule:5000000'));

    const reloadedPage = createOverlayHarness({ storage: sharedStorage });
    expect(reloadedPage.autoToggle.checked).toBe(true);

    reloadedPage.dispatchOverlayMessage({ type: 'SALE_TIME_CONFIG', data: { nextSaleTime: 5_000_000 } });
    expect(reloadedPage.scheduledWindows.at(-1)).toEqual({ nextSaleTime: 5_000_000, enabled: true });

    reloadedPage.runTimer(800);
    expect(reloadedPage.messages).toContainEqual({ __cmd: true, type: 'GET_SALE_TIME' });
  });

  it('defaults to disabled and continues scheduling when sessionStorage is unavailable', () => {
    const harness = createOverlayHarness({ storageUnavailable: true });
    expect(harness.autoToggle.checked).toBe(false);

    harness.dispatchOverlayMessage({ type: 'SALE_TIME_CONFIG', data: { nextSaleTime: 6_000_000 } });
    harness.autoToggle.checked = true;
    expect(() => harness.autoToggle.dispatchEvent(new Event('change'))).not.toThrow();

    expect(harness.scheduledWindows.at(-1)).toEqual({ nextSaleTime: 6_000_000, enabled: true });
  });
});

describe('OCR automatic preference overlay bridge', () => {
  it('requests the preference while preserving the startup OCR health check', () => {
    const harness = createOverlayHarness();

    harness.runStartupTimers();

    expect(harness.messages).toContainEqual({
      __cmd: true,
      type: 'GET_OCR_AUTO_PREF',
      data: { revision: 0 },
    });
    expect(harness.messages.map((message) => message.type)).toContain('OCR_CHECK');
  });

  it('applies a disabled preference received from the content script', () => {
    const harness = createOverlayHarness();

    harness.dispatchOverlayMessage({ type: 'OCR_AUTO_PREF', enabled: false });

    expect(harness.toggle.checked).toBe(false);
  });

  it('sends the changed preference to the content script', () => {
    const harness = createOverlayHarness();
    harness.toggle.checked = false;

    harness.toggle.dispatchEvent(new Event('change'));

    expect(harness.messages).toContainEqual({
      __cmd: true,
      type: 'SET_OCR_AUTO_PREF',
      data: { enabled: false, revision: 1 },
    });
  });

  it('ignores a delayed startup preference after a newer user change', () => {
    const harness = createOverlayHarness();
    harness.toggle.checked = false;
    harness.toggle.dispatchEvent(new Event('change'));
    harness.runStartupTimers();

    const startupRequest = harness.messages.find((message) => message.type === 'GET_OCR_AUTO_PREF');
    harness.dispatchOverlayMessage({
      type: 'OCR_AUTO_PREF',
      enabled: true,
      revision: (startupRequest?.data as { revision?: number })?.revision,
    });

    expect(harness.toggle.checked).toBe(false);
    expect(startupRequest).toEqual({
      __cmd: true,
      type: 'GET_OCR_AUTO_PREF',
      data: { revision: 0 },
    });
    expect(harness.messages.map((message) => message.type)).toContain('OCR_CHECK');
  });

  it('applies the canonical value from a failed current-revision update', () => {
    const harness = createOverlayHarness();
    harness.toggle.checked = false;
    harness.toggle.dispatchEvent(new Event('change'));

    harness.dispatchOverlayMessage({
      type: 'OCR_AUTO_PREF',
      enabled: true,
      revision: 1,
      persisted: false,
    });

    expect(harness.toggle.checked).toBe(true);
  });
});
