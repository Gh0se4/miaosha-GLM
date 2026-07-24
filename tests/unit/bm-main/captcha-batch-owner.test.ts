import { describe, expect, it } from 'vitest';
import * as vm from 'vm';

import CAPTCHA_SOURCE from '../../../src/bm-main/04-captcha.js?raw';
import OVERLAY_SOURCE from '../../../src/bm-main/08-overlay.js?raw';

function createCaptchaHarness(options: { limit?: number } = {}) {
  const messageListeners: Array<(event: { source: unknown; data: Record<string, unknown> }) => void> = [];
  const keyListeners: Array<(event: Record<string, unknown>) => void> = [];
  const statusMessages: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const captchaCallbacks: Array<(result: Record<string, unknown>) => void> = [];
  let produceCount = 0;
  let destroyCount = 0;

  const batchButton = { innerHTML: '', style: { borderColor: '', color: '', background: '' } };
  const fakeDocument = {
    getElementById(id: string) { return id === '_ab' ? batchButton : null; },
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      if (type === 'keydown') keyListeners.push(listener);
    },
  };
  const fakeWindow: Record<string, unknown> = {
    addEventListener(type: string, listener: (event: { source: unknown; data: Record<string, unknown> }) => void) {
      if (type === 'message') messageListeners.push(listener);
    },
    postMessage() {},
  };

  class FakeTencentCaptcha {
    constructor(_appId: string, callback: (result: Record<string, unknown>) => void) {
      produceCount += 1;
      captchaCallbacks.push(callback);
    }
    show() {}
    destroy() { destroyCount += 1; }
  }
  fakeWindow.TencentCaptcha = FakeTencentCaptcha;

  const context = vm.createContext({
    CAPTCHA_APPID: 'test-app',
    BATCH_SESSION_LIMIT: options.limit ?? 100,
    _batchMode: false,
    _batchModeOwner: null,
    _batchCount: 0,
    _activeCaptcha: null,
    _ocrBusy: false,
    _ocrFailCount: 0,
    _NS: 'captcha-owner-test-',
    MSG_CMD: '__cmd',
    MSG_EVT: '__event',
    MSG_OVL: '__overlay',
    CSS: '',
    O: '_overlay',
    document: fakeDocument,
    window: fakeWindow,
    location: { pathname: '/not-overlay-page' },
    postMsg(type: string, payload: Record<string, unknown>) { statusMessages.push({ type, payload }); },
    postToOverlay() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    console,
  });

  vm.runInContext(CAPTCHA_SOURCE, context);
  vm.runInContext(OVERLAY_SOURCE, context);

  function dispatchWindowMessage(data: Record<string, unknown>) {
    for (const listener of messageListeners) listener({ source: fakeWindow, data });
  }

  return {
    api: {
      setBatchMode: context.setBatchMode as (on: boolean, owner?: 'manual' | 'auto-ticket') => void,
      toggleBatchMode: context.toggleBatchMode as () => void,
    },
    dispatchAuto(type: 'AUTO_TICKET_WINDOW_START' | 'AUTO_TICKET_WINDOW_STOP') {
      dispatchWindowMessage({ __cmd: true, type });
    },
    dispatchSuccess() {
      dispatchWindowMessage({ __overlay: true, type: 'BURST_FIRE_SUCCESS', data: { bizId: 'biz-1' } });
    },
    dispatchEscape() {
      for (const listener of keyListeners) {
        listener({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
      }
    },
    solveCaptcha() {
      const callback = captchaCallbacks.at(-1);
      if (!callback) throw new Error('captcha callback was not registered');
      callback({ ret: 0, ticket: 'ticket-1', randstr: 'rand-1' });
    },
    statusMessages,
    get batchMode() { return context._batchMode as boolean; },
    get owner() { return context._batchModeOwner as string | null; },
    get batchCount() { return context._batchCount as number; },
    set batchCount(value: number) { context._batchCount = value; },
    get produceCount() { return produceCount; },
    get destroyCount() { return destroyCount; },
  };
}

describe('captcha batch ownership', () => {
  it('does not let automatic start or stop take over an active manual batch', () => {
    const harness = createCaptchaHarness();
    harness.api.toggleBatchMode();
    harness.batchCount = 7;

    harness.dispatchAuto('AUTO_TICKET_WINDOW_START');
    harness.dispatchAuto('AUTO_TICKET_WINDOW_STOP');

    expect(harness.batchMode).toBe(true);
    expect(harness.owner).toBe('manual');
    expect(harness.batchCount).toBe(7);
    expect(harness.produceCount).toBe(1);
    expect(harness.destroyCount).toBe(0);
    expect(harness.statusMessages.filter((message) => message.type === 'BATCH_MODE_STATUS'))
      .toEqual([{ type: 'BATCH_MODE_STATUS', payload: { active: true } }]);

    harness.api.toggleBatchMode();
    expect(harness.batchMode).toBe(false);
    expect(harness.owner).toBeNull();
  });

  it('starts an automatic batch once and only lets its matching stop close it', () => {
    const harness = createCaptchaHarness();
    harness.dispatchAuto('AUTO_TICKET_WINDOW_START');
    harness.batchCount = 3;
    harness.dispatchAuto('AUTO_TICKET_WINDOW_START');

    expect(harness.batchMode).toBe(true);
    expect(harness.owner).toBe('auto-ticket');
    expect(harness.batchCount).toBe(3);
    expect(harness.produceCount).toBe(1);

    harness.dispatchAuto('AUTO_TICKET_WINDOW_STOP');
    expect(harness.batchMode).toBe(false);
    expect(harness.owner).toBeNull();
    expect(harness.destroyCount).toBe(1);
  });

  it('clears automatic ownership when the batch limit is reached', () => {
    const harness = createCaptchaHarness({ limit: 1 });
    harness.dispatchAuto('AUTO_TICKET_WINDOW_START');
    expect(harness.owner).toBe('auto-ticket');

    harness.solveCaptcha();

    expect(harness.batchMode).toBe(false);
    expect(harness.owner).toBeNull();
  });

  it.each(['success', 'Escape'] as const)('clears manual ownership on %s', (reason) => {
    const harness = createCaptchaHarness();
    harness.api.toggleBatchMode();
    expect(harness.owner).toBe('manual');

    if (reason === 'success') harness.dispatchSuccess();
    else harness.dispatchEscape();

    expect(harness.batchMode).toBe(false);
    expect(harness.owner).toBeNull();
  });
});
