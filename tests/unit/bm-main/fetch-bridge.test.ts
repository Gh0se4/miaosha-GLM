import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';
import { describe, expect, it, vi } from 'vitest';

type Message = Record<string, unknown>;

interface BridgeTiming {
  bridgeReceivedAt: number;
  bridgeReceivedPerfMs: number;
}

interface StartedTiming extends BridgeTiming {
  fetchCalledAt: number;
  fetchCalledPerfMs: number;
}

interface HeadersTiming extends StartedTiming {
  responseHeadersAt: number;
}

interface CompleteTiming extends HeadersTiming {
  bodyCompletedAt: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadBridge(fetch: ReturnType<typeof vi.fn>, onPost?: (message: Message) => void) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const posted: Message[] = [];
  let wall = 1_000;
  let perf = 100;
  const window = {
    addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener)),
    postMessage: vi.fn((message: Message) => {
      const cloned = structuredClone(message);
      posted.push(cloned);
      onPost?.(cloned);
    }),
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

async function waitForPostedTypes(bridge: ReturnType<typeof loadBridge>, types: string[]) {
  await vi.waitFor(() => {
    expect(bridge.posted.map((message) => message.type)).toEqual(types);
  });
}

function expectBridgeTiming(timing: unknown): asserts timing is BridgeTiming {
  expect(timing).toEqual({
    bridgeReceivedAt: expect.any(Number),
    bridgeReceivedPerfMs: expect.any(Number),
  });
}

function expectStartedTiming(timing: unknown): asserts timing is StartedTiming {
  expect(timing).toEqual({
    bridgeReceivedAt: expect.any(Number),
    bridgeReceivedPerfMs: expect.any(Number),
    fetchCalledAt: expect.any(Number),
    fetchCalledPerfMs: expect.any(Number),
  });
}

function expectHeadersTiming(timing: unknown): asserts timing is HeadersTiming {
  expect(timing).toEqual({
    bridgeReceivedAt: expect.any(Number),
    bridgeReceivedPerfMs: expect.any(Number),
    fetchCalledAt: expect.any(Number),
    fetchCalledPerfMs: expect.any(Number),
    responseHeadersAt: expect.any(Number),
  });
}

function expectCompleteTiming(timing: unknown): asserts timing is CompleteTiming {
  expect(timing).toEqual({
    bridgeReceivedAt: expect.any(Number),
    bridgeReceivedPerfMs: expect.any(Number),
    fetchCalledAt: expect.any(Number),
    fetchCalledPerfMs: expect.any(Number),
    responseHeadersAt: expect.any(Number),
    bodyCompletedAt: expect.any(Number),
  });
}

