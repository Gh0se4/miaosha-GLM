import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { buildFireSchedule } from '../../../lib/api/fire-scheduler';

const AUTO_SOURCE = path.resolve(__dirname, '../../../src/bm-main/07-auto-fire.js');
const CONTENT_SOURCE = path.resolve(__dirname, '../../../entrypoints/bm-capture.content.ts');

function source(pathname: string) {
  return fs.readFileSync(pathname, 'utf-8');
}

describe('auto fire prepare-run lifecycle', () => {
  it('prepares three seconds before the compensated first-fetch time', () => {
    const auto = source(AUTO_SOURCE);
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
    const api = vm.runInNewContext(`${auto}; ({ scheduleAutoFire })`, context) as { scheduleAutoFire(nextSaleTime: number): void };

    api.scheduleAutoFire(10_000);

    expect(timers[0]?.delay).toBe(5_100);
    timers[0]?.callback();
    expect(messages).toEqual([{
      __cmd: true,
      type: 'PREFIRE_PREPARE',
      data: expect.objectContaining({ prepareAtMs: 6_100, fireStartMs: 9_100, preparationLeadMs: 3_000 }),
    }]);
  });

  it('routes prepare, manual, and burst requests through the one FireRunner lifecycle', () => {
    const content = source(CONTENT_SOURCE);

    expect(content).toContain("from '../lib/api/fire-scheduler'");
    expect(content).toContain("from '../lib/api/fire-runner'");
    expect(content).toContain('async function prepareAndRun(');
    expect(content).toContain("event.data.type === 'PREFIRE_PREPARE'");
    expect(content).toContain('runId: `auto-${fireStartMs}-${Date.now()}`');
    expect(content).toContain('new FireRunner(');
    expect(content).toContain('maxInFlight: options.mode === \'burst\' ? 2 : 1');
  });

  it('runs auto prepare through the existing preflight status lifecycle exactly once', () => {
    const content = source(CONTENT_SOURCE);
    const start = content.indexOf("if (event.data.type === 'PREFIRE_PREPARE')");
    const end = content.indexOf("if (event.data.type === 'CANCEL_FIRE')", start);
    const prepareHandler = content.slice(start, end);

    expect(prepareHandler).toContain("prefireAndBurst(fireStartMs, 'auto')");
    expect(prepareHandler).not.toContain('getPrefireAuthStatus()');
    expect(prepareHandler).not.toContain('prepareAndRun({');
    expect(content.match(/await runAutoFirePlan\(startMs, authStatus\.headers\)/g)).toHaveLength(1);
  });

  it('keeps configured manual interval and pins burst to 500ms', () => {
    const content = source(CONTENT_SOURCE);

    expect(content).toContain("const intervalMs = options.mode === 'burst' ? 500 : burstIntervalMs");
    expect(content).toContain("burstIntervalMs: mode === 'burst' ? 500 : undefined");
  });

  it('carries the configured manual interval into FireRunner slots', () => {
    const configuredIntervalMs = 3210;
    const schedule = buildFireSchedule({
      runId: 'manual-3210',
      mode: 'manual',
      startMs: 100,
      intervalMs: configuredIntervalMs,
      shots: [
        { shotId: 'first', productId: 'p1', productPriority: 1 },
        { shotId: 'second', productId: 'p2', productPriority: 1 },
      ],
    });

    expect(schedule.intervalMs).toBe(configuredIntervalMs);
    expect(schedule.slots[1]?.plannedAt).toBe(100 + configuredIntervalMs);
  });
});
