import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';
import { describe, expect, it, vi } from 'vitest';

type Message = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadBridge(fetch: ReturnType<typeof vi.fn>) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const posted: Message[] = [];
  let wall = 1_000;
  let perf = 100;
  const window = {
    addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener)),
    postMessage: vi.fn((message: Message) => posted.push({ ...message })),
    fetch,
  };
  const scope = vm.createContext({
    window,
    location: { origin: 'https://bigmodel.cn' },
    performance: { now: () => ++perf },
    Date: { now: () => ++wall },
    AbortController,
    MSG_CMD: '__cmd',
    MSG_EVT: '__evt',
  });
  const code = readFileSync(resolve(__dirname, '../../../src/bm-main/06-fetch-bridge.js'), 'utf8');
  vm.runInContext(code, scope);

  return {
    posted,
    dispatch(data: Message) {
      for (const listener of listeners) listener({ source: window, data } as unknown as MessageEvent);
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('MAIN world fetch bridge protocol', () => {
  it('posts STARTED before RESULT with monotonic complete timing and preserved metadata', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 201,
      statusText: 'Created',
      headers: new Map([['x-trace', 'trace-1']]),
      text: () => Promise.resolve('{"ok":true}'),
    });
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'request-1', runId: 'run-1', shotId: 'shot-1', opts: { url: 'https://bigmodel.cn/api/test' } });
    await flush();

    expect(bridge.posted.map((message) => message.type)).toEqual(['DO_FETCH_STARTED', 'DO_FETCH_RESULT']);
    const [started, result] = bridge.posted;
    expect(started).toMatchObject({ __evt: true, requestId: 'request-1', runId: 'run-1', shotId: 'shot-1' });
    expect(result).toMatchObject({ __evt: true, ok: true, requestId: 'request-1', runId: 'run-1', shotId: 'shot-1', status: 201, statusText: 'Created', body: '{"ok":true}', headers: { 'x-trace': 'trace-1' } });
    const timing = result.timing as Record<string, number>;
    expect(timing).toMatchObject({
      bridgeReceivedAt: expect.any(Number),
      bridgeReceivedPerfMs: expect.any(Number),
      fetchCalledAt: expect.any(Number),
      fetchCalledPerfMs: expect.any(Number),
      responseHeadersAt: expect.any(Number),
      bodyCompletedAt: expect.any(Number),
    });
    expect(timing.bridgeReceivedAt).toBeLessThanOrEqual(timing.fetchCalledAt);
    expect(timing.fetchCalledAt).toBeLessThanOrEqual(timing.responseHeadersAt);
    expect(timing.responseHeadersAt).toBeLessThanOrEqual(timing.bodyCompletedAt);
    expect(timing.bridgeReceivedPerfMs).toBeLessThanOrEqual(timing.fetchCalledPerfMs);
  });

  it('aborts a matching request and suppresses its late result', async () => {
    const pending = deferred<{ status: number; statusText: string; headers: Map<string, string>; text: () => Promise<string> }>();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'request-cancel', opts: { url: 'https://bigmodel.cn/api/test' } });
    expect(bridge.posted).toHaveLength(1);
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    bridge.dispatch({ __cmd: true, type: 'DO_FETCH_CANCEL', requestId: 'request-cancel' });
    expect(signal.aborted).toBe(true);

    pending.resolve({ status: 200, statusText: 'OK', headers: new Map(), text: () => Promise.resolve('late') });
    await flush();
    expect(bridge.posted.map((message) => message.type)).toEqual(['DO_FETCH_STARTED']);
  });
});
