import { afterEach, describe, expect, it } from 'vitest';

import { BigmodelOrderPipeline } from '../../../../../lib/platform/adapters/bigmodel/order-pipeline';
import { setMainWorldFetcher } from '../../../../../lib/platform/adapters/bigmodel/request';

const auth = {
  platform: 'bigmodel' as const,
  headers: {
    authorization: 'Bearer token',
    'bigmodel-organization': 'org',
    'bigmodel-project': 'project',
  },
  capturedAt: 0,
};

const context = {
  platform: 'bigmodel' as const,
  productId: 'product-1',
  ticket: { ticket: 'ticket-1', randstr: 'rand-1', provider: 'tencent-captcha' as const, createdAt: 0 },
};

function response(data: unknown, statusText = 'OK') {
  return {
    status: 200,
    statusText,
    data,
    headers: {},
    timing: {
      bridgeReceivedAt: 0,
      bridgeReceivedPerfMs: 0,
      fetchCalledAt: 0,
      fetchCalledPerfMs: 0,
      responseHeadersAt: 0,
      bodyCompletedAt: 0,
    },
  };
}

describe('BigmodelOrderPipeline result classification', () => {
  afterEach(() => setMainWorldFetcher(null));

  it('classifies 555 as busy with an explicitly client-side responsibility label', async () => {
    setMainWorldFetcher(async () => response({ code: 555, msg: 'system busy' }));

    const result = await new BigmodelOrderPipeline().run(context, auth);
    const classified = result.metadata?.classified as any;

    expect(result.success).toBe(false);
    expect(classified).toMatchObject({ outcome: 'busy', code: 555, rawServerMsg: 'system busy' });
    expect(classified.responsibility).toMatchObject({ source: 'client-side-classification' });
    expect(classified.responsibility.cause).toContain('推断');
  });

  it('classifies sold-out responses without treating them as a terminal result', async () => {
    setMainWorldFetcher(async () => response({ code: 200, msg: 'sold out', data: { soldOut: true } }));

    const result = await new BigmodelOrderPipeline().run(context, auth);

    expect(result.metadata?.classified).toMatchObject({
      outcome: 'soldout',
      code: 200,
      serverMsg: 'sold out',
      rawServerMsg: 'sold out',
    });
  });

  it('classifies WAF HTML as waf and preserves the raw response evidence', async () => {
    const html = '<!doctype html><html><body>challenge</body></html>';
    setMainWorldFetcher(async () => response(html));

    const result = await new BigmodelOrderPipeline().run(context, auth);
    const classified = result.metadata?.classified as any;

    expect(classified).toMatchObject({ outcome: 'waf', code: 500, rawServerMsg: html });
    expect(classified.responsibility).toMatchObject({ source: 'client-side-classification' });
    expect(classified.responsibility.cause).toContain('推断');
  });

  it('returns neterr metadata with both transport status text and message', async () => {
    const error = { message: 'socket closed', statusText: 'Network Error' };
    setMainWorldFetcher(async () => { throw error; });

    const result = await new BigmodelOrderPipeline().run(context, auth);

    expect(result).toMatchObject({
      success: false,
      error: 'socket closed',
      metadata: {
        statusText: 'Network Error',
        message: 'socket closed',
        classified: {
          outcome: 'neterr',
          code: 0,
          rawServerMsg: 'socket closed',
          responsibility: { source: 'client-side-classification' },
        },
      },
    });
  });
});
