// @ts-check
import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default defineConfig([
  // Build output e client generato da Prisma non vengono mai lintati.
  globalIgnores(['dist/**', 'coverage/**', 'node_modules/**', 'src/generated/**', '.wrangler/**']),

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // Due progetti: il codice condiviso + gli script sotto tsconfig.tools,
        // il Worker sotto i tipi Cloudflare. Senza il secondo, src/worker/**
        // resterebbe fuori dalle regole type-aware.
        project: ['./tsconfig.tools.json', './tsconfig.worker.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      /* --- Correctness --------------------------------------------------- */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-constant-binary-expression': 'error',

      /* --- Security / secret hygiene ------------------------------------- */
      // Il logger dedicato e' l'unico canale di output ammesso: console.*
      // aggira la redazione dei secret configurata in src/utils/logger.ts.
      'no-console': 'error',
      // Gli ID Discord e i secret si leggono solo dalla config tipizzata.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Usa la config tipizzata in src/config/env.ts invece di process.env.',
        },
      ],

      /* --- Pragmatismo ---------------------------------------------------- */
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  {
    // Unici punti in cui e' lecito leggere process.env direttamente.
    files: ['src/config/env.ts', 'src/utils/logger.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  {
    // Script, test e file di configurazione: non sono codice di runtime del bot.
    files: ['scripts/**/*.ts', 'tests/**/*.ts', '*.config.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-properties': 'off',
    },
  },

  {
    // I test double implementano interfacce che restituiscono Promise, ma il
    // loro corpo e' sincrono: `require-await` qui segnalerebbe solo il fatto
    // che non c'e' I/O, che e' esattamente il punto di un doppio in memoria.
    files: ['tests/support/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  {
    // I file di configurazione .js di root non sono coperti da un tsconfig:
    // niente regole type-aware su di loro.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Deve restare l'ultimo: disattiva le regole in conflitto con Prettier.
  prettierConfig,
]);
