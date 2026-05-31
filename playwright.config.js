import { defineConfig, devices } from '@playwright/test';

// Visual + behavior baseline for the frontend overhaul (tests/frontend/visual).
//
// The app server is booted with DUMMY FileMaker creds so it never touches the
// production backend — all /api/** calls are intercepted and served from
// captured fixtures (tests/frontend/visual/fixtures), so pages render
// deterministically and the visual diffs are trustworthy.

const PORT = process.env.PW_PORT || '3998';
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/frontend/visual',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  // Slightly forgiving so anti-aliasing noise doesn't cause false failures, but
  // tight enough to catch a real layout regression.
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: 'node server.js',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT,
      HOST: '127.0.0.1',
      NODE_ENV: 'development', // relaxed rate limits
      // Dummy creds — server boots and serves static HTML; FM is never reached
      // because the spec intercepts every /api/** request.
      FM_HOST: 'https://fm.invalid',
      FM_DB: 'TestDB',
      FM_USER: 'test',
      FM_PASS: 'test',
      FM_LAYOUT: 'API_Album_Songs',
      FM_TOKENS_LAYOUT: 'API_Access_Tokens',
      FM_TIMEZONE_OFFSET: '0',
      AUTH_SECRET: 'test-auth-secret',
      ADMIN_SECRET: 'test-admin-secret',
      PAYSTACK_SECRET_KEY: 'sk_test_dummy',
      PAYSTACK_PUBLIC_KEY: 'pk_test_dummy',
      EMAIL_HOST: 'smtp.invalid',
      EMAIL_PORT: '587',
      EMAIL_USER: 'test@test',
      EMAIL_PASS: 'test',
      EMAIL_FROM: 'test@test',
    },
  },
});
