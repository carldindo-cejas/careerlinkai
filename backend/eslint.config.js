import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ESLint flat config (FULLPLAN §18, §47 — `tsc --noEmit` + ESLint replace PHPStan/Pint).
 *
 * The type-checked rule set is used deliberately: most of what this codebase can get wrong
 * is type-shaped (an unawaited promise on a D1 write, an `any` leaking out of a JSON parse),
 * and those rules only exist in the type-aware configs.
 */
export default tseslint.config(
  { ignores: ['.wrangler/**', 'node_modules/**', 'worker-configuration.d.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A forgotten `await` on a D1 write is the single most likely runtime bug here — a
      // Worker can be torn down before an un-awaited insert ever reaches the database.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Import order is enforced by Prettier's organize-imports in practice; keeping the
      // consistent-type-imports rule means `import type` stays accurate, which
      // `verbatimModuleSyntax` in tsconfig requires to emit correctly.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },

  {
    // Tests reach into bindings and fixtures in ways the strict type-checked rules flag as
    // unsafe; the assertions themselves are the safety net there.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // A response body is untyped JSON off the wire — typing it as anything but `any` would
      // mean re-declaring the whole API contract in the helpers, and then a test would be
      // asserting against that declaration instead of against what the Worker actually sent.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
