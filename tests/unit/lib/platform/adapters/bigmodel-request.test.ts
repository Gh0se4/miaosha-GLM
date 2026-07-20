import { describe, expect, it } from 'vitest';

import { toMainWorldFetchOptions } from '../../../../../lib/platform/adapters/bigmodel/request';

describe('toMainWorldFetchOptions', () => {
  it('removes local lifecycle callbacks before a MAIN-world message is cloned', () => {
    const options = toMainWorldFetchOptions({
      method: 'POST',
      url: 'https://bigmodel.cn/api/biz/pay/preview',
      headers: { authorization: 'token' },
      body: '{"ticket":"ticket"}',
      requestId: 'request-1',
      runId: 'run-1',
      shotId: 'shot-1',
      onFetchStarted: () => undefined,
      onAbortReady: () => undefined,
    });

    expect(options).toEqual({
      method: 'POST',
      url: 'https://bigmodel.cn/api/biz/pay/preview',
      headers: { authorization: 'token' },
      body: '{"ticket":"ticket"}',
      requestId: 'request-1',
      runId: 'run-1',
      shotId: 'shot-1',
    });
    expect(() => structuredClone(options)).not.toThrow();
  });
});
