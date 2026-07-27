import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Minimal, high-signal lint baseline.
 *
 * Scope: the TypeScript sources (lib/, entrypoints/, tests/) and Node build
 * scripts. Deliberately NOT linted here (tracked as a separate follow-up in
 * docs/HANDOFF.md): the hand-written MAIN-world IIFE overlays under src/*
 * (they rely on implicit cross-file globals) and .svelte components (need the
 * svelte plugin). Only "possible problems" rules are enabled — no stylistic
 * opinions — so the baseline is green on the existing code and CI stays
 * out-of-the-box. Broaden incrementally.
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.wxt/**',
      '.output/**',
      'output/**',
      'public/**',
      'src/**',
      '**/*.svelte',
    ],
  },
  {
    files: ['lib/**/*.ts', 'entrypoints/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, chrome: 'readonly' },
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-constant-binary-expression': 'error',
      'getter-return': 'error',
      'no-cond-assign': ['error', 'except-parens'],
    },
  },
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': ['error', 'except-parens'],
    },
  },
);
