/**
 * Regression tests: src/volc-shared pricing fetch retry logic.
 *
 * This module is shared by both the Agent Plan and Coding Plan overlays, so one
 * suite covers both. calculatePriceV5 intermittently throws
 * `TypeError: Failed to fetch` on transient network issues; fetchPrice must
 * retry those with exponential backoff and must NOT retry aborts or HTTP error
 * responses. Both product codes are exercised to confirm the shared serializer
 * handles each vertical.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadVolcSharedModules, type VolcSharedScope } from './_harness';

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeAuthSandbox(S: VolcSharedScope) {
  (S.document as any).cookie = 'csrfToken=test-csrf; monitor_huoshan_web_id=test-web-id';
}

describe('fetchPrice (volc-shared)', () => {
  let S: VolcSharedScope;

  beforeEach(() => {
    S = loadVolcSharedModules(['10-shared', '20-pricing']);
    makeAuthSandbox(S);
  });

  it('returns parsed original/current prices on success', async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        Result: { TotalOriginalAmount: '1428.00', TotalDiscountAmount: '1199.00' },
      }),
    });
    (S as any).fetch = fetch;
    (S.window as any).fetch = fetch;

    const price = await (S.__volc_fetchPrice as (b: unknown) => Promise<unknown>)({
      Product: 'ark_bd',
      ConfigurationCode: 'Coding_Plan_Pro_monthly',
      ChargeItemList: [{ ChargeItemCode: 'tokens', Count: 1 }],
      Quantity: 1,
      DurationUnit: 'monthly',
      Duration: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(price).toEqual({ original: 1428, current: 1199 });
  });

  it('retries transient TypeError network failures and eventually succeeds', async () => {
    const captured: Array<{ fn: Function; ms: number }> = [];
    S.setTimeout = ((fn: Function, ms?: number) => {
      captured.push({ fn, ms: ms || 0 });
      return captured.length;
    }) as any;
    S.clearTimeout = () => {};

    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({
        json: () => Promise.resolve({
          Result: { TotalOriginalAmount: '100.00', TotalDiscountAmount: '80.00' },
        }),
      });
    (S as any).fetch = fetch;
    (S.window as any).fetch = fetch;

    const promise = (S.__volc_fetchPrice as (b: unknown) => Promise<unknown>)({
      Product: 'ark_subscription',
      ConfigurationCode: 'Agent_Plan_Small_monthly',
    });

    await flushPromises();
    expect(captured.length).toBe(1);
    expect(captured[0].ms).toBe(300);

    captured[0].fn();
    await flushPromises();
    expect(captured.length).toBe(2);
    expect(captured[1].ms).toBe(600);

    captured[1].fn();
    await flushPromises();

    const price = await promise;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(price).toEqual({ original: 100, current: 80 });
  });

  it('does not retry AbortError', async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError'));
    (S as any).fetch = fetch;
    (S.window as any).fetch = fetch;

    const price = await (S.__volc_fetchPrice as (b: unknown) => Promise<unknown>)({
      Product: 'ark_bd',
      ConfigurationCode: 'Coding_Plan_Pro_monthly',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(price).toBeNull();
  });

  it('returns null after exhausting all retries', async () => {
    const captured: Array<{ fn: Function; ms: number }> = [];
    S.setTimeout = ((fn: Function, ms?: number) => {
      captured.push({ fn, ms: ms || 0 });
      return captured.length;
    }) as any;
    S.clearTimeout = () => {};

    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    (S as any).fetch = fetch;
    (S.window as any).fetch = fetch;

    const promise = (S.__volc_fetchPrice as (b: unknown) => Promise<unknown>)({
      Product: 'ark_bd',
      ConfigurationCode: 'Coding_Plan_Pro_monthly',
    });

    await flushPromises();
    captured[0].fn();
    await flushPromises();
    captured[1].fn();
    await flushPromises();

    const price = await promise;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(price).toBeNull();
  });

  it('does not retry HTTP error responses from the API', async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        ResponseMetadata: { Error: { Code: 'InvalidParameter', Message: 'bad config' } },
      }),
    });
    (S as any).fetch = fetch;
    (S.window as any).fetch = fetch;

    const price = await (S.__volc_fetchPrice as (b: unknown) => Promise<unknown>)({
      Product: 'ark_bd',
      ConfigurationCode: 'Coding_Plan_Pro_monthly',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(price).toBeNull();
  });

  it('returns null when auth cookies are missing', async () => {
    (S.document as any).cookie = '';
    const fetch = vi.fn();
    (S as any).fetch = fetch;
    (S.window as any).fetch = fetch;

    const price = await (S.__volc_fetchPrice as (b: unknown) => Promise<unknown>)({
      Product: 'ark_bd',
      ConfigurationCode: 'Coding_Plan_Pro_monthly',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(price).toBeNull();
  });

  it('serializes the calculatePriceV5 request body correctly (agentplan product)', async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ Result: { TotalOriginalAmount: '0', TotalDiscountAmount: '0' } }),
    });
    (S as any).fetch = fetch;
    (S.window as any).fetch = fetch;

    await (S.__volc_fetchPrice as (b: unknown) => Promise<unknown>)({
      Product: 'ark_subscription',
      ConfigurationCode: 'Agent_Plan_Small_monthly',
      ChargeItemList: [{ ChargeItemCode: 'tokens', Count: 2 }],
      Quantity: 1,
      DurationUnit: 'monthly',
      Duration: 3,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://www.volcengine.com/api/sales/calculatePriceV5',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          'x-csrf-token': 'test-csrf',
          'monitor-huoshan-web-id': 'test-web-id',
          'x-language': 'zh',
          'x-use-bff-version': '1',
        }),
        body: JSON.stringify({
          ConfigItems: [{
            Product: 'ark_subscription',
            ConfigurationCode: 'Agent_Plan_Small_monthly',
            ChargeItems: [{ ChargeItemCode: 'tokens', AttrValue: '2' }],
            Quantity: 1,
            Period: 'monthly',
            Times: 3,
            OrderType: 1,
            SerialNo: '0',
          }],
        }),
      }),
    );
  });
});

describe('fetchAllPrices (volc-shared)', () => {
  let S: VolcSharedScope;

  beforeEach(() => {
    S = loadVolcSharedModules(['10-shared', '20-pricing']);
    makeAuthSandbox(S);
  });

  it('falls back to zero prices when every fetch fails', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    (S as any).fetch = fetch;
    (S.window as any).fetch = fetch;

    const prices = await (S.__volc_fetchAllPrices as (items: unknown[]) => Promise<Record<string, unknown>>)([
      { configBody: { Product: 'ark_bd', ConfigurationCode: 'A', Duration: 1 } },
      { configBody: { Product: 'ark_bd', ConfigurationCode: 'B', Duration: 3 } },
    ]);

    expect(fetch).toHaveBeenCalledTimes(6); // 2 items × 3 retries
    expect(prices).toEqual({
      'A|1': { original: 0, current: 0 },
      'B|3': { original: 0, current: 0 },
    });
  });
});
