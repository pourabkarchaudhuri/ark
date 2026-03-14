import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let electronApp: ElectronApplication;
let page: Page;

async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const windows = app.windows();
  for (const win of windows) {
    const title = await win.title();
    if (!title.includes('DevTools')) return win;
  }
  return new Promise((resolve) => {
    app.on('window', async (win) => {
      const title = await win.title();
      if (!title.includes('DevTools')) resolve(win);
    });
  });
}

async function waitForDashboard(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  // Splash then dashboard; allow up to 90s for cold start
  await expect(page.getByRole('button', { name: 'Browse' })).toBeVisible({ timeout: 90000 });
  await page.waitForTimeout(2000);
}

test.describe('Top Sellers dashboard', () => {
  test.setTimeout(150000);

  test.beforeAll(async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/electron/main.js')],
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 60000,
    });
    page = await electronApp.firstWindow({ timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    const title = await page.title();
    if (title.includes('DevTools')) {
      page = await getMainWindow(electronApp);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000);
    }
    // Enable E2E mock so getTopSellers returns 100+ when Epic is unavailable (CI)
    await page.evaluate(() => localStorage.setItem('e2e-top-sellers-mock', 'true'));
    await waitForDashboard(page);
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test('Top Sellers shows more than 38 games (full list, not Steam-only cap)', async () => {
    // Dismiss changelog if open
    const gotIt = page.getByRole('button', { name: /Got it|Close changelog/i });
    if (await gotIt.isVisible()) {
      await gotIt.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Ensure we're on Browse and default category is Top Sellers (trending)
    await expect(page.getByRole('button', { name: 'Browse' })).toBeVisible();
    await expect(page.getByText('games of')).toBeVisible({ timeout: 15000 });

    // Wait for initial load then for retries (2s and 5s) so we get full list when Epic loads
    await page.waitForTimeout(10000);

    // Wait for count to be stable (retry may update 38 -> 137)
    const countEl = page.locator('[data-testid="browse-game-count"]');
    await expect(countEl).toBeVisible({ timeout: 10000 });
    const countText = await countEl.textContent();
    const count = parseInt(countText?.replace(/,/g, '') ?? '0', 10);

    expect(count, `Top Sellers should show full list (>38), got ${count}`).toBeGreaterThan(38);
  });
});
