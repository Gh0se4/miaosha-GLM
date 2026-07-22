import { describe, expect, it } from 'vitest';
import * as vm from 'vm';

import { FireRunner } from '../../../lib/api/fire-runner';
import { buildFireSchedule } from '../../../lib/api/fire-scheduler';
import AUTO_SOURCE from '../../../src/bm-main/07-auto-fire.js?raw';

type AutoTicketTimer = {
  callback: () => void;
  dueAt: number;
};

function createAutoTicketHarness(options: {
  now: number;
  storage?: Map<string, string>;
  markerWriteFails?: boolean;
}) {
  let now = options.now;
  let nextTimerId = 1;
  let reloadCount = 0;
  const storage = options.storage ?? new Map<string, string>();
  const messages: any[] = [];
  const actions: string[] = [];
  const timers = new Map<number, AutoTicketTimer>();
  const toggle = { checked: true };
  class FakeDate extends Date {
    static now() { return now; }
  }
  const context = {
    _NS: 'auto-ticket-test-',
    _rt: { latencyMs: 0, clockOffsetMs: 0, autoTimer: null, countdownTimer: null, autoFired: false, nextSaleTime: 0 },
    MSG_CMD: '__cmd',
    Date: FakeDate,
    document: { getElementById: (id: string) => id === '_autoToggle' ? toggle : null },
    window: { postMessage: (message: any) => {
      messages.push(message);
      actions.push('message:' + message.type + (message.data?.type ? ':' + message.data.type : ''));
    } },
    location: { reload: () => { reloadCount++; actions.push('reload'); } },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (options.markerWriteFails) throw new Error('session storage denied');
        storage.set(key, value);
        actions.push('storage:' + key);
      },
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimerId++;
      timers.set(id, { callback, dueAt: now + delay });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  const api = vm.runInNewContext(`${AUTO_SOURCE}; ({ scheduleAutoTicketWindow })`, context) as {
    scheduleAutoTicketWindow(nextSaleTime: number): void;
  };

  function advanceTo(target: number) {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].dueAt;
      due[1].callback();
    }
    now = target;
  }

  return {
    api,
    advanceTo,
    actions,
    messages,
    storage,
    toggle,
    get activeSaleTime() { return (context as any)._autoTicketWindowSaleTime; },
    get reloadCount() { return reloadCount; },
  };
}

function autoTicketDiagnostics(messages: any[]) {
  return messages
    .filter((message) => message.type === 'AUTO_TICKET_DIAGNOSTIC')
    .map((message) => message.data);
}


function makeRunner(mode: 'manual' | 'burst' | 'auto', intervalMs: number) {
  let now = 100;
  const started: Array<{ shotId: string; at: number }> = [];
  const schedule = buildFireSchedule({
    runId: `${mode}-run`,
    mode,
    startMs: now,
    intervalMs,
    shots: [
      { shotId: 'first', productId: 'p1', productPriority: 1 },
      { shotId: 'second', productId: 'p2', productPriority: 1 },
    ],
  });
  const runner = new FireRunner({
    ...schedule,
    maxInFlight: mode === 'burst' ? 2 : 1,
    onEvent: () => undefined,
    executeShot: async ({ shotId, onFetchStarted }) => {
      onFetchStarted({ fetchStartedAt: now });
      started.push({ shotId, at: now });
      return { outcome: 'neterr' as const };
    },
  }, {
    now: () => now,
    waitUntil: async (target) => { now = target; },
  });
  return { runner, schedule, started };
}

