import { describe, expect, it } from 'vitest';
import * as vm from 'vm';

import { FireRunner } from '../../../lib/api/fire-runner';
import { buildFireSchedule } from '../../../lib/api/fire-scheduler';
import AUTO_SOURCE from '../../../src/bm-main/07-auto-fire.js?raw';


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
