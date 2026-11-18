import process from 'node:process';
import { defineConfig, devices } from '@playwright/test';

// Kräver en migrerad databas med demodata (npm run db:migrate && npm run db:seed).
// Utan E2E_BASE_URL startas API och webb med `npm run dev`, eller återanvänds om de redan körs.
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:5173';
const isCI = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    // Samma zon som företaget i demodatan, så att tider i testerna går att jämföra.
    timezoneId: 'Europe/Stockholm',
    locale: 'sv-SE',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobil', use: { ...devices['Pixel 7'] } },
    { name: 'dator', use: { ...devices['Desktop Chrome'] } },
  ],
  ...(process.env['E2E_BASE_URL'] === undefined && {
    webServer: {
      command: 'npm run dev',
      url: `${baseURL}/api/v1/health`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  }),
});
