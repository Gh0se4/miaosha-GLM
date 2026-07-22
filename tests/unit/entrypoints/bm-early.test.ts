import { describe, expect, it } from 'vitest';
import * as vm from 'vm';

import EARLY_SOURCE from '../../../public/bm-early.js?raw';

function runEarlyScript(storage: Map<string, string>, random: () => number) {
  class FakeXMLHttpRequest {
    open() {}
    send() {}
  }
  const window: Record<string, any> = {
    fetch: () => Promise.resolve(),
    XMLHttpRequest: FakeXMLHttpRequest,
  };
  vm.runInNewContext(EARLY_SOURCE, {
    window,
    XMLHttpRequest: FakeXMLHttpRequest,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
    Math: { random },
    console,
  });
}

describe('bm-early session namespace', () => {
  it('creates a random namespace when the tab has none', () => {
    const storage = new Map<string, string>();
    const randomValue = 0.123456;

    runEarlyScript(storage, () => randomValue);

    expect(storage.get('_st')).toBe('b' + randomValue.toString(36).slice(2, 8));
  });

  it('reuses the existing namespace after a same-tab reload', () => {
    const storage = new Map<string, string>();
    let randomCalls = 0;
    runEarlyScript(storage, () => { randomCalls++; return 0.123456; });
    const firstNamespace = storage.get('_st');

    runEarlyScript(storage, () => { randomCalls++; return 0.987654; });

    expect(storage.get('_st')).toBe(firstNamespace);
    expect(randomCalls).toBe(1);
  });
});
