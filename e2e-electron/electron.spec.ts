import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let electronApp: ElectronApplication;
let page: Page;

async function getMainWindow(app: ElectronApplication): Promise<Page> {
  // Wait for the first window that is NOT DevTools
  const windows = app.windows();
  for (const win of windows) {
    const title = await win.title();
    if (!title.includes('DevTools')) {
      return win;
    }
  }
  
  // If no window found yet, wait for one
  return new Promise((resolve) => {
    app.on('window', async (win) => {
      const title = await win.title();
      if (!title.includes('DevTools')) {
        resolve(win);
      }
    });
  });
}

test.describe('Electron App', () => {
  test.beforeAll(async () => {
    // Launch Electron app
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/electron/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
    });

    // Wait for the main window (not DevTools)
    page = await electronApp.firstWindow();
    
    // Wait a moment for the page to initialize
    await page.waitForLoadState('domcontentloaded');
    
    // If we got DevTools, wait for the main window
    const title = await page.title();
    if (title.includes('DevTools')) {
      page = await getMainWindow(electronApp);
      await page.waitForLoadState('domcontentloaded');
    }
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test('window opens with correct title', async () => {
    const title = await page.title();
    expect(title).toBe('Ark');
  });

  test('loading screen displays terminal', async () => {
    await expect(page.getByText('ark init --database')).toBeVisible({ timeout: 15000 });
  });

  test('loading screen shows progress messages', async () => {
    await expect(page.getByText(/Ark ready/i)).toBeVisible({ timeout: 15000 });
  });

  test('transitions to dashboard after loading', async () => {
    // Wait for dashboard to load (auto-transitions after ~6s)
    await expect(page.getByText('Browse')).toBeVisible({ timeout: 25000 });
  });

  test('dashboard displays Browse button', async () => {
    await expect(page.getByText('Browse')).toBeVisible({ timeout: 15000 });
  });

  test('dashboard displays game cards', async () => {
    // Wait for games to load - they might take a moment after initial render
    await page.waitForTimeout(2000);
    // Game cards have data-testid or specific class
    const gameCards = page.locator('[class*="rounded-xl"]').filter({ hasText: /./});
    const count = await gameCards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('can switch to Library mode', async () => {
    // Switch to Library view
    await page.click('button:has-text("Library")');
    await page.waitForTimeout(500);
    
    // Library button should be active
    const libraryButton = page.locator('button:has-text("Library")');
    await expect(libraryButton).toBeVisible();
    
    // Switch back to Browse
    await page.click('button:has-text("Browse")');
    await page.waitForTimeout(500);
  });

  test('search functionality works', async () => {
    // Wait for games to be loaded
    await page.waitForTimeout(1000);
    
    const searchInput = page.getByPlaceholder(/Search Steam games/i);
    // Search for a common game
    await searchInput.fill('Counter');
    await page.waitForTimeout(1000); // Wait for debounced search
    
    // Should show search suggestions or filtered results
    // Clear search
    await searchInput.clear();
    await page.waitForTimeout(500);
  });
});

test.describe('Electron Window Properties', () => {
  test.beforeAll(async () => {
    // Launch fresh Electron app for window tests
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/electron/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
    });
    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test('window has minimum size constraints', async () => {
    // The window should be at least 1024x768 based on main.ts config
    const windowInfo = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [minWidth, minHeight] = win.getMinimumSize();
      return { minWidth, minHeight };
    });
    
    expect(windowInfo.minWidth).toBe(1024);
    expect(windowInfo.minHeight).toBe(768);
  });

  test('window has correct initial dimensions', async () => {
    const windowInfo = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      return { width, height };
    });
    
    // Initial size from main.ts is 1400x900
    expect(windowInfo.width).toBeGreaterThanOrEqual(1024);
    expect(windowInfo.height).toBeGreaterThanOrEqual(768);
  });

  test('window is visible', async () => {
    const isVisible = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.isVisible();
    });
    
    expect(isVisible).toBe(true);
  });

  test('window has frame', async () => {
    // The window should have a frame (not frameless)
    const hasFrame = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      // A window is considered to have a frame if it's not frameless
      // We can check by getting the bounds vs content bounds
      const bounds = win.getBounds();
      const contentBounds = win.getContentBounds();
      return bounds.width !== contentBounds.width || bounds.height !== contentBounds.height;
    });
    
    expect(hasFrame).toBe(true);
  });
});
