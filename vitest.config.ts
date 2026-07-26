import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [WxtVitest(), svelte()],
  /**
   * Vite 8 uses Rolldown as its dependency optimizer. When it pre-bundles the
   * test dependency graph for the browser (happy-dom) environment, Rolldown's
   * injected runtime helper (`\0rolldown/runtime.js`) imports `node:module`,
   * which cannot be resolved for a browser target and aborts test startup with
   * a RESOLVE_ERROR. Keeping Node built-ins external to the optimizer output
   * lets that helper import resolve normally in the Node test runner. This
   * replaces the old `test.deps.optimizer.*.enabled: false` toggle, which no
   * longer suppresses optimization under Vitest 4 + Vite 8.
   */
  optimizeDeps: {
    rollupOptions: { external: [/^node:/] },
  },
  resolve: {
    /**
     * 'browser' condition is required for Svelte 5 to use the client-side
     * runtime (svelte/internal/client) instead of SSR (svelte/internal/server).
     */
    conditions: ['browser'],
  },
  test: {
    /**
     * happy-dom is faster than jsdom and sufficient for our needs. The whole
     * suite (unit, storage, bm-main vanilla-JS harness, Svelte components)
     * runs under happy-dom; there is no separate Playwright/E2E tier.
     */
    environment: 'happy-dom',

    /**
     * Global test setup: imports @testing-library/jest-dom matchers and resets
     * fakeBrowser state between tests.
     */
    setupFiles: ['./tests/setup.ts'],

    /**
     * Test file patterns:
     *  - tests/**\/*.test.ts / .test.js  — unit & integration tests
     *  - tests/**\/*.svelte.test.ts      — Svelte component tests (runes-aware)
     *
     * bm-main vanilla-JS tests live under tests/unit/bm-main/ and are imported
     * via the harness pattern defined in tests/unit/bm-main/_harness.ts.
     */
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.js',
      'tests/**/*.svelte.test.ts',
    ],

    /**
     * Exclude non-test directories. The build pipeline (build-overlay →
     * wxt build → verify-no-minifier-collision) runs separately from vitest.
     */
    exclude: [
      'scripts/**',
      'node_modules/**',
      'output/**',
      'public/**',
    ],

    globals: true,
  },
});
