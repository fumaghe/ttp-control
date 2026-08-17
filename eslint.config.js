// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Files ESLint must never look at.
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'data/**',
      'backups/**',
      'src/generated/**',
      'prisma/migrations/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Type-aware linting driven by tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* Unused code: allow the `_` prefix escape hatch, flag everything else. */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      /* Enforce `import type` so runtime imports stay explicit under ESM. */
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      /* Async correctness matters a lot here: every Discord interaction has a
         3 second ack budget, and a dropped promise means a dead interaction. */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      /* We never want to silently paper over types in business logic. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      /* Logging goes through the logger, not console. */
      'no-console': ['warn', { allow: ['error'] }],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
    },
  },

  {
    // Scripts and tests are allowed to talk to the terminal directly.
    files: ['scripts/**/*.ts', 'tests/**/*.ts', '*.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // Root-level JS config files are outside the TypeScript program, so
    // type-aware rules cannot run on them.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-console': 'off',
    },
  },

  // Must stay last: turns off every rule that would fight Prettier.
  prettierConfig,
);
