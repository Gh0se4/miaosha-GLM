import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
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
    await first.writeShot({ shotId: 'sh-1', sessionId: 's-1', runId: 'r-1' });

    const restored = makeStore(dbName);
    expect(await restored.readAll('s-1')).toMatchObject({
      session: { sessionId: 's-1' },
      runs: [{ runId: 'r-1' }],
      shots: [{ shotId: 'sh-1' }],
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
});
