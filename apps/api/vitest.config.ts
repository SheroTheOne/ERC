import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/db/**/*.test.ts', 'test/integration/**/*.test.ts'],
          globalSetup: ['test/setup/global-setup.ts'],
          // Varje testfil får en egen databas, men starten av containern är delad.
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
