import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { artifactPath } from './fullstack/runtime';

const backendPort = 30_000 + (process.pid % 20_000);
const frontendPort = 53_000 + (process.pid % 5_000);
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
process.env['T010_BACKEND_ORIGIN'] = backendOrigin;
process.env['T010_FRONTEND_ORIGIN'] = frontendOrigin;
process.env['T010_ARTIFACT_DIR'] ??= artifactPath(`run-${process.pid}`);

export default defineConfig({
  testDir: './fullstack',
  testMatch: '**/*.spec.ts',
  globalSetup: './fullstack/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: artifactPath('playwright-results'),
  use: {
    ...devices['Desktop Chrome'],
    baseURL: frontendOrigin,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --config e2e/support/vite.fullstack.config.ts --host 127.0.0.1 --port ${frontendPort} --strictPort`,
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    url: frontendOrigin,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { T010_BACKEND_ORIGIN: backendOrigin },
  },
});
