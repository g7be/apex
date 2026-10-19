import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@indy/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)) } },
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