describe('auto fire prepare-run lifecycle', () => {
  it('opens at exactly T-4m58s and closes at exactly T-10s', () => {
    const nextSaleTime = 2_000_000;
    const startAt = nextSaleTime - (4 * 60 + 58) * 1_000;
    const stopAt = nextSaleTime - 10_000;
    const storage = new Map([['auto-ticket-test-auto-refresh-' + nextSaleTime, '1']]);
    const harness = createAutoTicketHarness({ now: startAt, storage });

    harness.api.scheduleAutoTicketWindow(nextSaleTime);

    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_START')).toHaveLength(1);
    expect(autoTicketDiagnostics(harness.messages)).toContainEqual({
      type: 'window_started',
      nextSaleTime,
      timestamp: startAt,
      reason: 'window_opened',
      details: { startAt, stopAt },
    });

    harness.advanceTo(stopAt - 1);
    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_STOP')).toHaveLength(0);
    harness.advanceTo(stopAt);

    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_STOP')).toHaveLength(1);
    expect(autoTicketDiagnostics(harness.messages)).toContainEqual({
      type: 'window_stopped',
      nextSaleTime,
      timestamp: stopAt,
      reason: 'window_elapsed',
      details: { startAt, stopAt },
    });
  });

  it('stops an active sale before scheduling a different sale without same-sale jitter', () => {
    const saleA = 2_000_000;
    const saleB = saleA + 60 * 60 * 1_000;
    const startA = saleA - (4 * 60 + 58) * 1_000;
    const stopA = saleA - 10_000;
    const startB = saleB - (4 * 60 + 58) * 1_000;
    const stopB = saleB - 10_000;
    const storage = new Map([
      ['auto-ticket-test-auto-refresh-' + saleA, '1'],
      ['auto-ticket-test-auto-refresh-' + saleB, '1'],
    ]);
    const harness = createAutoTicketHarness({ now: startA, storage });

    harness.api.scheduleAutoTicketWindow(saleA);
    harness.api.scheduleAutoTicketWindow(saleB);

    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_STOP')).toHaveLength(1);
    expect(autoTicketDiagnostics(harness.messages)).toContainEqual({
      type: 'window_stopped',
      nextSaleTime: saleA,
      timestamp: startA,
      reason: 'sale_rescheduled',
      details: { startAt: startA, stopAt: stopA, rescheduledTo: saleB },
    });
    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_START')).toHaveLength(1);

    harness.advanceTo(startB - 1);
    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_START')).toHaveLength(1);
    harness.advanceTo(startB);
    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_START')).toHaveLength(2);
    expect(autoTicketDiagnostics(harness.messages).filter((event) => event.type === 'window_started' && event.nextSaleTime === saleB)).toHaveLength(1);

    harness.api.scheduleAutoTicketWindow(saleB);
    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_START')).toHaveLength(2);
    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_STOP')).toHaveLength(1);

    harness.advanceTo(stopB);
    expect(harness.messages.filter((message) => message.type === 'AUTO_TICKET_WINDOW_STOP')).toHaveLength(2);
    expect(autoTicketDiagnostics(harness.messages)).toContainEqual({
      type: 'window_stopped',
      nextSaleTime: saleB,
      timestamp: stopB,
      reason: 'window_elapsed',
      details: { startAt: startB, stopAt: stopB },
    });
  });

  it('clears the active sale identity when automatic capture is disabled', () => {
    const nextSaleTime = 2_000_000;
    const startAt = nextSaleTime - (4 * 60 + 58) * 1_000;
    const stopAt = nextSaleTime - 10_000;
    const storage = new Map([['auto-ticket-test-auto-refresh-' + nextSaleTime, '1']]);
    const harness = createAutoTicketHarness({ now: startAt, storage });
    harness.api.scheduleAutoTicketWindow(nextSaleTime);
    expect(harness.activeSaleTime).toBe(nextSaleTime);

    harness.toggle.checked = false;
    harness.api.scheduleAutoTicketWindow(nextSaleTime);

    expect(harness.activeSaleTime).toBeNull();
    expect(autoTicketDiagnostics(harness.messages)).toContainEqual({
      type: 'window_stopped',
      nextSaleTime,
      timestamp: startAt,
      reason: 'auto_disabled',
      details: { startAt, stopAt },
    });
  });

  it('triggers refresh at exactly the T-30m boundary', () => {
    const nextSaleTime = 3_000_000;
    const refreshAt = nextSaleTime - 30 * 60 * 1_000;
    const harness = createAutoTicketHarness({ now: refreshAt });

    harness.api.scheduleAutoTicketWindow(nextSaleTime);
    harness.advanceTo(refreshAt);

    expect(harness.reloadCount).toBe(1);
    expect(harness.storage.get('auto-ticket-test-auto-refresh-' + nextSaleTime)).toBe('1');
    expect(autoTicketDiagnostics(harness.messages)).toContainEqual({
      type: 'refresh_scheduled',
      nextSaleTime,
      timestamp: refreshAt,
      reason: 'timer_scheduled',
      details: { refreshAt, delayMs: 0 },
    });
  });

  it('records an elapsed refresh decision after the T-30m boundary', () => {
    const nextSaleTime = 3_000_000;
    const refreshAt = nextSaleTime - 30 * 60 * 1_000;
    const harness = createAutoTicketHarness({ now: refreshAt + 1 });

    harness.api.scheduleAutoTicketWindow(nextSaleTime);

    expect(harness.reloadCount).toBe(0);
    expect(autoTicketDiagnostics(harness.messages)).toContainEqual({
      type: 'refresh_skipped',
      nextSaleTime,
      timestamp: refreshAt + 1,
      reason: 'window_elapsed',
      details: { refreshAt },
    });
  });

  it('marks a sale before reload, then recovers without reloading the same sale', () => {
    const nextSaleTime = 4_000_000;
    const refreshAt = nextSaleTime - 30 * 60 * 1_000;
    const firstPage = createAutoTicketHarness({ now: refreshAt - 1 });

    firstPage.api.scheduleAutoTicketWindow(nextSaleTime);
    expect(autoTicketDiagnostics(firstPage.messages)).toContainEqual({
      type: 'refresh_scheduled',
      nextSaleTime,
      timestamp: refreshAt - 1,
      reason: 'timer_scheduled',
      details: { refreshAt, delayMs: 1 },
    });

    firstPage.advanceTo(refreshAt);
    expect(firstPage.storage.get('auto-ticket-test-auto-refresh-' + nextSaleTime)).toBe('1');
    expect(autoTicketDiagnostics(firstPage.messages)).toContainEqual({
      type: 'refresh_triggered',
      nextSaleTime,
      timestamp: refreshAt,
      reason: 'timer_elapsed',
      details: { refreshAt },
    });
    expect(firstPage.reloadCount).toBe(1);
    expect(firstPage.actions).toEqual(expect.arrayContaining([
      'message:AUTO_TICKET_DIAGNOSTIC:refresh_scheduled',
      'storage:auto-ticket-test-auto-refresh-' + nextSaleTime,
      'message:AUTO_TICKET_DIAGNOSTIC:refresh_triggered',
      'reload',
    ]));
    expect(firstPage.actions.indexOf('message:AUTO_TICKET_DIAGNOSTIC:refresh_scheduled'))
      .toBeLessThan(firstPage.actions.indexOf('storage:auto-ticket-test-auto-refresh-' + nextSaleTime));
    expect(firstPage.actions.indexOf('storage:auto-ticket-test-auto-refresh-' + nextSaleTime))
      .toBeLessThan(firstPage.actions.indexOf('message:AUTO_TICKET_DIAGNOSTIC:refresh_triggered'));
    expect(firstPage.actions.indexOf('message:AUTO_TICKET_DIAGNOSTIC:refresh_triggered'))
      .toBeLessThan(firstPage.actions.indexOf('reload'));

    const reloadedPage = createAutoTicketHarness({ now: refreshAt, storage: firstPage.storage });
    reloadedPage.api.scheduleAutoTicketWindow(nextSaleTime);
    expect(reloadedPage.reloadCount).toBe(0);
    expect(autoTicketDiagnostics(reloadedPage.messages)).toContainEqual({
      type: 'refresh_skipped',
      nextSaleTime,
      timestamp: refreshAt,
      reason: 'already_refreshed',
      details: { refreshAt },
    });

    const followingSaleTime = nextSaleTime + 60 * 60 * 1_000;
    reloadedPage.api.scheduleAutoTicketWindow(followingSaleTime);
    expect(autoTicketDiagnostics(reloadedPage.messages)).toContainEqual({
      type: 'refresh_scheduled',
      nextSaleTime: followingSaleTime,
      timestamp: refreshAt,
      reason: 'timer_scheduled',
      details: {
        refreshAt: followingSaleTime - 30 * 60 * 1_000,
        delayMs: followingSaleTime - 30 * 60 * 1_000 - refreshAt,
      },
    });
  });

  it('skips reload when the per-sale refresh marker cannot be persisted', () => {
    const nextSaleTime = 5_000_000;
    const refreshAt = nextSaleTime - 30 * 60 * 1_000;
    const harness = createAutoTicketHarness({ now: refreshAt, markerWriteFails: true });

    harness.api.scheduleAutoTicketWindow(nextSaleTime);
    harness.advanceTo(refreshAt);

    expect(harness.reloadCount).toBe(0);
    expect(autoTicketDiagnostics(harness.messages)).toContainEqual({
      type: 'refresh_skipped',
      nextSaleTime,
      timestamp: refreshAt,
      reason: 'marker_persist_failed',
      details: { refreshAt },
    });
    expect(autoTicketDiagnostics(harness.messages).some((event) => event.type === 'refresh_triggered')).toBe(false);
  });

  it('prepares three seconds before the compensated first-fetch time', async () => {
    const messages: unknown[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    class FakeDate extends Date {
      static now() { return 1_000; }
    }
    const context = {
      _rt: { latencyMs: 700, clockOffsetMs: 200, autoTimer: null, countdownTimer: null, autoFired: false, nextSaleTime: 0 },
      MSG_CMD: '__cmd',
      Date: FakeDate,
      document: { getElementById: () => null },
      window: { postMessage: (message: unknown) => messages.push(message) },
      setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; },
      clearTimeout: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
    };
    // The VM keeps the MAIN-world timing contract executable without loading
    // the browser bundle into the test process.
    const api = vm.runInNewContext(`${AUTO_SOURCE}; ({ scheduleAutoFire })`, context) as { scheduleAutoFire(nextSaleTime: number): void };

    api.scheduleAutoFire(10_000);
    expect(timers[0]?.delay).toBe(5_090);
    timers[0]?.callback();
    expect(messages).toEqual([{
      __cmd: true,
      type: 'PREFIRE_PREPARE',
      data: expect.objectContaining({
        prepareAtMs: 6_090, fireStartMs: 9_090, startMs: 9_090,
        preparationLeadMs: 3_000, rttCompensationMs: 700, earlyOffsetMs: 10,
      }),
    }]);
  });

  it('executes the prepared auto run through the same one-shot runner contract', async () => {
    const { runner, schedule, started } = makeRunner('auto', 2_100);
    await expect(runner.run()).resolves.toEqual({ accepted: true, reason: 'complete' });
    expect(schedule.startMs).toBe(100);
    expect(started).toEqual([{ shotId: 'first', at: 100 }, { shotId: 'second', at: 2_200 }]);
  });

  it('keeps the configured manual interval and pins burst slots to 500ms', async () => {
    const manual = makeRunner('manual', 3_210);
    const burst = makeRunner('burst', 500);

    await manual.runner.run();
    await burst.runner.run();

    expect(manual.schedule.intervalMs).toBe(3_210);
    expect(manual.started).toEqual([{ shotId: 'first', at: 100 }, { shotId: 'second', at: 3_310 }]);
    expect(burst.schedule.intervalMs).toBe(500);
    expect(burst.started).toEqual([{ shotId: 'first', at: 100 }, { shotId: 'second', at: 600 }]);
  });
});
