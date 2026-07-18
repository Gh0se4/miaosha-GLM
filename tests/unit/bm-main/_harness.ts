/**
 * bm-main test harness
 *
 * The src/bm-main/*.js modules are vanilla JS scripts designed to be
 * concatenated and injected into a page's MAIN world. They declare functions
 * and vars in the global scope — they have no ES module exports.
 *
 * Strategy: execute each source file via Node's `vm.runInContext`, which
 * runs the script inside an explicitly provided sandbox object. All top-level
 * `var` declarations and `function` declarations are written into the sandbox,
 * making them accessible to tests.
 *
 * Usage:
 *   const scope = loadBmMainModules(['01-utils', '05-product']);
 *   const matrix = scope.buildProductMatrix(productList);
 *
 * Always include dependency files before dependents
 * (e.g. '01-utils' before '05-product').
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

const SRC_DIR = resolve(__dirname, '../../../src/bm-main');

interface StorageStub {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BmMainScope extends Record<string, unknown> {
  document: { cookie: string; [key: string]: unknown };
  window: Record<string, unknown>;
  sessionStorage: StorageStub;
  localStorage: StorageStub;
}

/**
 * Minimal browser-API stubs.
 * Only stub what the loaded modules actually call at parse-time or in
 * the specific functions under test. Add stubs here as needed.
 */
function makeSandbox(): BmMainScope {
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

  const sandbox: BmMainScope = {
    // Production loads 00-css before state/product modules. Product-focused
    // tests intentionally omit that CSS module, so expose only its runtime
    // globals here rather than evaluating unrelated UI setup.
    _NS: 'bm-test-',
    MSG_CMD: 'bm-test-c',
    MSG_EVT: 'bm-test-e',
    MSG_OVL: 'bm-test-o',
    SK_BP: 'bp',
    SK_PR: 'pr',
    SK_TK: 'tk',
    SK_BL: 'bl',
    SK_PL: 'pl',
    document: doc,
    window: { postMessage: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    performance: { now: () => Date.now() },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    AudioContext: class {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ code: 200, data: { productList: [] } }) }),
    AbortController: class {
      signal = { aborted: false };
      abort() { (this.signal as { aborted: boolean }).aborted = true; }
    },
    console,
  };

  return sandbox;
}

/**
 * Load one or more bm-main source files into a shared vm sandbox.
 * Returns the sandbox so tests can invoke functions by name.
 */
export function loadBmMainModules(moduleNames: string[]): BmMainScope {
  const sandbox = vm.createContext(makeSandbox());

  for (const name of moduleNames) {
    const filePath = resolve(SRC_DIR, name.endsWith('.js') ? name : `${name}.js`);
    const code = readFileSync(filePath, 'utf8');
    vm.runInContext(code, sandbox);
  }

  return sandbox as BmMainScope;
}
