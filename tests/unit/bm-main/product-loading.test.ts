/**
 * Regression tests: src/bm-main product loading orchestration
 *
 * These tests protect against the recurring bug where the Target Products
 * card stays in "No products loaded". Product loading is deliberately
 * passive: it consumes page-intercepted data and never issues an extension
 * initiated batch-preview request that may trigger Alibaba WAF.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { loadBmMainModules, type BmMainScope } from './_harness';

const FIXTURE_PRODUCT_LIST = [
  { productId: 'y-pro', monthlyPayAmount: '119', payAmount: '1428', renewAmount: '1428', soldOut: false, campaignDiscountDetails: [] },
  { productId: 'q-pro', monthlyPayAmount: '139', payAmount: '417', renewAmount: '417', soldOut: false, campaignDiscountDetails: [] },
  { productId: 'm-pro', monthlyPayAmount: '159', payAmount: '159', renewAmount: '159', soldOut: false, campaignDiscountDetails: [] },
];

function captureTimeouts(S: BmMainScope) {
  const captured: Array<{ fn: Function; ms: number }> = [];
  S.setTimeout = ((fn: Function, ms?: number) => {
    captured.push({ fn, ms: ms || 0 });
    return captured.length;
  }) as any;
  S.clearTimeout = () => {};
  return captured;
}

function makeAuthSandbox(S: BmMainScope) {
  S.document.cookie = 'bigmodel_token_production=eyJhbGci.test.token';
  (S.localStorage as any).getItem = (key: string) => {
    if (key === 'Bigmodel-Organization') return 'org-test';
    if (key === 'Bigmodel-Project') return 'proj-test';
    return null;
  };
}

describe('loadProducts', () => {
  let S: BmMainScope;

  beforeEach(() => {
    S = loadBmMainModules(['01-utils', '02-state', '05-product']);
    makeAuthSandbox(S);
  });

  it('starts passive polling at the 2 second cadence without requesting batch-preview', () => {
    const fetch = vi.fn();
    (S.window as any).fetch = fetch;
    const captured = captureTimeouts(S);
    (S.loadProducts as () => void)();
    expect(captured.length).toBe(1);
    expect(captured[0].ms).toBe(2000);
    expect(fetch).not.toHaveBeenCalled();
    expect((S._productLoadStatus as any).status).toBe('polling');
  });

  it('uses already intercepted page data immediately', () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ code: 200, data: { productList: FIXTURE_PRODUCT_LIST } }),
    });
    (S.window as any).fetch = fetch;
    (S.window as any)['bm-test-pd'] = FIXTURE_PRODUCT_LIST;

    (S.loadProducts as () => void)();

    expect(fetch).not.toHaveBeenCalled();
    expect((S._productLoadStatus as any).status).toBe('loaded');
    expect(((S._productMatrix as any).yearly || [])).toHaveLength(1);
  });

  it('loads intercepted page data discovered by a poll', () => {
    const captured = captureTimeouts(S);
    (S.loadProducts as () => void)();
    (S.window as any)['bm-test-pd'] = FIXTURE_PRODUCT_LIST;
    captured[0].fn();

    expect((S._productLoadStatus as any).status).toBe('loaded');
    expect(((S._productMatrix as any).yearly || [])).toHaveLength(1);
  });

  it('does not schedule duplicate polls while waiting for intercepted data', () => {
    const captured = captureTimeouts(S);
    (S.loadProducts as () => void)();
    (S.loadProducts as () => void)();
    expect(captured).toHaveLength(1);
    expect((S._productLoadStatus as any).status).toBe('polling');
  });

  it('shows auth error when no auth headers are available', () => {
    S.document.cookie = '';
    (S.localStorage as any).getItem = () => null;

    (S.loadProducts as () => void)();

    expect((S._productLoadStatus as any).status).toBe('error');
    expect((S._productLoadStatus as any).error).toBe('auth-missing');
  });
});

describe('buildProductMatrix with real-world shapes', () => {
  let S: BmMainScope;

  beforeAll(() => {
    S = loadBmMainModules(['01-utils', '02-state', '05-product']);
  });

  it('handles numeric amounts (not just strings)', () => {
    const matrix = (S.buildProductMatrix as (list: unknown[]) => Record<string, unknown[]>)([
      { productId: 'y-pro', monthlyPayAmount: 119, payAmount: 1428, renewAmount: 1428, soldOut: false, campaignDiscountDetails: [] },
    ]);
    expect(matrix.yearly).toHaveLength(1);
  });

  it('classifies billing via campaignDiscountDetails fallback', () => {
    const matrix = (S.buildProductMatrix as (list: unknown[]) => Record<string, unknown[]>)([
      { productId: 'x-lite', monthlyPayAmount: 0, payAmount: 0, campaignDiscountDetails: [{ campaignName: '连续包年 8 折' }] },
    ]);
    expect(matrix.yearly).toHaveLength(1);
  });

  it('returns empty groups for an empty list without throwing', () => {
    const matrix = (S.buildProductMatrix as (list: unknown[]) => Record<string, unknown[]>)([]);
    expect(matrix.monthly).toHaveLength(0);
    expect(matrix.quarterly).toHaveLength(0);
    expect(matrix.yearly).toHaveLength(0);
  });
});
