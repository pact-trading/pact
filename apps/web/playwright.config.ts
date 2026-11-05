import { defineConfig, devices } from '@playwright/test';

/**
 * Mock-mode journeys, one per PRD §9.1 scene (Operate and Scale).
 * `pnpm e2e` builds with PACT_DATA=mock into .next-preview first; the server
 * here only starts that build. Each browser context gets its own sandbox store,
 * reset before each test. Set PACT_E2E_URL (e.g. https://pay.pactagent.app)
 * to run the same journeys against a deployment instead of a local server.
 */
const port = 3150;
const remote = process.env.PACT_E2E_URL;

export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: remote ?? `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { ignoreDefaultArgs: ['--enable-features=CDPScreenshotNewSurface'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: remote
    ? undefined
    : {
        command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
        url: `http://127.0.0.1:${port}/demo`,
        reuseExistingServer: false,
        env: { PACT_DATA: 'mock', PACT_PREVIEW: '1', NEXT_TELEMETRY_DISABLED: '1' },
      },
});
