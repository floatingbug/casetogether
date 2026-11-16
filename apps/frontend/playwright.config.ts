import { defineConfig, devices } from '@playwright/test';

const PLAYWRIGHT_TEST_PORT = 5175;
const PLAYWRIGHT_TEST_ORIGIN = `http://127.0.0.1:${PLAYWRIGHT_TEST_PORT}`;

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['fullstack/**'],
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] === 'true' ? 1 : 0,
  ...(process.env['CI'] === 'true' ? { workers: 1 } : {}),
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: PLAYWRIGHT_TEST_ORIGIN,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PLAYWRIGHT_TEST_PORT} --strictPort`,
    url: PLAYWRIGHT_TEST_ORIGIN,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
