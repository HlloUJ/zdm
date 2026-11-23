import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.ZDM_E2E_PORT || 5275);
const baseURL = `http://127.0.0.1:${port}`;
const workers = process.env.ZDM_E2E_WORKERS ? Number(process.env.ZDM_E2E_WORKERS) : undefined;
if (workers !== undefined && (!Number.isInteger(workers) || workers < 1)) {
  throw new Error('ZDM_E2E_WORKERS 必须为正整数');
}
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  workers,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, screenshot: 'only-on-failure', trace: 'off' },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL } }],
});
