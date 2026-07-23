import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';
import { loadBmMainModules } from './_harness';

type FireLogStore = {
  writeSession(record: Record<string, unknown>): Promise<Record<string, unknown>>;
  writeRun(record: Record<string, unknown>): Promise<Record<string, unknown>>;
  writeEvent(record: Record<string, unknown>): Promise<Record<string, unknown>>;
  writeShot(record: Record<string, unknown>): Promise<Record<string, unknown>>;
  readAll(sessionId?: string): Promise<{ session: Record<string, unknown>; runs: Record<string, unknown>[]; events: Record<string, unknown>[]; shots: Record<string, unknown>[] }>;
  exportLog(sessionId: string): Promise<Record<string, unknown>>;
};

let idbFactory: IDBFactory;

function makeStore(dbName: string, options: Record<string, unknown> = {}) {
  const scope = loadBmMainModules(['11-fire-log-store']) as Record<string, unknown>;
  const create = scope.createFireLogStore as (opts: Record<string, unknown>) => FireLogStore;
  return create({ dbName, indexedDB: idbFactory, extensionVersion: '9.8.7', ...options });
}

function makeSessionStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function loadFireLogger(options: {
  namespace: string;
  sessionStorage: ReturnType<typeof makeSessionStorage>;
  nowMs: number;
  navigationType?: string;
  randomUUID?: () => string;
}) {
  class FixedDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? options.nowMs : value); }
    static now() { return options.nowMs; }
  }
  const window: Record<string, unknown> = {
    addEventListener: () => {},
    postMessage: () => {},
  };
  const performance: Record<string, unknown> = { now: () => 1 };
  if (options.navigationType !== undefined) {
    performance.getEntriesByType = (type: string) => type === 'navigation' ? [{ type: options.navigationType }] : [];
  }
  const scope = vm.createContext({
    window, _NS: options.namespace, MSG_OVL: '__overlay',
    document: { visibilityState: 'visible', addEventListener: () => {} },
    sessionStorage: options.sessionStorage,
    navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' },
    Intl, Date: FixedDate, Math, Promise, performance,
    crypto: options.randomUUID ? { randomUUID: options.randomUUID } : undefined,
    setTimeout: () => 0, postToOverlay: () => {},
  });
  vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main/12-fire-log.js'), 'utf8'), scope);
  return { scope, window };
}

