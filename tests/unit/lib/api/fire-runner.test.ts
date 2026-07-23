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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCondition(condition: () => boolean, message: string) {
  await vi.waitFor(() => {
    if (!condition()) throw new Error(message);
  }, { interval: 1, timeout: 1_000 });
}

function makeInput(overrides: Partial<FireRunInput> = {}, transportStarts = true) {
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

  const executeShot = input.executeShot;
  input.executeShot = async (ctx) => {
    if (transportStarts) ctx.onFetchStarted({ fetchStartedAt: now });
    return executeShot(ctx);
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
  it.each([
    ['canonical', 'run-1:shot-0', 'run-1:shot-0', 'run-1:shot-0:0'],
    ['local', 's1', 'run-1:s1', 'run-1:s1:0'],
  ])('scopes a %s shot identifier exactly once', async (_kind, shotId, ticketKey, expectedRequestId) => {
    let requestId = '';
    const fixture = makeInput({
      slots: [{ shotId, productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 }],
      executeShot: async (ctx) => {
        requestId = ctx.requestId;
        return { outcome: 'neterr' };
      },
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await runner.run();

    expect({ ticketKey: runner.snapshot()[0]?.ticketKey, requestId }).toEqual({
      ticketKey,
      requestId: expectedRequestId,
    });
  });

  it('rejects local and canonical shot identifiers that collide after run scoping', () => {
    const fixture = makeInput({
      slots: [
        { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
        { shotId: 'run-1:s1', productId: 'p2', productPriority: 1, requestSeq: 1, plannedAt: 0 },
      ],
    });

    expect(() => new FireRunner(fixture.input)).toThrowError('colliding ticketKey "run-1:s1"');
  });

  it('rejects duplicate request sequences at construction', () => {
    const fixture = makeInput({
      slots: [
        { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
        { shotId: 's2', productId: 'p2', productPriority: 1, requestSeq: 0, plannedAt: 0 },
      ],
    });

    expect(() => new FireRunner(fixture.input)).toThrowError('duplicate requestSeq 0');
  });

  it('rejects duplicate final request identifiers at construction', () => {
    const fixture = makeInput({
      slots: [
        { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
        { shotId: 'run-1:s1', productId: 'p2', productPriority: 1, requestSeq: 0, plannedAt: 0 },
      ],
    });

    expect(() => new FireRunner(fixture.input)).toThrowError('duplicate requestId "run-1:s1:0"');
  });

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
    }, false);
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
    const running = runner.run();

    await flush();
    expect(started).toHaveLength(maxInFlight);
    pending.forEach((item) => item.resolve({ outcome: 'neterr' }));
    await running;
  });

  it('caps burst mode at two in-flight shots even when input requests three', async () => {
    const pending = [deferred<{ outcome: Outcome }>(), deferred<{ outcome: Outcome }>(), deferred<{ outcome: Outcome }>()];
    const started: string[] = [];
    const fixture = makeInput({
      mode: 'burst',
      maxInFlight: 3,
      executeShot: async ({ shotId }) => {
        started.push(shotId);
        return pending[Number(shotId.slice(1)) - 1].promise;
      },
    }, false);
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
    const running = runner.run();

    await flush();
    const startedBeforeSettlement = started.length;
    pending.forEach((item) => item.resolve({ outcome: 'neterr' }));
    await running;
    expect(startedBeforeSettlement).toBe(2);
  });

  it.each(['manual', 'auto'] as const)('forces %s mode to one in-flight shot', async (mode) => {
    const pending = [deferred<{ outcome: Outcome }>(), deferred<{ outcome: Outcome }>()];
    const started: string[] = [];
    const fixture = makeInput({
      mode,
      intervalMs: 0,
      maxInFlight: 2,
      slots: [
        { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
        { shotId: 's2', productId: 'p2', productPriority: 1, requestSeq: 1, plannedAt: 0 },
      ],
      executeShot: async ({ shotId }) => {
        started.push(shotId);
        return pending[Number(shotId.slice(1)) - 1].promise;
      },
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
    const running = runner.run();

    await flush();
    const startedBeforeSettlement = [...started];
    pending[0].resolve({ outcome: 'neterr' });
    await flush();
    pending[1].resolve({ outcome: 'neterr' });
    await running;
    expect(startedBeforeSettlement).toEqual(['s1']);
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

  it('consumes a ticket only when the transport reports fetch-started', async () => {
    const started: string[] = [];
    const fixture = makeInput({
      slots: [{ shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 }],
      executeShot: async ({ shotId, onFetchStarted }) => {
        started.push(shotId);
        expect(runner.snapshot()[0]?.state).toBe('released');
        onFetchStarted({ fetchStartedAt: 123 });
        return { outcome: 'neterr' };
      },
    }, false);
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await runner.run();

    expect(started).toEqual(['s1']);
    expect(runner.snapshot()).toMatchObject([{ state: 'settled', fetchStartedAt: 123 }]);
  });

  it('settles an expired released ticket without a fetch and continues with the next slot', async () => {
    const started: string[] = [];
    const fixture = makeInput({
      slots: [
        { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
        { shotId: 's2', productId: 'p2', productPriority: 1, requestSeq: 1, plannedAt: 0 },
      ],
      executeShot: async ({ shotId, onFetchStarted }) => {
        started.push(shotId);
        if (shotId === 's1') return { outcome: 'expired' };
        onFetchStarted({ fetchStartedAt: 25 });
        return { outcome: 'neterr' };
      },
    }, false);
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await runner.run();

    expect(started).toEqual(['s1', 's2']);
    expect(runner.snapshot()).toMatchObject([
      { shotId: 's1', state: 'settled' },
      { shotId: 's2', state: 'settled', fetchStartedAt: 25 },
    ]);
    expect(runner.snapshot()[0]?.fetchStartedAt).toBeUndefined();
    expect(fixture.events
      .filter(({ type }) => type === 'tickets_returned')
      .flatMap(({ payload }) => payload.shotIds as string[]))
      .not.toContain('s1');
  });

  it('returns an in-flight ticket when cancellation happens before transport start and aborts it', async () => {
    const pending = deferred<{ outcome: Outcome }>();
    const abort = vi.fn();
    let requestId = '';
    const fixture = makeInput({
      slots: [{ shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 }],
      executeShot: async (ctx) => {
        requestId = ctx.requestId;
        const { setAbort } = ctx;
        setAbort(abort);
        return pending.promise;
      },
    }, false);
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
    const running = runner.run();

    await flush();
    runner.cancel();
    pending.resolve({ outcome: 'cancelled' });
    await running;

    expect(abort).toHaveBeenCalledTimes(1);
    expect(requestId).toBe('run-1:s1:0');
    expect(runner.snapshot().map(({ state }) => state)).toEqual(['returned']);
  });

  it('aborts immediately when a transport registers after cancellation', async () => {
    const registerAbort = deferred<void>();
    const abort = vi.fn();
    const fixture = makeInput({
      slots: [{ shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 }],
      executeShot: async ({ setAbort }) => {
        await registerAbort.promise;
        setAbort(abort);
        return { outcome: 'cancelled' };
      },
    }, false);
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
    const running = runner.run();

    await waitForCondition(
      () => runner.snapshot()[0]?.state === 'released',
      'shot was not released before cancellation',
    );
    runner.cancel();
    registerAbort.resolve();
    await running;

    expect(abort).toHaveBeenCalledTimes(1);
    expect(runner.snapshot().map(({ state }) => state)).toEqual(['returned']);
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

  it.each([
    ['success', 'waf', 'success'],
    ['waf', 'success', 'waf'],
  ] as const)('keeps the first terminal burst outcome for %s then %s', async (first, second, expected) => {
    const pending = [deferred<{ outcome: Outcome }>(), deferred<{ outcome: Outcome }>()];
    const fixture = makeInput({
      mode: 'burst',
      maxInFlight: 2,
      slots: [
        { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
        { shotId: 's2', productId: 'p2', productPriority: 1, requestSeq: 1, plannedAt: 0 },
      ],
      executeShot: async ({ shotId }) => pending[Number(shotId.slice(1)) - 1].promise,
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
    const running = runner.run();

    await waitForCondition(
      () => runner.snapshot().every(({ state }) => state === 'fetch-started'),
      'burst shots did not both start fetching',
    );
    pending[0].resolve({ outcome: first });
    await waitForCondition(
      () => runner.snapshot()[0]?.state === 'settled',
      'first terminal shot did not settle',
    );
    pending[1].resolve({ outcome: second });

    await expect(running).resolves.toEqual({ accepted: true, reason: expected });
    expect(fixture.events.find(({ type }) => type === 'run_finished')?.payload.reason).toBe(expected);
  });

  it('keeps user cancellation when an in-flight shot reports late success', async () => {
    const pending = deferred<{ outcome: Outcome }>();
    const fixture = makeInput({
      mode: 'burst',
      slots: [{ shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 }],
      executeShot: async () => pending.promise,
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
    const running = runner.run();

    await waitForCondition(
      () => runner.snapshot()[0]?.state === 'fetch-started',
      'shot did not start fetching',
    );
    runner.cancel();
    pending.resolve({ outcome: 'success' });

    await expect(running).resolves.toEqual({ accepted: true, reason: 'cancelled' });
    expect(fixture.events.find(({ type }) => type === 'run_finished')?.payload.reason).toBe('cancelled');
  });

  it.each(['success', 'waf', 'cancelled'] as const)(
    'stops burst while waiting for a future slot after %s settles',
    async (outcome) => {
      const firstShot = deferred<{ outcome: Outcome }>();
      const futureSlot = deferred<void>();
      const started: string[] = [];
      const fixture = makeInput({
        runId: `future-terminal-${outcome}`,
        mode: 'burst',
        maxInFlight: 2,
        slots: [
          { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
          { shotId: 's2', productId: 'p2', productPriority: 1, requestSeq: 1, plannedAt: 100 },
        ],
        executeShot: async ({ shotId }) => {
          started.push(shotId);
          return shotId === 's1' ? firstShot.promise : { outcome: 'neterr' };
        },
      });
      const waitUntil = vi.fn(async (targetMs: number) => {
        await futureSlot.promise;
        fixture.setNow(targetMs);
      });
      const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil });
      let result: Awaited<ReturnType<FireRunner['run']>> | undefined;
      const running = runner.run().then((value) => {
        result = value;
        return value;
      });

      try {
        await waitForCondition(
          () => started.includes('s1') && waitUntil.mock.calls.length === 1,
          'burst runner did not start waiting for the future slot',
        );
        expect(waitUntil).toHaveBeenCalledWith(100);
        firstShot.resolve({ outcome });
        await waitForCondition(
          () => result !== undefined && fixture.events.some(({ type }) => type === 'run_finished'),
          `burst runner did not finish after ${outcome}`,
        );

        expect(result).toEqual({ accepted: true, reason: outcome });
        expect(started).toEqual(['s1']);
        expect(fixture.events.filter(({ type }) => type === 'shot_released').map(({ payload }) => payload.shotId)).toEqual(['s1']);
        expect(runner.snapshot().map(({ state }) => state)).toEqual(['settled', 'returned']);
      } finally {
        firstShot.resolve({ outcome });
        futureSlot.resolve();
        await running;
      }
    },
  );

  it('keeps a future burst slot gated after a non-terminal in-flight result', async () => {
    const firstShot = deferred<{ outcome: Outcome }>();
    const futureSlot = deferred<void>();
    const started: string[] = [];
    const fixture = makeInput({
      mode: 'burst',
      maxInFlight: 2,
      slots: [
        { shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 },
        { shotId: 's2', productId: 'p2', productPriority: 1, requestSeq: 1, plannedAt: 100 },
      ],
      executeShot: async ({ shotId }) => {
        started.push(shotId);
        return shotId === 's1' ? firstShot.promise : { outcome: 'neterr' };
      },
    });
    const runner = new FireRunner(fixture.input, {
      now: fixture.now,
      waitUntil: async (targetMs) => {
        await futureSlot.promise;
        fixture.setNow(targetMs);
      },
    });
    let finished = false;
    const running = runner.run().then((value) => {
      finished = true;
      return value;
    });

    await flush();
    firstShot.resolve({ outcome: 'neterr' });
    await flush();
    await flush();
    const startedBeforeSlot = [...started];
    const finishedBeforeSlot = finished;
    const releaseTimesBeforeSlot = runner.snapshot().map(({ releasedAt }) => releasedAt);

    futureSlot.resolve();
    await running;

    expect(startedBeforeSlot).toEqual(['s1']);
    expect(finishedBeforeSlot).toBe(false);
    expect(releaseTimesBeforeSlot).toEqual([0, undefined]);
    expect(started).toEqual(['s1', 's2']);
    expect(runner.snapshot().map(({ releasedAt }) => releasedAt)).toEqual([0, 100]);
  });

  it('drains fetch-started shots before finishing after a terminal outcome', async () => {
    for (const outcome of ['success', 'waf', 'cancelled'] as const) {
      const pending = [deferred<{ outcome: Outcome }>(), deferred<{ outcome: Outcome }>()];
      const fixture = makeInput({
        runId: `terminal-${outcome}`,
        mode: 'burst',
        maxInFlight: 2,
        executeShot: async ({ shotId }) => pending[Number(shotId.slice(1)) - 1].promise,
      });
      const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });
      const running = runner.run();

      await flush();
      const firstSettled = deferred<void>();
      fixture.input.onStateChange = (snapshot) => {
        if (snapshot[0]?.state === 'settled') firstSettled.resolve();
      };
      pending[0].resolve({ outcome });
      await firstSettled.promise;
      await flush();
      const contender = makeInput({ runId: `contender-${outcome}`, slots: [] });
      const contenderRunner = new FireRunner(contender.input, { now: contender.now, waitUntil: contender.waitUntil });
      const contenderResult = await contenderRunner.run();
      const finishedBeforeDrain = fixture.events.map(({ type }) => type).includes('run_finished');

      pending[1].resolve({ outcome: 'neterr' });
      await running;
      expect(contenderResult).toEqual({ accepted: false, reason: 'run_locked' });
      expect(finishedBeforeDrain).toBe(false);
      expect(fixture.events.map(({ type }) => type)).toContain('run_finished');
      expect(runner.snapshot().map(({ state }) => state)).toEqual(['settled', 'settled', 'returned']);
      await expect(contenderRunner.run()).resolves.toEqual({ accepted: true, reason: 'complete' });
    }
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
    expect(fixture.events.map(({ type }) => type)).not.toContain('run_finished');
    expect(runner.snapshot().map(({ state }) => state)).toEqual(['fetch-started', 'fetch-started', 'reserved']);
    pending.forEach((item) => item.resolve({ outcome: 'cancelled' }));
    await running;
    expect(runner.snapshot().map(({ shotId, state }) => ({ shotId, state }))).toEqual([
      { shotId: 's1', state: 'settled' },
      { shotId: 's2', state: 'settled' },
      { shotId: 's3', state: 'returned' },
    ]);
  });

  it('returns every reserved ticket when cancelled before any fetch starts', async () => {
    const fixture = makeInput({
      slots: [{ shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 100 }],
    });
    const runner = new FireRunner(fixture.input, {
      now: fixture.now,
      waitUntil: async () => new Promise<void>(() => {}),
    });
    const running = runner.run();

    await flush();
    runner.cancel();
    await running;
    expect(fixture.starts).toEqual([]);
    expect(runner.snapshot().map(({ state }) => state)).toEqual(['returned']);
    expect(fixture.events.find(({ type }) => type === 'tickets_returned')?.payload).toMatchObject({
      shots: [{ shotId: 's1', plannedAt: 100, terminalUnsentReason: 'cancelled' }],
    });
  });

  it('returns a released ticket when its observer cancels before fetch starts', async () => {
    const events: string[] = [];
    const calls: string[] = [];
    let runner!: FireRunner;
    const fixture = makeInput({
      slots: [{ shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 0 }],
      onEvent: ({ type }) => {
        events.push(type);
        if (type === 'shot_released') runner.cancel();
      },
      executeShot: async ({ shotId }) => {
        calls.push(shotId);
        return { outcome: 'neterr' };
      },
    });
    runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await runner.run();
    expect(calls).toEqual([]);
    expect(events).not.toContain('fetch_started');
    expect(runner.snapshot().map(({ state }) => state)).toEqual(['returned']);
    expect(events).toContain('run_finished');
  });

  it.each(['cancelled', 'waf'] as const)('%s stops and returns future tickets', async (outcome) => {
    const fixture = makeInput({
      mode: 'burst',
      maxInFlight: 1,
      executeShot: async () => ({ outcome }),
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await runner.run();
    expect(runner.snapshot().map(({ state }) => state)).toEqual(['settled', 'returned', 'returned']);
  });

  it.each([
    ['event', { onEvent: () => { throw new Error('observer failed'); } }],
    ['state', { onStateChange: () => { throw new Error('observer failed'); } }],
  ] as const)('keeps cleanup and lock release when %s observer throws', async (_kind, callbacks) => {
    const fixture = makeInput({
      mode: 'burst',
      maxInFlight: 1,
      executeShot: async () => ({ outcome: 'success' }),
      ...callbacks,
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await expect(runner.run()).resolves.toEqual({ accepted: true, reason: 'success' });
    expect(runner.snapshot().map(({ state }) => state)).toEqual(['settled', 'returned', 'returned']);
    const next = makeInput({ runId: `after-${_kind}`, slots: [] });
    await expect(new FireRunner(next.input).run()).resolves.toEqual({ accepted: true, reason: 'complete' });
  });

  it('continues when executeShot rejects unexpectedly', async () => {
    const calls: string[] = [];
    const fixture = makeInput({
      executeShot: async ({ shotId }) => {
        calls.push(shotId);
        if (shotId === 's1') throw new Error('transport failed');
        return { outcome: 'neterr' };
      },
    });
    const runner = new FireRunner(fixture.input, { now: fixture.now, waitUntil: fixture.waitUntil });

    await runner.run();
    expect(calls).toEqual(['s1', 's2', 's3']);
    expect(runner.snapshot().every(({ state }) => state === 'settled')).toBe(true);
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

  it('uses the injected now clock for default wait duration', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const fixture = makeInput({
        slots: [{ shotId: 's1', productId: 'p1', productPriority: 1, requestSeq: 0, plannedAt: 11_000 }],
      });
      const runner = new FireRunner(fixture.input, { now: () => 10_000 });
      const running = runner.run();

      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      const startedAfterOneSecond = fixture.starts.map(({ shotId }) => shotId);
      runner.cancel();
      await running;
      expect(startedAfterOneSecond).toEqual(['s1']);
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
