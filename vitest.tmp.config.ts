import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/mcp/tools/kg-stats.test.ts'],
    exclude: ['tests/integration.test.ts'],
    testTimeout: 60000,
    globalTeardown: './tests/global-teardown.ts',
  }
});