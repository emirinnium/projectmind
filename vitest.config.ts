import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/mcp/tools/kg-stats.test.ts', 'tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['tests/integration.test.ts'],
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov'],
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