describe('Fire Log V2 store', () => {
  let dbName: string;

  beforeEach(() => {
    dbName = 'fire-log-test-' + Math.random().toString(36).slice(2);
    idbFactory = new IDBFactory();
  });

  it('creates namespace-scoped high-entropy session IDs for new tabs opened in the same millisecond', () => {
    const nowMs = Date.parse('2026-07-23T07:08:09.456Z');
    let uuidSequence = 0;
    const randomUUID = () => '00000000-0000-4000-8000-' + String(++uuidSequence).padStart(12, '0');
    const first = loadFireLogger({ namespace: 'same-ns-', sessionStorage: makeSessionStorage(), nowMs, navigationType: 'navigate', randomUUID });
    const second = loadFireLogger({ namespace: 'same-ns-', sessionStorage: makeSessionStorage(), nowMs, navigationType: 'navigate', randomUUID });

    expect(first.scope._log_sessionId).not.toBe(second.scope._log_sessionId);
    expect(first.scope._log_sessionId).toContain('same-ns-');
    expect(second.scope._log_sessionId).toContain('same-ns-');
    expect(first.scope._log_sessionId).toContain('456');
  });

  it('persists a new session immediately and restores its ID on a real reload', () => {
    const sessionStorage = makeSessionStorage();
    const first = loadFireLogger({
      namespace: 'reload-', sessionStorage, nowMs: Date.parse('2026-07-23T07:08:09.456Z'),
      navigationType: 'navigate', randomUUID: () => 'first-session-random',
    });
    const saved = JSON.parse(sessionStorage.getItem('reload-lg') || 'null');

    expect(saved).toMatchObject({ sessionId: first.scope._log_sessionId, entries: [], shotSeq: 0 });

    const reloaded = loadFireLogger({
      namespace: 'reload-', sessionStorage, nowMs: Date.parse('2026-07-23T07:09:10.789Z'),
      navigationType: 'reload', randomUUID: () => 'must-not-be-used',
    });
    expect(reloaded.scope._log_sessionId).toBe(first.scope._log_sessionId);
  });

  it('starts clean when a new navigation receives cloned opener sessionStorage', () => {
    const sessionStorage = makeSessionStorage({
      'clone-lg': JSON.stringify({
        sessionId: 'cloned-session', sessionStartAt: '2026-07-23T00:00:00.000Z',
        initialVisibilityState: 'hidden', entries: [{ seq: 7, outcome: 'error' }], shotSeq: 7, waveCount: 3,
      }),
    });
    const loaded = loadFireLogger({
      namespace: 'clone-', sessionStorage, nowMs: Date.parse('2026-07-23T07:08:09.456Z'),
      navigationType: 'navigate', randomUUID: () => 'new-tab-random',
    });

    expect(loaded.scope._log_sessionId).not.toBe('cloned-session');
    expect((loaded.window.__fireLogEntries as () => unknown[])()).toEqual([]);
    expect(loaded.scope._log_shotSeq).toBe(0);
    expect(loaded.scope._log_waveCount).toBe(0);
    expect(JSON.parse(sessionStorage.getItem('clone-lg') || 'null')).toMatchObject({
      sessionId: loaded.scope._log_sessionId, entries: [], shotSeq: 0, waveCount: 0,
    });
  });

  it('keeps legacy harness restore semantics when navigation timing is unavailable', () => {
    const sessionStorage = makeSessionStorage({
      'legacy-lg': JSON.stringify({ sessionId: 'legacy-session', entries: [{ seq: 2 }], shotSeq: 2, waveCount: 1 }),
    });
    const loaded = loadFireLogger({ namespace: 'legacy-', sessionStorage, nowMs: Date.now() });

    expect(loaded.scope._log_sessionId).toBe('legacy-session');
    expect((loaded.window.__fireLogEntries as () => unknown[])()).toHaveLength(1);
    expect(loaded.scope._log_shotSeq).toBe(2);
  });

  it('restores persisted records after store reinitialization', async () => {
    const first = makeStore(dbName);
    await first.writeSession({ sessionId: 's-1', startedAt: '2026-07-19T00:00:00.000Z' });
    await first.writeRun({ runId: 'r-1', sessionId: 's-1', mode: 'manual' });
    await first.writeEvent({ eventId: 'e-1', sessionId: 's-1', type: 'started' });
    await first.writeShot({ shotId: 'sh-1', sessionId: 's-1', runId: 'r-1' });

    const restored = makeStore(dbName);
    expect(await restored.readAll('s-1')).toMatchObject({
      session: { sessionId: 's-1' },
      runs: [{ runId: 'r-1' }],
      events: [{ eventId: 'e-1' }],
      shots: [{ shotId: 'sh-1' }],
    });
  });

  it('recursively preserves database-only fields when fallback records share a key or event sequence', async () => {
    let failWrites = false;
    const failingWritesIdb = {
      open(name: string, version?: number) {
        const request = idbFactory.open(name, version);
        request.addEventListener('success', () => {
          const db = request.result;
          const transaction = db.transaction.bind(db);
          db.transaction = ((storeName: string, mode?: IDBTransactionMode) => {
            if (failWrites && mode === 'readwrite') throw new Error('simulated fallback write');
            return transaction(storeName, mode);
          }) as typeof db.transaction;
        });
        return request;
      },
    };
    const store = makeStore(dbName, { indexedDB: failingWritesIdb });
    await store.writeSession({ sessionId: 's-1', dbOnly: { session: true } });
    await store.writeRun({ runId: 'r-1', sessionId: 's-1', dbOnly: { run: true } });
    const event = await store.writeEvent({ eventId: 'e-1', sessionId: 's-1', dbOnly: { event: true } });
    await store.writeShot({ shotId: 'sh-1', sessionId: 's-1', dbOnly: { shot: true }, dbArray: ['db'] });

    failWrites = true;
    await store.writeSession({ sessionId: 's-1', fallbackOnly: { session: true } });
    await store.writeRun({ runId: 'r-1', sessionId: 's-1', fallbackOnly: { run: true } });
    await store.writeEvent({ sequence: event.sequence, eventId: 'e-1', sessionId: 's-1', fallbackOnly: { event: true } });
    await store.writeShot({ shotId: 'sh-1', sessionId: 's-1', fallbackOnly: { shot: true }, dbArray: ['fallback'] });

    expect(await store.exportLog('s-1')).toMatchObject({
      session: { dbOnly: { session: true }, fallbackOnly: { session: true } },
      runs: [{ dbOnly: { run: true }, fallbackOnly: { run: true } }],
      events: [{ dbOnly: { event: true }, fallbackOnly: { event: true } }],
      shots: [{ dbOnly: { shot: true }, fallbackOnly: { shot: true }, dbArray: ['db', 'fallback'] }],
    });
  });

  it('absorbs fail-once fallback records when the same durable keys recover', async () => {
    const durable = makeStore(dbName);
    await durable.writeSession({ sessionId: 's-recover', dbOnly: { session: true }, state: 'created' });
    await durable.writeRun({ runId: 'r-recover', sessionId: 's-recover', dbOnly: { run: true }, status: 'created' });
    await durable.writeShot({ shotId: 'sh-recover', sessionId: 's-recover', dbOnly: { shot: true }, outcome: 'created' });

    const failFirstWrite = new Set(['sessions', 'runs', 'shots']);
    const failOnceIdb = {
      open(name: string, version?: number) {
        const request = idbFactory.open(name, version);
        request.addEventListener('success', () => {
          const db = request.result;
          const transaction = db.transaction.bind(db);
          db.transaction = ((storeNames: string | string[], mode?: IDBTransactionMode) => {
            const storeName = typeof storeNames === 'string' ? storeNames : storeNames[0];
            if (mode === 'readwrite' && failFirstWrite.delete(storeName)) throw new Error('simulated fail-once write');
            return transaction(storeNames, mode);
          }) as typeof db.transaction;
        });
        return request;
      },
    };
    const recovering = makeStore(dbName, { indexedDB: failOnceIdb });
    await recovering.writeSession({ sessionId: 's-recover', fallbackOnly: { session: true }, state: 'pending' });
    await recovering.writeRun({ runId: 'r-recover', sessionId: 's-recover', fallbackOnly: { run: true }, status: 'pending' });
    await recovering.writeShot({ shotId: 'sh-recover', sessionId: 's-recover', fallbackOnly: { shot: true }, outcome: 'error' });

    await recovering.writeSession({ sessionId: 's-recover', currentOnly: { session: true }, state: 'finished' });
    await recovering.writeRun({ runId: 'r-recover', sessionId: 's-recover', currentOnly: { run: true }, status: 'finished' });
    await recovering.writeShot({ shotId: 'sh-recover', sessionId: 's-recover', currentOnly: { shot: true }, outcome: 'success' });

    const expected = {
      session: {
        dbOnly: { session: true }, fallbackOnly: { session: true }, currentOnly: { session: true }, state: 'finished',
      },
      runs: [{ dbOnly: { run: true }, fallbackOnly: { run: true }, currentOnly: { run: true }, status: 'finished' }],
      shots: [{ dbOnly: { shot: true }, fallbackOnly: { shot: true }, currentOnly: { shot: true }, outcome: 'success' }],
    };
    expect(await recovering.exportLog('s-recover')).toMatchObject(expected);
    expect(await makeStore(dbName).exportLog('s-recover')).toMatchObject(expected);
  });

  it('keeps only concurrent fallback deltas after an in-flight recovery commits', async () => {
    let shotWriteAttempt = 0;
    const controlledIdb = {
      open(name: string, version?: number) {
        const request = idbFactory.open(name, version);
        request.addEventListener('success', () => {
          const db = request.result;
          const transaction = db.transaction.bind(db);
          db.transaction = ((storeNames: string | string[], mode?: IDBTransactionMode) => {
            const storeName = typeof storeNames === 'string' ? storeNames : storeNames[0];
            if (storeName === 'shots' && mode === 'readwrite') {
              shotWriteAttempt++;
              if (shotWriteAttempt === 1 || shotWriteAttempt === 3) throw new Error('simulated fallback update');
            }
            return transaction(storeNames, mode);
          }) as typeof db.transaction;
        });
        return request;
      },
    };
    const store = makeStore(dbName, { indexedDB: controlledIdb });
    await store.writeShot({ shotId: 'sh-concurrent', sessionId: 's-1', outcome: 'error', fallbackBeforeRecovery: true });

    const recovery = store.writeShot({ shotId: 'sh-concurrent', sessionId: 's-1', outcome: 'success', recovered: true });
    const concurrentFallback = store.writeShot({ shotId: 'sh-concurrent', sessionId: 's-1', concurrentOnly: true });
    await Promise.all([recovery, concurrentFallback]);

    expect(await store.exportLog('s-1')).toMatchObject({
      shots: [{ outcome: 'success', recovered: true, concurrentOnly: true }],
    });

    await store.writeShot({ shotId: 'sh-concurrent', sessionId: 's-1', outcome: 'success', finalized: true });
    expect(await makeStore(dbName).exportLog('s-1')).toMatchObject({
      shots: [{ outcome: 'success', recovered: true, concurrentOnly: true, finalized: true }],
    });
  });

  it('merges database and fallback records without dropping either source', async () => {
    const failingShotsIdb = {
      open(name: string, version?: number) {
        const request = idbFactory.open(name, version);
        request.addEventListener('success', () => {
          const db = request.result;
          const transaction = db.transaction.bind(db);
          db.transaction = ((storeName: string, mode?: IDBTransactionMode) => {
            if (storeName === 'shots') throw new Error('simulated shot transaction failure');
            return transaction(storeName, mode);
          }) as typeof db.transaction;
        });
        return request;
      },
    };
    const store = makeStore(dbName, { indexedDB: failingShotsIdb });
    await store.writeSession({ sessionId: 's-1' });
    await store.writeRun({ runId: 'db-run', sessionId: 's-1' });
    await store.writeShot({ shotId: 'fallback-shot', sessionId: 's-1' });

    const exported = await store.exportLog('s-1');
    expect(exported).toMatchObject({
      runs: [{ runId: 'db-run' }],
      shots: [{ shotId: 'fallback-shot' }],
    });
  });

  it('assigns consecutive event sequences', async () => {
    const store = makeStore(dbName);
    const one = await store.writeEvent({ eventId: 'e-1', sessionId: 's-1', type: 'first' });
    const two = await store.writeEvent({ eventId: 'e-2', sessionId: 's-1', type: 'second' });

    expect(two.sequence).toBe((one.sequence as number) + 1);
  });

  it('preserves fields across incremental successful writes with the same keys', async () => {
    const store = makeStore(dbName);
    await store.writeSession({ sessionId: 's-1', initial: 'session' });
    await store.writeSession({ sessionId: 's-1', updated: 'session' });
    await store.writeRun({ runId: 'r-1', sessionId: 's-1', initial: 'run' });
    await store.writeRun({ runId: 'r-1', sessionId: 's-1', updated: 'run' });
    await store.writeShot({ shotId: 'sh-1', sessionId: 's-1', initial: 'shot' });
    await store.writeShot({ shotId: 'sh-1', sessionId: 's-1', updated: 'shot' });

    expect(await store.exportLog('s-1')).toMatchObject({
      session: { initial: 'session', updated: 'session' },
      runs: [{ initial: 'run', updated: 'run' }],
      shots: [{ initial: 'shot', updated: 'shot' }],
    });
  });

  it('keeps a record in fallback when a write request succeeds but its transaction aborts', async () => {
    const abortingIdb = {
      open(name: string, version?: number) {
        const request = idbFactory.open(name, version);
        request.addEventListener('success', () => {
          const db = request.result;
          const transaction = db.transaction.bind(db);
          db.transaction = ((storeName: string, mode?: IDBTransactionMode) => {
            const tx = transaction(storeName, mode);
            if (storeName !== 'shots' || mode !== 'readwrite') return tx;
            const objectStore = tx.objectStore.bind(tx);
            tx.objectStore = ((name: string) => {
              const store = objectStore(name);
              const put = store.put.bind(store);
              store.put = ((record: Record<string, unknown>) => {
                const write = put(record);
                write.addEventListener('success', () => tx.abort());
                return write;
              }) as typeof store.put;
              return store;
            }) as typeof tx.objectStore;
            return tx;
          }) as typeof db.transaction;
        });
        return request;
      },
    };
    const store = makeStore(dbName, { indexedDB: abortingIdb });
    await expect(store.writeShot({ shotId: 'sh-abort', sessionId: 's-1' })).resolves.toMatchObject({ shotId: 'sh-abort' });
    expect(await store.exportLog('s-1')).toMatchObject({ shots: [{ shotId: 'sh-abort' }] });
  });

  it('omits sensitive headers recursively while preserving bodies', async () => {
    const store = makeStore(dbName);
    await store.writeShot({
      shotId: 'sh-1', sessionId: 's-1', ticket: 'keep-ticket', randstr: 'keep-randstr',
      request: { headers: { Authorization: 'secret', 'x-keep': 'yes', Cookie: 'cookie' }, body: '{"keep":true}' },
      response: { Headers: { 'Set-Cookie': 'secret', 'X-Response': 'yes' }, body: 'response-body' },
      nested: { headers: [['Proxy-Authorization', 'secret'], ['X-Nested', 'yes']] },
    });

    const data = await store.readAll('s-1');
    expect(data.shots[0]).toMatchObject({
      ticket: 'keep-ticket', randstr: 'keep-randstr',
      request: { headers: { 'x-keep': 'yes' }, body: '{"keep":true}' },
      response: { Headers: { 'X-Response': 'yes' }, body: 'response-body' },
      nested: { headers: [['X-Nested', 'yes']] },
    });
  });

  it('exports the V2 root shape with injected runtime version', async () => {
    const store = makeStore(dbName);
    await store.writeSession({ sessionId: 's-1' });
    const exported = await store.exportLog('s-1');

    expect(exported).toMatchObject({
      schemaVersion: 2,
      extensionVersion: '9.8.7',
      session: { sessionId: 's-1' },
      runs: [], events: [], shots: [],
    });
    expect(typeof exported.exportedAt).toBe('string');
  });

  it('records a full run and shot lifecycle from the content compatibility messages', async () => {
    const listeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
    const window: Record<string, unknown> = {
      addEventListener: (_type: string, listener: (event: { data: Record<string, unknown> }) => void) => listeners.push(listener),
      postMessage: () => {},
    };
    const scope = vm.createContext({
      window, _NS: 'lifecycle-', MSG_OVL: '__overlay', indexedDB: idbFactory,
      document: { visibilityState: 'visible', addEventListener: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' },
      Intl, Date, Math, Promise, performance: { now: () => 1 }, setTimeout: () => 0,
      postToOverlay: () => {},
    });
    for (const name of ['11-fire-log-store.js', '12-fire-log.js']) {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
    }
    const emit = (type: string, data: Record<string, unknown>) => {
      for (const listener of listeners) listener({ data: { __overlay: true, type, data } });
    };

    emit('FIRE_LOG_V2_RUN', {
      runId: 'run-1', mode: 'manual', targetAt: 1000, preparationStartedAt: 900,
      startMs: 1000, intervalMs: 2100, maxInFlight: 1,
      products: [{ productId: 'product-1', priority: 1 }],
    });
    emit('FIRE_LOG_V2_EVENT', { type: 'tickets_reserved', runId: 'run-1', count: 1 });
    emit('FIRE_LOG_V2_EVENT', {
      type: 'shot_released', runId: 'run-1', shotId: 'shot-1', requestSeq: 0, plannedAt: 1000, scheduledAt: 1002,
    });
    emit('FIRE_LOG_V2_EVENT', {
      type: 'fetch_started', runId: 'run-1', shotId: 'shot-1', requestSeq: 0,
      plannedAt: 1000, timing: { bridgeReceivedAt: 1003, fetchCalledAt: 1004 },
    });
    emit('FIRE_SHOT_RESULT', {
      runId: 'run-1', shotId: 'shot-1', shotIdx: 0, productId: 'product-1', priority: 1,
      ticket: 'full-ticket', randstr: 'full-randstr', plannedAt: 1000, requestSeq: 0,
      outcome: 'busy', httpStatus: 555, statusText: 'Busy', rtt: 12,
      queueDelayMs: 4,
      request: { method: 'POST', url: 'https://bigmodel.cn/api/biz/pay/preview', headers: { Authorization: 'secret', 'X-Trace': 'keep' }, body: '{"ticket":"full-ticket"}' },
      response: { headers: { 'Set-Cookie': 'secret', 'X-Response': 'keep' }, body: 'x'.repeat(800) },
      timing: { bridgeReceivedAt: 1003, fetchCalledAt: 1004, responseHeadersAt: 1008, bodyCompletedAt: 1012 },
    });
    emit('FIRE_SHOT_RESULT', {
      runId: 'run-1', shotId: 'shot-normal', shotIdx: 1, productId: 'product-2', priority: 2,
      ticket: 'full-ticket-2', randstr: 'full-randstr-2', plannedAt: 2000, releasedAt: 2000, requestSeq: 1,
      outcome: 'soldout', httpStatus: 200, statusText: 'OK', rtt: 0,
      queueDelayMs: 0,
      timing: { bridgeReceivedAt: 2000, fetchCalledAt: 2000, responseHeadersAt: 2000, bodyCompletedAt: 2000 },
    });
    emit('FIRE_LOG_V2_EVENT', { type: 'run_finished', runId: 'run-1', reason: 'complete' });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const report = await (window.__fireLogV2Store as FireLogStore).exportLog('');
    expect(report.schemaVersion).toBe(2);
    expect(report.runs).toHaveLength(1);
    expect((report.runs as Array<Record<string, unknown>>)[0]).toMatchObject({ runId: 'run-1', maxInFlight: 1 });
    expect((report.events as Array<Record<string, unknown>>).map((event) => event.type)).toEqual(expect.arrayContaining(['tickets_reserved', 'shot_released', 'fetch_started', 'run_finished']));
    expect(report.shots).toHaveLength(2);
    expect((report.shots as Array<Record<string, unknown>>).find((shot) => shot.shotId === 'shot-1')).toMatchObject({
      runId: 'run-1', shotId: 'shot-1', plannedAt: 1000, requestSeq: 0,
      httpStatus: 555, statusText: 'Busy', ticket: 'full-ticket', randstr: 'full-randstr',
      request: { method: 'POST', headers: { 'X-Trace': 'keep' } },
      response: { headers: { 'X-Response': 'keep' }, body: 'x'.repeat(800) },
      timing: { fetchCalledAt: 1004 },
      scheduleErrorMs: 4,
      queueDelayMs: 4,
      bridgeWaitMs: 1,
      fetchToHeadersMs: 4,
      responseBodyMs: 4,
      transportTotalMs: 9,
    });
    expect((report.shots as Array<Record<string, unknown>>).find((shot) => shot.shotId === 'shot-normal')).toMatchObject({
      scheduleErrorMs: 0,
      queueDelayMs: 0,
      bridgeWaitMs: 0,
      fetchToHeadersMs: 0,
      responseBodyMs: 0,
      transportTotalMs: 0,
    });
  });

  it('keeps cancelled unsent shots free of fabricated schedule or transport metrics', async () => {
    const store = makeStore(dbName);
    await store.writeShot({
      shotId: 'unsent-1', sessionId: 's-1', runId: 'r-1', plannedAt: 1000,
      terminalUnsentReason: 'cancelled',
    });

    const report = await store.exportLog('s-1') as { shots: Array<Record<string, unknown>> };
    const shot = report.shots[0];
    expect(shot).not.toHaveProperty('scheduleErrorMs');
    expect(shot).not.toHaveProperty('queueDelayMs');
    expect(shot).not.toHaveProperty('bridgeWaitMs');
    expect(shot).not.toHaveProperty('transportTotalMs');
  });

  it('persists an aborted started shot from its V2 event without marking it unsent', async () => {
    const listeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
    const window: Record<string, unknown> = {
      addEventListener: (_type: string, listener: (event: { data: Record<string, unknown> }) => void) => listeners.push(listener),
      postMessage: () => {},
    };
    const scope = vm.createContext({
      window, _NS: 'aborted-', MSG_OVL: '__overlay', indexedDB: idbFactory,
      document: { visibilityState: 'visible', addEventListener: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' },
      Intl, Date, Math, Promise, performance: { now: () => 1 }, setTimeout: () => 0, postToOverlay: () => {},
    });
    for (const name of ['11-fire-log-store.js', '12-fire-log.js']) {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
    }
    for (const listener of listeners) listener({ data: { __overlay: true, type: 'FIRE_LOG_V2_EVENT', data: {
      type: 'fetch_aborted', runId: 'run-cancelled', shotId: 'shot-1', requestSeq: 0, plannedAt: 1000,
      timing: { bridgeReceivedAt: 1001, fetchCalledAt: 1002 },
      shot: {
        shotId: 'shot-1', runId: 'run-cancelled', requestSeq: 0, plannedAt: 1000, outcome: 'cancelled',
        timing: { bridgeReceivedAt: 1001, fetchCalledAt: 1002 },
        request: { method: 'POST', headers: { Authorization: 'secret', 'X-Trace': 'keep' }, body: '{"ticket":"full"}' },
        response: { headers: { 'X-Response': 'keep' }, body: '{"partial":true}', status: 499, statusText: 'Client Closed Request' },
        cancel: { reason: 'user_cancelled_after_fetch_started' },
      },
    } } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const report = await (window.__fireLogV2Store as FireLogStore).exportLog('');
    expect((report.events as Array<Record<string, unknown>>)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'fetch_aborted', runId: 'run-cancelled' })]));
    expect((report.shots as Array<Record<string, unknown>>)[0]).toMatchObject({
      runId: 'run-cancelled', shotId: 'shot-1', outcome: 'cancelled', plannedAt: 1000,
      timing: { fetchCalledAt: 1002 }, response: { body: '{"partial":true}', status: 499 },
      request: { headers: { 'X-Trace': 'keep' } }, cancel: { reason: 'user_cancelled_after_fetch_started' },
    });
    expect((report.shots as Array<Record<string, unknown>>)[0]).not.toHaveProperty('terminalUnsentReason');
  });

  it('writes a complete session snapshot using the runtime manifest version', async () => {
    const listeners: Record<string, Array<() => void>> = {};
    const window: Record<string, unknown> = {
      addEventListener: (type: string, listener: () => void) => (listeners[type] ||= []).push(listener),
      postMessage: () => {},
    };
    const scope = vm.createContext({
      window, _NS: 'session-', MSG_OVL: '__overlay', indexedDB: idbFactory,
      _runtimeManifestVersion: '2.4.6',
      document: { visibilityState: 'hidden', addEventListener: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'session-agent' }, location: { href: 'https://example.test/glm-coding' },
      Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Shanghai' }) }) },
      Date, Math, Promise, performance: { now: () => 12 }, setTimeout: () => 0,
      postToOverlay: () => {},
    });
    for (const name of ['11-fire-log-store.js', '12-fire-log.js']) {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
    }
    await Promise.resolve();
    await Promise.resolve();

    const store = window.__fireLogV2Store as FireLogStore;
    expect((await store.readAll()).session).toMatchObject({
      runtimeManifestVersion: '2.4.6',
      userAgent: 'session-agent',
      pageUrl: 'https://example.test/glm-coding',
      timezone: 'Asia/Shanghai',
      visibilityState: 'hidden',
    });
    expect(typeof (await store.readAll()).session.sessionStartAt).toBe('string');
    expect(typeof (await store.readAll()).session.lastUpdatedAt).toBe('string');
  });

  it('records visibility changes with wall-clock, monotonic, and state details', async () => {
    const listeners: Record<string, Array<() => void>> = {};
    const document = {
      visibilityState: 'hidden',
      addEventListener: (type: string, listener: () => void) => (listeners[type] ||= []).push(listener),
    };
    const window: Record<string, unknown> = {
      addEventListener: () => {},
      postMessage: () => {},
    };
    const scope = vm.createContext({
      window, _NS: 'visibility-', MSG_OVL: '__overlay', indexedDB: idbFactory, document,
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' }, Intl, Date, Math, Promise,
      performance: { now: () => 42 }, setTimeout: () => 0, postToOverlay: () => {},
    });
    for (const name of ['11-fire-log-store.js', '12-fire-log.js']) {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
    }
    document.visibilityState = 'visible';
    listeners.visibilitychange[0]();
    await Promise.resolve();
    await Promise.resolve();

    const events = (await (window.__fireLogV2Store as FireLogStore).readAll()).events;
    expect(events).toContainEqual(expect.objectContaining({
      type: 'visibility_changed',
      monotonicMs: 42,
      details: { visibilityState: 'visible' },
    }));
    expect(typeof events.find((event) => event.type === 'visibility_changed')!.timestamp).toBe('string');
    expect((await (window.__fireLogV2Store as FireLogStore).readAll()).session).toMatchObject({
      initialVisibilityState: 'hidden',
      visibilityState: 'visible',
    });
  });

  it('registers one visibility diagnostic handler when the MAIN logger is reinitialized', async () => {
    const listeners: Record<string, Array<() => void>> = {};
    const document = {
      visibilityState: 'hidden',
      addEventListener: (type: string, listener: () => void) => (listeners[type] ||= []).push(listener),
    };
    const window: Record<string, unknown> = {
      addEventListener: () => {},
      postMessage: () => {},
    };
    const scope = vm.createContext({
      window, _NS: 'visibility-reinit-', MSG_OVL: '__overlay', indexedDB: idbFactory, document,
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' }, Intl, Date, Math, Promise,
      performance: { now: () => 42 }, setTimeout: () => 0, postToOverlay: () => {},
    });
    vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main/11-fire-log-store.js'), 'utf8'), scope);
    const loggerSource = readFileSync(resolve(__dirname, '../../../src/bm-main/12-fire-log.js'), 'utf8');
    vm.runInContext(loggerSource, scope);
    vm.runInContext(loggerSource, scope);

    document.visibilityState = 'visible';
    listeners.visibilitychange.forEach((listener) => listener());
    await Promise.resolve();
    await Promise.resolve();

    const events = (await (window.__fireLogV2Store as FireLogStore).readAll()).events;
    expect(listeners.visibilitychange).toHaveLength(1);
    expect(events.filter((event) => event.type === 'visibility_changed')).toHaveLength(1);
    expect(events.find((event) => event.type === 'visibility_changed')).toMatchObject({ details: { visibilityState: 'visible' } });
  });

  it('records one persistence error without recursively rewriting it', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const window: Record<string, unknown> = {
      addEventListener: () => {},
      postMessage: (message: Record<string, unknown>) => posted.push(message),
    };
    const scope = vm.createContext({
      window, _NS: 'failure-', MSG_OVL: '__overlay',
      document: { visibilityState: 'visible', addEventListener: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' }, Intl, Date, Math, Promise,
      performance: { now: () => 8 }, setTimeout: () => 0,
      postToOverlay: (type: string, data: Record<string, unknown>) => posted.push({ __overlay: true, type, data }),
    });
    for (const name of ['11-fire-log-store.js', '12-fire-log.js']) {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const events = (await (window.__fireLogV2Store as FireLogStore).readAll()).events;
    expect(events.filter((event) => event.type === 'persistence_error')).toHaveLength(1);
    expect(posted).toContainEqual(expect.objectContaining({
      type: 'FIRE_RESULT',
      data: expect.objectContaining({ line: expect.stringContaining('日志仅临时保存在内存') }),
    }));
  });

  it('surfaces an overlay warning when persistence falls back to memory', async () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const posted: Array<Record<string, unknown>> = [];
    const window = {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener),
      postMessage: (message: Record<string, unknown>) => {
        posted.push(message);
        for (const listener of listeners) listener({ data: message } as MessageEvent);
      },
    };
    const scope = vm.createContext({
      window, _NS: 'test-', MSG_OVL: '__overlay',
      document, 
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' },
      Intl, Date, Math, Promise, performance: { now: () => 1 },
      setTimeout: () => 0, URL: { createObjectURL: () => '', revokeObjectURL: () => {} }, Blob,
      postToOverlay: (type: string, data: Record<string, unknown>) => window.postMessage({ __overlay: true, type, data }),
    });
    document.body.innerHTML = '';
    for (const name of ['09-fire-viz.js', '11-fire-log-store.js', '12-fire-log.js']) {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toContainEqual(expect.objectContaining({
      __overlay: true,
      type: 'FIRE_RESULT',
      data: expect.objectContaining({ line: expect.stringContaining('日志仅临时保存在内存，刷新页面会丢失') }),
    }));
    await expect(((window as unknown as Record<string, unknown>).__fireLogDownload as () => Promise<Record<string, unknown>>)()).resolves.toMatchObject({ schemaVersion: 2 });
    expect(document.body.textContent).toContain('日志仅临时保存在内存，刷新页面会丢失');

    (scope._fv_show as (data: Record<string, unknown>) => void)({ mode: 'manual', totalShots: 0, burstIntervalMs: 100 });
    expect(document.getElementById('test-fv_log')!.textContent).toContain('日志仅临时保存在内存，刷新页面会丢失');
    document.body.innerHTML = '';
  });

  it('renders a deferred persistence warning once when Fire Matrix opens after the warning', () => {
    const listeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
    const scope = vm.createContext({
      window: { addEventListener: (_type: string, listener: (event: { data: Record<string, unknown> }) => void) => listeners.push(listener) },
      document, _NS: 'warning-', MSG_OVL: '__overlay', Date, Math, setTimeout: () => 0,
      navigator: { clipboard: null },
    });
    document.body.innerHTML = '';
    vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main/09-fire-viz.js'), 'utf8'), scope);

    const warning = '⚠ 日志仅临时保存在内存，刷新页面会丢失';
    listeners[0]({ data: { __overlay: true, type: 'FIRE_RESULT', data: { line: warning } } });
    expect(document.body.textContent).toContain(warning);

    (scope._fv_show as (data: Record<string, unknown>) => void)({ mode: 'manual', totalShots: 0, burstIntervalMs: 100 });
    listeners[0]({ data: { __overlay: true, type: 'FIRE_RESULT', data: { line: warning } } });

    const log = document.getElementById('warning-fv_log')!;
    expect(log.textContent).toContain(warning);
    expect(log.textContent!.split(warning)).toHaveLength(2);
    document.body.innerHTML = '';
  });

  it('opens Fire Matrix by default and exposes stop plus complete-log controls', () => {
    const listeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
    const posted: Array<Record<string, unknown>> = [];
    const scope = vm.createContext({
      window: {
        addEventListener: (_type: string, listener: (event: { data: Record<string, unknown> }) => void) => listeners.push(listener),
        postMessage: (message: Record<string, unknown>) => posted.push(message),
      },
      _NS: 'default-panel-', MSG_OVL: '__overlay', MSG_CMD: '__command',
      document, Date, Math, setTimeout: () => 0,
      navigator: { clipboard: null },
    });
    document.body.innerHTML = '';
    vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main/09-fire-viz.js'), 'utf8'), scope);

    expect(document.getElementById('default-panel-fv')).not.toBeNull();
    expect(document.getElementById('default-panel-fv_json')!.textContent).toBe('完整日志json');
    expect(document.getElementById('default-panel-fv_wave')!.textContent).toBe('Idle');
    expect(document.getElementById('default-panel-fv_cnt')!.textContent).toBe('0/0 shots');
    expect((document.getElementById('default-panel-fv_stop') as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById('default-panel-fv_stop')!.textContent).toBe('尚未开始');

    listeners[0]({ data: {
      __overlay: true,
      type: 'FIRE_BATCH_START',
      data: { mode: 'manual', totalShots: 2, burstIntervalMs: 100, startMs: 1 },
    } });

    expect(document.getElementById('default-panel-fv_wave')!.textContent).toBe('Wave 1');
    expect(scope._fv_waveCount).toBe(1);
    expect((document.getElementById('default-panel-fv_stop') as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('default-panel-fv_stop')!.textContent).toBe('停止');
    (document.getElementById('default-panel-fv_stop') as HTMLButtonElement).click();
    expect(posted).toContainEqual({ __command: true, type: 'CANCEL_FIRE' });
    document.body.innerHTML = '';
  });

  it('binds document drag listeners once across Fire Matrix close and reopen cycles', () => {
    const addedListeners: Array<{
      type: string;
      listener: EventListenerOrEventListenerObject;
      options?: boolean | AddEventListenerOptions;
    }> = [];
    const originalAddEventListener = document.addEventListener;
    document.addEventListener = function(type, listener, options) {
      addedListeners.push({ type, listener, options });
      return originalAddEventListener.call(document, type, listener, options);
    } as typeof document.addEventListener;
    const scope = vm.createContext({
      window: { addEventListener: () => {}, postMessage: () => {} },
      _NS: 'drag-', MSG_OVL: '__overlay', MSG_CMD: '__command',
      document, Date, Math, setTimeout: () => 0,
      navigator: { clipboard: null },
    });
    document.body.innerHTML = '';

    try {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main/09-fire-viz.js'), 'utf8'), scope);
      for (let cycle = 0; cycle < 3; cycle++) {
        (document.getElementById('drag-fv_cls') as HTMLButtonElement).click();
        (scope._fv_show as () => void)();
      }

      expect(addedListeners.filter(({ type }) => type === 'mousemove')).toHaveLength(1);
      expect(addedListeners.filter(({ type }) => type === 'mouseup')).toHaveLength(1);

      const panel = document.getElementById('drag-fv') as HTMLElement;
      const header = document.getElementById('drag-fv_h') as HTMLElement;
      header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 20 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 35, clientY: 55 }));
      expect(panel.style.left).toBe('25px');
      expect(panel.style.top).toBe('35px');
      document.dispatchEvent(new MouseEvent('mouseup'));
      expect(scope._fv_dragState).toBeNull();

      header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 2 }));
      expect(scope._fv_dragState).not.toBeNull();
      expect(Object.values(scope._fv_dragState)).not.toContain(panel);
      (document.getElementById('drag-fv_cls') as HTMLButtonElement).click();
      expect(scope._fv_dragState).toBeNull();
    } finally {
      document.addEventListener = originalAddEventListener;
      for (const { type, listener, options } of addedListeners) {
        document.removeEventListener(type, listener, options);
      }
      document.body.innerHTML = '';
    }
  });

  it('retains same-index shots from separate runs when their IDs are run-scoped', async () => {
    const listeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
    const window: Record<string, unknown> = {
      addEventListener: (_type: string, listener: (event: { data: Record<string, unknown> }) => void) => listeners.push(listener),
      postMessage: () => undefined,
    };
    const scope = vm.createContext({
      window, _NS: 'identity-', MSG_OVL: '__overlay', indexedDB: idbFactory,
      document: { visibilityState: 'visible' },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' },
      Intl, Date, Math, Promise, performance: { now: () => 1 }, setTimeout: () => 0,
      postToOverlay: () => {},
    });
    for (const name of ['11-fire-log-store.js', '12-fire-log.js']) {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
    }
    for (const runId of ['manual-1', 'manual-2']) {
      listeners[0]({ data: {
        __overlay: true, type: 'FIRE_SHOT_RESULT',
        data: { runId, shotId: `${runId}:shot-0`, shotIdx: 0, productId: 'product-1', outcome: 'busy', code: 555 },
      } });
    }
    await Promise.resolve();
    await Promise.resolve();

    const shots = (await (window.__fireLogV2Store as FireLogStore).readAll()).shots;
    expect(shots.map((shot) => shot.shotId).sort()).toEqual(['manual-1:shot-0', 'manual-2:shot-0']);
  });

  it('preserves legacy shot code as V2 httpStatus after higher-priority status fields', async () => {
    const listeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
    const window: Record<string, unknown> = {
      addEventListener: (_type: string, listener: (event: { data: Record<string, unknown> }) => void) => listeners.push(listener),
      postMessage: () => {},
    };
    const scope = vm.createContext({
      window, _NS: 'status-', MSG_OVL: '__overlay', indexedDB: idbFactory,
      document: { visibilityState: 'visible' },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' },
      Intl, Date, Math, Promise, performance: { now: () => 1 }, setTimeout: () => 0,
      postToOverlay: () => {},
    });
    for (const name of ['11-fire-log-store.js', '12-fire-log.js']) {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
    }

    listeners[0]({ data: { __overlay: true, type: 'FIRE_SHOT_RESULT', data: { shotIdx: 0, productId: 'p-1', code: 555 } } });
    listeners[0]({ data: { __overlay: true, type: 'FIRE_SHOT_RESULT', data: { shotIdx: 1, productId: 'p-2', code: 555, httpCode: 503 } } });
    listeners[0]({ data: { __overlay: true, type: 'FIRE_SHOT_RESULT', data: { shotIdx: 2, productId: 'p-3', code: 555, httpCode: 503, httpStatus: 201 } } });
    listeners[0]({ data: { __overlay: true, type: 'FIRE_SHOT_RESULT', data: { shotIdx: 3, productId: 'p-4', code: 555, httpCode: 503, httpStatus: 0 } } });
    await Promise.resolve();
    await Promise.resolve();
    const store = (window.__fireLogV2Store as FireLogStore);
    expect((await store.readAll()).shots.map((shot) => shot.httpStatus)).toEqual([555, 503, 201, 0]);
  });

  it('renders and summarizes waf as its own legacy diagnostic outcome', () => {
    const listeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
    const window: Record<string, unknown> = {
      addEventListener: (_type: string, listener: (event: { data: Record<string, unknown> }) => void) => listeners.push(listener),
      postMessage: () => {},
    };
    const scope = vm.createContext({
      window, _NS: 'waf-', MSG_OVL: '__overlay', indexedDB: idbFactory,
      document,
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { userAgent: 'test-agent' }, location: { href: 'https://example.test' },
      Intl, Date, Math, Promise, performance: { now: () => 1 }, setTimeout: () => 0,
      postToOverlay: () => {},
    });
    document.body.innerHTML = '';
    for (const name of ['09-fire-viz.js', '11-fire-log-store.js', '12-fire-log.js']) {
      vm.runInContext(readFileSync(resolve(__dirname, '../../../src/bm-main', name), 'utf8'), scope);
    }
    (scope._fv_show as (data: Record<string, unknown>) => void)({ mode: 'manual', totalShots: 1, burstIntervalMs: 100 });

    for (const listener of listeners) listener({ data: {
      __overlay: true,
      type: 'FIRE_SHOT_RESULT',
      data: { shotIdx: 0, productId: 'p-waf', outcome: 'waf', code: 500, rtt: 1 },
    } });

    expect(scope._fv_counts).toMatchObject({ waf: 1, error: 0 });
    expect(document.body.textContent).toContain('WAF 拦截');
    expect((window.__fireLogSummary as () => Record<string, number>)()).toMatchObject({ waf: 1, error: 0 });
    document.body.innerHTML = '';
  });
});
