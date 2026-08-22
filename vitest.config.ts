import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration.test.ts'],
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/**',
        'src/cli/commands/**',
        'src/mcp/tools/**',
        '**/index.ts',
        '**/*.d.ts',
      ],
      thresholds: {
        statements: 34,
        branches: 30,
        functions: 35,
        lines: 35,
      },
    },
  },
});
