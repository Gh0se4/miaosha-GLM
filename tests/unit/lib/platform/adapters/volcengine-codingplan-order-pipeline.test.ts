import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { VolcengineCodingplanOrderPipeline } from '../../../../../lib/platform/adapters/volcengine-codingplan/order-pipeline';
import { seedVolcengineCodingplanCatalog } from '../../../../../lib/platform/adapters/volcengine-codingplan/product-probe';
import { setMainWorldFetcher } from '../../../../../lib/platform/adapters/volcengine-shared/request';

const auth = {
  platform: 'volcengine-codingplan' as const,
  headers: {
    'x-csrf-token': 'csrf',
    'monitor-huoshan-web-id': 'web-id',
  },
  capturedAt: 0,
};

const PRODUCT_ID = 'Coding_Plan_Pro_monthly|duration:1';

const configBody = {
  Product: 'ark_bd',
  ConfigurationCode: 'Coding_Plan_Pro_monthly',
  Quantity: 1,
  Duration: 1,
  DurationUnit: 'monthly',
  ChargeItemList: [{ ChargeItemCode: 'Coding_Plan_Pro_monthly_cn-beijing', Count: '1' }],
  RenewType: 2,
  PurchaseTimes: 1,
};

function volcResponse(data: unknown) {
  return {
    status: 200,
    statusText: 'OK',
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

beforeAll(() => {
  // Seed a product that carries index-key candidates so the retry path is exercised.
  const item = { indexKey: 'idx-good', configBody, indexKeyCandidates: ['idx-bad', 'idx-good'] };
  seedVolcengineCodingplanCatalog({
    platform: 'volcengine-codingplan',
    updatedAt: 0,
    groups: {
      monthly: [
        {
          id: PRODUCT_ID,
          name: 'Pro',
          billingPeriod: 'monthly',
          price: 0,
          currentAmount: 0,
          renewAmount: 0,
          originalPrice: 0,
          soldOut: false,
          description: '',
          raw: item,
        },
      ],
      quarterly: [],
      yearly: [],
    },
  } as any);
});

afterEach(() => setMainWorldFetcher(null));

describe('VolcengineCodingplanOrderPipeline', () => {
  it('rejects invalid auth without calling the network', async () => {
    let called = false;
    setMainWorldFetcher(async () => { called = true; return volcResponse({}); });

    const result = await new VolcengineCodingplanOrderPipeline().run(
      { platform: 'volcengine-codingplan', productId: PRODUCT_ID } as any,
      { platform: 'volcengine-codingplan', headers: {}, capturedAt: 0 } as any,
    );

    expect(result).toMatchObject({ success: false, error: 'volcengine auth invalid' });
    expect(called).toBe(false);
  });

  it('errors on an unparseable product id', async () => {
    const result = await new VolcengineCodingplanOrderPipeline().run(
      { platform: 'volcengine-codingplan', productId: '' } as any,
      auth as any,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('unknown');
  });

  it('retries the next index-key candidate on InvalidParameter.Configuration and succeeds', async () => {
    const seenIndexKeys: string[] = [];
    setMainWorldFetcher(async (opts) => {
      const body = JSON.parse(opts.body as string);
      seenIndexKeys.push(body.IndexKey);
      if (body.IndexKey === 'idx-bad') {
        return volcResponse({ ResponseMetadata: { Error: { Code: 'InvalidParameter.Configuration', Message: 'bad config' } } });
      }
      return volcResponse({ Result: { CustomerOrderID: 'order-123' } });
    });

    const result = await new VolcengineCodingplanOrderPipeline().run(
      { platform: 'volcengine-codingplan', productId: PRODUCT_ID } as any,
      auth as any,
    );

    expect(seenIndexKeys).toEqual(['idx-bad', 'idx-good']);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      platform: 'volcengine-codingplan',
      orderId: 'order-123',
      bizId: 'order-123',
    });
    expect(result.data?.payUrl).toContain('/activity/codingplan');
    expect(result.data?.payUrl).toContain('order-123');
  });

  it('returns a non-retryable error immediately without trying other candidates', async () => {
    const seenIndexKeys: string[] = [];
    setMainWorldFetcher(async (opts) => {
      const body = JSON.parse(opts.body as string);
      seenIndexKeys.push(body.IndexKey);
      return volcResponse({ ResponseMetadata: { Error: { Code: 'Throttling', Message: 'slow down' } } });
    });

    const result = await new VolcengineCodingplanOrderPipeline().run(
      { platform: 'volcengine-codingplan', productId: PRODUCT_ID } as any,
      auth as any,
    );

    expect(seenIndexKeys).toEqual(['idx-bad']);
    expect(result).toMatchObject({ success: false, error: '[Throttling] slow down' });
  });

  it('errors when CommonBuy returns no CustomerOrderID', async () => {
    setMainWorldFetcher(async () => volcResponse({ Result: {} }));

    const result = await new VolcengineCodingplanOrderPipeline().run(
      { platform: 'volcengine-codingplan', productId: PRODUCT_ID } as any,
      auth as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('CustomerOrderID');
  });
});
