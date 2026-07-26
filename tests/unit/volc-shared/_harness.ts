/**
 * volc-shared test harness
 *
 * src/volc-shared/*.js are the vanilla-JS MAIN-world overlay modules shared by
 * the volcengine Agent Plan and Coding Plan verticals (each variant adds only
 * its own 00-config.js). They declare functions/vars in the global scope and
 * have no ES module exports.
 *
 * Strategy: execute each file via Node's `vm.runInContext` so its top-level
 * `var`/`function` declarations land in the provided sandbox for tests.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

const SRC_DIR = resolve(__dirname, '../../../src/volc-shared');

export type VolcSharedScope = Record<string, unknown>;

function makeSandbox(): VolcSharedScope {
  const doc = {
    getElementById: (_id: string) => null,
    createElement: (_tag: string) => ({
      appendChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      style: {},
      innerHTML: '',
      textContent: '',
      className: '',
      id: '',
    }),
    body: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    cookie: '',
  };

  const win = {
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
  };

  return {
    document: doc,
    window: win,
    sessionStorage: { getItem: () => null, setItem: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    performance: { now: () => Date.now() },
    setTimeout: (fn: Function, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as number),
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ code: 200 }) }),
    console,
    Math,
    Date,
  };
}

export function loadVolcSharedModules(moduleNames: string[]): VolcSharedScope {
  const sandbox = vm.createContext(makeSandbox());

  for (const name of moduleNames) {
    const filePath = resolve(SRC_DIR, name.endsWith('.js') ? name : `${name}.js`);
    const code = readFileSync(filePath, 'utf8');
    vm.runInContext(code, sandbox);
  }

  return sandbox as VolcSharedScope;
}
