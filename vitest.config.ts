import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: [
      'src/mcp/tools/kg-stats.test.ts',
      'tests/**/*.test.ts',
      'src/**/__tests__/**/*.test.ts',
    ],
    exclude: ['tests/integration.test.ts'],
    // TypeScript checker-heavy fixer tests exceed one minute only while V8
    // coverage instrumentation is active. Keep the normal suite strict and
    // give the coverage job a bounded, explicit budget instead of letting
    // valid tests fail due to instrumentation overhead.
    testTimeout: process.argv.includes('--coverage') ? 120000 : 60000,
    // The post-edit TypeScript gate and SQLite fixture migrations are
    // deliberately CPU/IO-heavy. Capping file workers keeps the suite
    // deterministic on Windows/OneDrive and on small CI runners.
    maxWorkers: 4,
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
        // Keep the gate above the historical bootstrap floor. CLI and MCP
        // registration modules remain excluded because they are exercised by
        // contract/smoke suites, while core logic must retain this minimum.
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50,
      },
    },
  },
});
