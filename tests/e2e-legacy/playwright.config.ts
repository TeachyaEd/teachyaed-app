import { defineConfig, devices } from '@playwright/test';

// Legacy monolith E2E config. Target is always the local static server
// serving the ephemeral, staging-configured copy of root index.html
// produced by ci/generate-staging-artifact.mjs -- never a live URL,
// never production, never /web.

const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 4173;
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // The legacy app is a single shared-state monolith (global `S` object,
  // module-level Supabase client). Cross-test interference is a real risk
  // until fixtures are proven stable -- keep serial until Phase 3 fixtures
  // are confirmed isolated per test (e.g. per-test school/profile rows).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
