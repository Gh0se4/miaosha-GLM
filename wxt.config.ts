import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  outDir: 'output',
  vite: () => ({
    build: {
      // Use Terser instead of the default Rolldown/esbuild minifier. The
      // default minifier reused a mangled identifier (`A`) for both a
      // top-level constant (SALE_TIME_DEFAULT) and a helper function in the
      // same scope, silently corrupting runtime semantics.
      minify: 'terser',
      terserOptions: {
        mangle: {
          // Keep function/class names to avoid collisions with mangled
          // top-level constants imported from other modules.
          keep_fnames: true,
        },
      },
    },
  }),
  manifest: {
    name: '抢购助手',
    description: '多平台 Coding Plan 抢购助手浏览器扩展',
    permissions: ['storage', 'tabs', 'activeTab', 'scripting', 'alarms', 'notifications', 'declarativeNetRequest'],
    host_permissions: ['*://bigmodel.cn/*', '*://*.bigmodel.cn/*', '*://*.volcengine.com/*', 'http://127.0.0.1:9898/*'],
    declarative_net_request: {
      rule_resources: [
        {
          id: 'blend-headers',
          enabled: true,
          path: 'rules/headers.json',
        },
      ],
    },
    web_accessible_resources: [
      {
        resources: ['bm-early.js', 'bm-main.js'],
        matches: ['*://bigmodel.cn/*', '*://*.bigmodel.cn/*'],
      },
      {
        resources: ['volc-agentplan-main.js', 'volc-codingplan-main.js'],
        matches: ['*://*.volcengine.com/*'],
      },
    ],
  },
});
