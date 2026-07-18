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

describe('Fire Log V2 store', () => {
  let dbName: string;

  beforeEach(() => {
    dbName = 'fire-log-test-' + Math.random().toString(36).slice(2);
    idbFactory = new IDBFactory();
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
      request: { method: 'POST', url: 'https://bigmodel.cn/api/biz/pay/preview', headers: { Authorization: 'secret', 'X-Trace': 'keep' }, body: '{"ticket":"full-ticket"}' },
      response: { headers: { 'Set-Cookie': 'secret', 'X-Response': 'keep' }, body: 'x'.repeat(800) },
      timing: { bridgeReceivedAt: 1003, fetchCalledAt: 1004, responseHeadersAt: 1008, bodyCompletedAt: 1012 },
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
    expect(report.shots).toHaveLength(1);
    expect((report.shots as Array<Record<string, unknown>>)[0]).toMatchObject({
      runId: 'run-1', shotId: 'shot-1', plannedAt: 1000, requestSeq: 0,
      httpStatus: 555, statusText: 'Busy', ticket: 'full-ticket', randstr: 'full-randstr',
      request: { method: 'POST', headers: { 'X-Trace': 'keep' } },
      response: { headers: { 'X-Response': 'keep' }, body: 'x'.repeat(800) },
      timing: { fetchCalledAt: 1004 },
    });
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
    expect(document.body.textContent).not.toContain('日志仅临时保存在内存，刷新页面会丢失');

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
    expect(document.body.textContent).not.toContain(warning);

    (scope._fv_show as (data: Record<string, unknown>) => void)({ mode: 'manual', totalShots: 0, burstIntervalMs: 100 });
    listeners[0]({ data: { __overlay: true, type: 'FIRE_RESULT', data: { line: warning } } });

    const log = document.getElementById('warning-fv_log')!;
    expect(log.textContent).toContain(warning);
    expect(log.textContent!.split(warning)).toHaveLength(2);
    document.body.innerHTML = '';
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
