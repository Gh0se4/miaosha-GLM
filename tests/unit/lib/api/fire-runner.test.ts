import { describe, expect, it, vi } from 'vitest';

import { FireRunner, type FireRunInput } from '../../../../lib/api/fire-runner';

type Outcome = Awaited<ReturnType<FireRunInput['executeShot']>>['outcome'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function makeInput(overrides: Partial<FireRunInput> = {}) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const starts: Array<{ shotId: string; at: number }> = [];
  let now = 0;
  const input: FireRunInput = {
    runId: 'run-1',
    mode: 'manual',
    startMs: 0,
    intervalMs: 50,
    maxInFlight: 1,
    slots: [
      { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
      { shotId: 's2', productId: 'p2', productPriority: 1, requestSeq: 1, plannedAt: 0 },
      { shotId: 's3', productId: 'p3', productPriority: 1, requestSeq: 2, plannedAt: 0 },
    ],
    onEvent: (event) => events.push(event),
    executeShot: async ({ shotId }) => {
      starts.push({ shotId, at: now });
      return { outcome: 'neterr' };
    },
    ...overrides,
  };

  return {
    input,
    events,
    starts,
    now: () => now,
    setNow: (value: number) => { now = value; },
    waitUntil: async (target: number) => { now = target; },
  };
}

describe('FireRunner', () => {
  it('rejects a second run before it reserves or schedules tickets', async () => {
    const firstShot = deferred<{ outcome: Outcome }>();
    const first = makeInput({
      executeShot: async () => firstShot.promise,
      slots: [{ shotId: 'first', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 }],
    });
    const second = makeInput({
      runId: 'run-2',
      slots: [{ shotId: 'second', productId: 'p2', productPriority: 1, requestSeq: 0, plannedAt: 0 }],
    });
    const runnerOne = new FireRunner(first.input, { now: first.now, waitUntil: first.waitUntil });
    const runnerTwo = new FireRunner(second.input, { now: second.now, waitUntil: second.waitUntil });

    const active = runnerOne.run();
    await flush();
    await expect(runnerTwo.run()).resolves.toEqual({ accepted: false, reason: 'run_locked' });
    expect(second.events.map(({ type }) => type)).toEqual(['run_rejected']);
    expect(second.starts).toEqual([]);
    expect(runnerTwo.snapshot().map(({ state }) => state)).toEqual(['available']);

    firstShot.resolve({ outcome: 'neterr' });
    await active;
  });

  it.each([1, 2])('limits burst mode to maxInFlight=%s', async (maxInFlight) => {
    const pending = [deferred<{ outcome: Outcome }>(), deferred<{ outcome: Outcome }>(), deferred<{ outcome: Outcome }>()];
    const started: string[] = [];
    const fixture = makeInput({
      mode: 'burst',
      maxInFlight,
      executeShot: async ({ shotId }) => {
        started.push(shotId);
        return pending[Number(shotId.slice(1)) - 1].promise;
      },
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
    const running = runner.run();

    await flush();
    expect(started).toHaveLength(maxInFlight);
    pending.forEach((item) => item.resolve({ outcome: 'neterr' }));
    await running;
  });

  it('anchors manual starts to the previous fetch-started time plus interval', async () => {
    const fixture = makeInput({
      slots: [
        { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
        { shotId: 's2', productId: 'p2', productPriority: 1, requestSeq: 1, plannedAt: 10 },
      ],
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await runner.run();
    expect(fixture.starts).toEqual([{ shotId: 's1', at: 0 }, { shotId: 's2', at: 50 }]);
  });

  it('success stops and returns unsent tickets', async () => {
    const fixture = makeInput({
      mode: 'burst',
      executeShot: async () => ({ outcome: 'success' }),
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await runner.run();
    expect(runner.snapshot().map(({ shotId, state }) => ({ shotId, state }))).toEqual([
      { shotId: 's1', state: 'settled' },
      { shotId: 's2', state: 'returned' },
      { shotId: 's3', state: 'returned' },
    ]);
    expect(fixture.events.map(({ type }) => type)).toContain('tickets_returned');
    expect(fixture.events.map(({ type }) => type)).toContain('run_finished');
  });

  it('returns only tickets that had not started fetching when cancelled', async () => {
    const pending = [deferred<{ outcome: Outcome }>(), deferred<{ outcome: Outcome }>()];
    const fixture = makeInput({
      mode: 'burst',
      maxInFlight: 2,
      executeShot: async ({ shotId }) => pending[Number(shotId.slice(1)) - 1].promise,
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
    const running = runner.run();

    await flush();
    runner.cancel();
    await running;
    expect(runner.snapshot().map(({ shotId, state }) => ({ shotId, state }))).toEqual([
      { shotId: 's1', state: 'fetch-started' },
      { shotId: 's2', state: 'fetch-started' },
      { shotId: 's3', state: 'returned' },
    ]);
    pending.forEach((item) => item.resolve({ outcome: 'cancelled' }));
  });

  it('clears its pending default timer when cancelled', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const fixture = makeInput({
        slots: [{ shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: now + 1_000 }],
      });
      const runner = new FireRunner(fixture.input);
      const running = runner.run();

      await flush();
      expect(vi.getTimerCount()).toBe(1);
      runner.cancel();
      await running;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues after neterr outcomes', async () => {
    const fixture = makeInput();
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await runner.run();
    expect(fixture.starts.map(({ shotId }) => shotId)).toEqual(['s1', 's2', 's3']);
    expect(runner.snapshot().every(({ state }) => state === 'settled')).toBe(true);
  });
});
