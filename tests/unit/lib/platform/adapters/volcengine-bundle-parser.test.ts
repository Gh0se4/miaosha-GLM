import { afterEach, describe, expect, it } from 'vitest';

import { extractConfigsFromBundle } from '../../../../../lib/platform/adapters/volcengine-shared/bundle-parser';

const GLOBAL = '__activity__test__';

/**
 * The parser reads window[globalName] and calls .toString(). Stub toString so
 * the exact (minified-style) source is under test control and not reformatted
 * by the test transpiler.
 */
function setFactory(src: string) {
  const fn = function () {};
  fn.toString = () => src;
  (window as any)[GLOBAL] = fn;
}

afterEach(() => {
  delete (window as any)[GLOBAL];
});

describe('extractConfigsFromBundle', () => {
  it('returns [] when the global factory is absent', () => {
    expect(extractConfigsFromBundle({ globalName: GLOBAL, productCode: 'ark_bd' })).toEqual([]);
  });

  it('extracts an IndexKey + matching-product config from the bundle source', () => {
    setFactory(
      'function(){return {commonBuyOpenApi:{IndexKey:"idx-1",ConfigList:[' +
      '{Product:"ark_bd",ConfigurationCode:"Coding_Plan_Pro_monthly",Duration:1,DurationUnit:"monthly",RenewType:2,PurchaseTimes:1}' +
      ']}};}',
    );

    const items = extractConfigsFromBundle({ globalName: GLOBAL, productCode: 'ark_bd' });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      indexKey: 'idx-1',
      configBody: { Product: 'ark_bd', ConfigurationCode: 'Coding_Plan_Pro_monthly', Duration: 1 },
    });
  });

  it('skips configs whose Product does not match', () => {
    setFactory(
      'function(){return {commonBuyOpenApi:{IndexKey:"idx-1",ConfigList:[' +
      '{Product:"ark_other",ConfigurationCode:"X",Duration:1}' +
      ']}};}',
    );
    expect(extractConfigsFromBundle({ globalName: GLOBAL, productCode: 'ark_bd' })).toEqual([]);
  });

  it('honors excludeIndexKey', () => {
    setFactory(
      'function(){return {commonBuyOpenApi:{IndexKey:"idx-1",ConfigList:[' +
      '{Product:"ark_bd",ConfigurationCode:"Pro",Duration:1}' +
      ']}};}',
    );
    const items = extractConfigsFromBundle({
      globalName: GLOBAL,
      productCode: 'ark_bd',
      excludeIndexKey: (k) => k === 'idx-1',
    });
    expect(items).toEqual([]);
  });

  it('returns [] (does not throw) on a malformed config literal', () => {
    // `undefined` is not valid JSON even after the key-quoting rewrite.
    setFactory(
      'function(){return {commonBuyOpenApi:{IndexKey:"idx-1",ConfigList:[' +
      '{Product:"ark_bd",ConfigurationCode:"Pro",Bad:undefined}' +
      ']}};}',
    );
    expect(() => extractConfigsFromBundle({ globalName: GLOBAL, productCode: 'ark_bd' })).not.toThrow();
    expect(extractConfigsFromBundle({ globalName: GLOBAL, productCode: 'ark_bd' })).toEqual([]);
  });

  it('prefers the entry with RenewType/PurchaseTimes and accumulates index-key candidates', () => {
    setFactory(
      'function(){var a={commonBuyOpenApi:{IndexKey:"idx-worse",ConfigList:[' +
      '{Product:"ark_bd",ConfigurationCode:"Pro",Duration:1}]}};' +
      'var b={commonBuyOpenApi:{IndexKey:"idx-better",ConfigList:[' +
      '{Product:"ark_bd",ConfigurationCode:"Pro",Duration:1,RenewType:2,PurchaseTimes:1}]}};return [a,b];}',
    );

    const items = extractConfigsFromBundle({ globalName: GLOBAL, productCode: 'ark_bd' });

    expect(items).toHaveLength(1);
    expect(items[0].indexKey).toBe('idx-better');
    expect(items[0].configBody).toMatchObject({ RenewType: 2, PurchaseTimes: 1 });
    expect(items[0].indexKeyCandidates).toEqual(['idx-worse', 'idx-better']);
  });
});
