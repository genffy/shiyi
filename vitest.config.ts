import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // the frontend (manually verified in a browser) and the CLI entry (commander wiring) stay out of unit-test stats
      exclude: ['src/web/**', 'src/cli/**', 'tests/**'],
      reporter: ['text', 'text-summary'],
    },
  },
});