describe('MAIN world fetch bridge protocol', () => {
  it('posts STARTED with observed start timing before a complete RESULT and preserves metadata', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 201,
      statusText: 'Created',
      headers: new Map([['x-trace', 'trace-1']]),
      text: () => Promise.resolve('{"ok":true}'),
    });
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'request-1', runId: 'run-1', shotId: 'shot-1', opts: { url: 'https://bigmodel.cn/api/test' } });
    await waitForPostedTypes(bridge, ['DO_FETCH_STARTED', 'DO_FETCH_RESULT']);

    const [started, result] = bridge.posted;
    expect(started).toMatchObject({ __evt: true, requestId: 'request-1', runId: 'run-1', shotId: 'shot-1' });
    expect(result).toMatchObject({ __evt: true, ok: true, requestId: 'request-1', runId: 'run-1', shotId: 'shot-1', status: 201, statusText: 'Created', body: '{"ok":true}', headers: { 'x-trace': 'trace-1' } });
    expectStartedTiming(started.timing);
    expectCompleteTiming(result.timing);
    expect(result.timing.bridgeReceivedAt).toBeLessThanOrEqual(result.timing.fetchCalledAt);
    expect(result.timing.fetchCalledAt).toBeLessThanOrEqual(result.timing.responseHeadersAt);
    expect(result.timing.responseHeadersAt).toBeLessThanOrEqual(result.timing.bodyCompletedAt);
    expect(result.timing.bridgeReceivedPerfMs).toBeLessThanOrEqual(result.timing.fetchCalledPerfMs);
  });

  it('preserves reqId alongside requestId for legacy callers', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve('legacy'),
    });
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', reqId: 'legacy-1', opts: { url: 'https://bigmodel.cn/api/test' } });
    await waitForPostedTypes(bridge, ['DO_FETCH_STARTED', 'DO_FETCH_RESULT']);

    expect(bridge.posted).toHaveLength(2);
    for (const message of bridge.posted) {
      expect(message).toMatchObject({ requestId: 'legacy-1', reqId: 'legacy-1' });
    }
  });

  it('calls fetch before STARTED and reports a synchronous fetch failure without STARTED', async () => {
    const fetch = vi.fn().mockImplementationOnce(() => {
      throw new Error('sync failure');
    }).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.resolve('ok'),
    });
    const observedFetchCalls: number[] = [];
    const bridge = loadBridge(fetch, (message) => {
      if (message.type === 'DO_FETCH_STARTED') observedFetchCalls.push(fetch.mock.calls.length);
    });

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'sync-fail', opts: { url: 'https://bigmodel.cn/api/test' } });
    await waitForPostedTypes(bridge, ['DO_FETCH_RESULT']);
    expect(bridge.posted).toHaveLength(1);
    expect(bridge.posted[0]).toMatchObject({ type: 'DO_FETCH_RESULT', ok: false, status: 0, statusText: '', headers: {}, body: '' });
    expectStartedTiming(bridge.posted[0].timing);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'started-after-fetch', opts: { url: 'https://bigmodel.cn/api/test' } });
    await waitForPostedTypes(bridge, ['DO_FETCH_RESULT', 'DO_FETCH_STARTED', 'DO_FETCH_RESULT']);
    expect(observedFetchCalls).toEqual([2]);
  });

  it('isolates duplicate requestId while the original request is active', async () => {
    const pending = deferred<{ status: number; statusText: string; headers: Map<string, string>; text: () => Promise<string> }>();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'same-id', opts: { url: 'https://bigmodel.cn/api/test' } });
    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'same-id', opts: { url: 'https://bigmodel.cn/api/test' } });
    expect(fetch).toHaveBeenCalledTimes(1);

    pending.resolve({ status: 200, statusText: 'OK', headers: new Map(), text: () => Promise.resolve('original') });
    await waitForPostedTypes(bridge, ['DO_FETCH_STARTED', 'DO_FETCH_RESULT']);
    expect(bridge.posted.filter((message) => message.type === 'DO_FETCH_RESULT')).toEqual([
      expect.objectContaining({ requestId: 'same-id', ok: true, body: 'original' }),
    ]);
  });

  it('rejects a missing requestId without starting a fetch', async () => {
    const fetch = vi.fn();
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', opts: { url: 'https://bigmodel.cn/api/test' } });

    expect(fetch).not.toHaveBeenCalled();
    expect(bridge.posted).toEqual([
      expect.objectContaining({ type: 'DO_FETCH_RESULT', ok: false, error: 'invalid requestId', requestId: null, reqId: null }),
    ]);
    expectBridgeTiming(bridge.posted[0].timing);
  });

  it('rejects a blocked URL without recording fetch or response timing', () => {
    const fetch = vi.fn();
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'blocked-1', opts: { url: 'https://example.com/api/test' } });

    expect(fetch).not.toHaveBeenCalled();
    expect(bridge.posted).toEqual([
      expect.objectContaining({ type: 'DO_FETCH_RESULT', ok: false, error: 'blocked', requestId: 'blocked-1', reqId: 'blocked-1' }),
    ]);
    expectBridgeTiming(bridge.posted[0].timing);
  });

  it('records fetch timing but no response timing when fetch rejects', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network failure'));
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'reject-1', opts: { url: 'https://bigmodel.cn/api/test' } });
    await waitForPostedTypes(bridge, ['DO_FETCH_STARTED', 'DO_FETCH_RESULT']);

    expectStartedTiming(bridge.posted[0].timing);
    expect(bridge.posted[1]).toMatchObject({ ok: false, error: 'network failure' });
    expectStartedTiming(bridge.posted[1].timing);
  });

  it('records response headers but no body completion when reading the body fails', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: () => Promise.reject(new Error('body failure')),
    });
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'body-fail-1', opts: { url: 'https://bigmodel.cn/api/test' } });
    await waitForPostedTypes(bridge, ['DO_FETCH_STARTED', 'DO_FETCH_RESULT']);

    expectStartedTiming(bridge.posted[0].timing);
    expect(bridge.posted[1]).toMatchObject({ ok: false, error: 'body failure' });
    expectHeadersTiming(bridge.posted[1].timing);
  });

  it('aborts a matching request and suppresses its late result', async () => {
    const pending = deferred<{ status: number; statusText: string; headers: Map<string, string>; text: () => Promise<string> }>();
    const body = deferred<string>();
    const readBody = vi.fn(() => body.promise);
    const fetch = vi.fn().mockReturnValue(pending.promise);
    const bridge = loadBridge(fetch);

    bridge.dispatch({ __cmd: true, type: 'DO_FETCH', requestId: 'request-cancel', opts: { url: 'https://bigmodel.cn/api/test' } });
    expect(bridge.posted).toHaveLength(1);
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    bridge.dispatch({ __cmd: true, type: 'DO_FETCH_CANCEL', requestId: 'request-cancel' });
    expect(signal.aborted).toBe(true);

    pending.resolve({ status: 200, statusText: 'OK', headers: new Map(), text: readBody });
    await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());
    body.resolve('late');
    await body.promise;
    expect(bridge.posted.map((message) => message.type)).toEqual(['DO_FETCH_STARTED']);
  });
});
