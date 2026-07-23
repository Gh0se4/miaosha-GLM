import { describe, expect, it } from 'vitest';
import * as vm from 'vm';

import OVERLAY_SOURCE from '../../../src/bm-main/08-overlay.js?raw';

function createOverlayHarness() {
  document.body.innerHTML = '';
  const messages: Array<Record<string, unknown>> = [];
  const messageListeners: Array<(event: { source: unknown; data: Record<string, unknown> }) => void> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
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
    MSG_CMD: '__cmd',
    MSG_OVL: '__overlay',
    BATCH_SESSION_LIMIT: 100,
    _ticketCount: 0,
    _tickets: [],
    _priorityList: [],
    _productMatrix: { monthly: [], quarterly: [], yearly: [] },
    _productLoadStatus: { status: 'idle' },
    _fireConfig: { burstIntervalMs: 2_100, payType: 'ALI' },
    _rt: { nextSaleTime: 0 },
    document,
    window: overlayWindow,
    location: { pathname: '/glm-coding' },
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    cmdToOverlay(type: string, data?: unknown) {
      const message: Record<string, unknown> = { __cmd: true, type };
      if (data !== undefined) message.data = data;
      messages.push(message);
    },
    setupXhrInterception() {},
    syncSelectionStatus() {},
    setupProductUI() {},
    setBatchMode() {},
    toggleBatchMode() {},
    scheduleAutoFire() {},
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
    messages,
    dispatchOverlayMessage(message: Record<string, unknown>) {
      for (const listener of messageListeners) {
        listener({ source: overlayWindow, data: { __overlay: true, ...message } });
      }
    },
    runStartupTimers() {
      for (const timer of timers.filter((entry) => entry !== injectTimer)) timer.callback();
    },
    toggle: document.getElementById('_ocrToggle') as HTMLInputElement,
  };
}

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
