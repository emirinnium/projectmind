import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      'no-unused-vars': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': 'off',
      'prefer-const': 'off',
      'no-var': 'error',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-require-imports': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    ignores: [
      'dist/',
      'dist-tests/',
      'node_modules/',
      'coverage/',
      '**/*.js',
      '**/*.mjs',
      '**/*.d.ts',
      '**/*.map',
    ],
  },
];
