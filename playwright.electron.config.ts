import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for Electron-specific E2E tests.
 * These tests run against the actual Electron application.
 * @see https://playwright.dev/docs/api/class-electron
 */
export default defineConfig({
  testDir: './e2e-electron',
  
  /* Run tests serially since we're testing a single Electron app instance */
  fullyParallel: false,
  
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  
  /* Single worker for Electron tests */
  workers: 1,
  
  /* Reporter to use */
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report-electron' }],
    ['list'],
  ],
  
  /* Global timeout for each test - longer for Electron */
  timeout: 60 * 1000,
  
  /* Expect timeout */
  expect: {
    timeout: 10000,
  },
  
  /* No webServer needed - we launch Electron directly */
});

