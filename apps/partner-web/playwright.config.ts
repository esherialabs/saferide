import { defineConfig } from '@playwright/test';

// The e2e tests run the built static export (out/) behind the mock API on
// one origin, under the strict CSP P7 is expected to serve. Build first.
const port = Number(process.env.PARTNER_MOCK_PORT ?? 4320);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    locale: 'en-GB',
    timezoneId: 'Africa/Nairobi',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  webServer: {
    command: 'node mock/server.mjs',
    url: `http://localhost:${port}/sign-in/`,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
