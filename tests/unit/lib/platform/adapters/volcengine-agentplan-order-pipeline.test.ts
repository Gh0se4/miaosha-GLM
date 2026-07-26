import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { VolcengineAgentplanOrderPipeline } from '../../../../../lib/platform/adapters/volcengine-agentplan/order-pipeline';
import { seedVolcengineAgentplanCatalog } from '../../../../../lib/platform/adapters/volcengine-agentplan/product-probe';
import { setMainWorldFetcher } from '../../../../../lib/platform/adapters/volcengine-shared/request';

const auth = {
  platform: 'volcengine-agentplan' as const,
  headers: { 'x-csrf-token': 'csrf', 'monitor-huoshan-web-id': 'web-id' },
  capturedAt: 0,
};

const PRODUCT_ID = 'Agent_Plan_Large_monthly|duration:1';

const configBody = {
  Product: 'ark_subscription',
  ConfigurationCode: 'Agent_Plan_Large_monthly',
  Quantity: 1,
  Duration: 1,
  DurationUnit: 'monthly',
  ChargeItemList: [{ ChargeItemCode: 'Agent_Plan_Large_monthly_cn-beijing', Count: '1' }],
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
  const item = { indexKey: 'idx-good', configBody, indexKeyCandidates: ['idx-bad', 'idx-good'] };
  seedVolcengineAgentplanCatalog({
    platform: 'volcengine-agentplan',
    updatedAt: 0,
    groups: {
      monthly: [
        {
          id: PRODUCT_ID,
          name: 'Large',
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

describe('VolcengineAgentplanOrderPipeline', () => {
  it('rejects invalid auth without calling the network', async () => {
    let called = false;
    setMainWorldFetcher(async () => { called = true; return volcResponse({}); });
    const result = await new VolcengineAgentplanOrderPipeline().run(
      { platform: 'volcengine-agentplan', productId: PRODUCT_ID } as any,
      { platform: 'volcengine-agentplan', headers: {}, capturedAt: 0 } as any,
    );
    expect(result).toMatchObject({ success: false, error: 'volcengine auth invalid' });
    expect(called).toBe(false);
  });

  it('retries on InvalidParameter.Configuration and builds an agentplan payUrl', async () => {
    const seen: string[] = [];
    setMainWorldFetcher(async (opts) => {
      const body = JSON.parse(opts.body as string);
      seen.push(body.IndexKey);
      if (body.IndexKey === 'idx-bad') {
        return volcResponse({ ResponseMetadata: { Error: { Code: 'InvalidParameter.Configuration', Message: 'bad' } } });
      }
      return volcResponse({ Result: { CustomerOrderID: 'order-9' } });
    });

    const result = await new VolcengineAgentplanOrderPipeline().run(
      { platform: 'volcengine-agentplan', productId: PRODUCT_ID } as any,
      auth as any,
    );

    expect(seen).toEqual(['idx-bad', 'idx-good']);
    expect(result.success).toBe(true);
    expect(result.data?.orderId).toBe('order-9');
    expect(result.data?.payUrl).toContain('/activity/agentplan');
    expect(result.data?.payUrl).toContain('order-9');
  });

  it('stamps the platform product code in the fallback order body', async () => {
    let sentProduct: string | undefined;
    setMainWorldFetcher(async (opts) => {
      const body = JSON.parse(opts.body as string);
      sentProduct = body.ConfigList?.[0]?.Product;
      return volcResponse({ Result: { CustomerOrderID: 'order-fb' } });
    });

    const result = await new VolcengineAgentplanOrderPipeline().run(
      { platform: 'volcengine-agentplan', productId: 'Agent_Plan_Large_monthly' } as any,
      auth as any,
    );

    expect(result.success).toBe(true);
    expect(sentProduct).toBe('ark_subscription');
  });

  it('passes a non-retryable error through unchanged', async () => {
    setMainWorldFetcher(async () => volcResponse({ ResponseMetadata: { Error: { Code: 'Throttling', Message: 'slow' } } }));
    const result = await new VolcengineAgentplanOrderPipeline().run(
      { platform: 'volcengine-agentplan', productId: PRODUCT_ID } as any,
      auth as any,
    );
    expect(result).toMatchObject({ success: false, error: '[Throttling] slow' });
  });
});
