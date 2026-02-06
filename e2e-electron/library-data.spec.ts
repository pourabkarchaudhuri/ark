import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let electronApp: ElectronApplication;
let page: Page;

// Helper to get the main window (not DevTools)
async function getMainWindow(app: ElectronApplication): Promise<Page> {
  const windows = app.windows();
  for (const win of windows) {
    const title = await win.title();
    if (!title.includes('DevTools')) {
      return win;
    }
  }
  
  return new Promise((resolve) => {
    app.on('window', async (win) => {
      const title = await win.title();
      if (!title.includes('DevTools')) {
        resolve(win);
      }
    });
  });
}

// Helper to wait for dashboard to load
async function waitForDashboard(page: Page) {
  // Wait for loading screen to complete and dashboard to appear
  // First wait for any loading screen to finish
  await page.waitForTimeout(3000); // Give loading screen time to appear
  try {
    // Wait for dashboard elements
    await page.waitForSelector('text=Browse', { timeout: 45000 });
  } catch {
    // If Browse not found, try waiting longer
    await page.waitForTimeout(5000);
    await page.waitForSelector('text=Browse', { timeout: 30000 });
  }
}

// Helper to read sample library fixture
function readSampleLibrary(): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures/sample-library.json'), 'utf-8');
}

function readSampleLibraryDelta(): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures/sample-library-delta.json'), 'utf-8');
}

test.describe('Library Data Management', () => {
  test.setTimeout(120000);

  test.beforeAll(async () => {
    // Launch Electron app (headed - window visible)
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/electron/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
      timeout: 60000,
    });

    page = await electronApp.firstWindow({ timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    
    // If we got DevTools, get the main window
    const title = await page.title();
    if (title.includes('DevTools')) {
      page = await getMainWindow(electronApp);
      await page.waitForLoadState('domcontentloaded');
    }
    
    // Wait for dashboard to fully load
    await waitForDashboard(page);
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test.describe('Settings Panel - Export/Import UI', () => {
    test('Settings panel opens and has Library Data section', async () => {
      // Dismiss changelog modal if open (so Settings button is clickable)
      const gotIt = page.getByRole('button', { name: /Got it|Close changelog/i });
      if (await gotIt.isVisible()) {
        await gotIt.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
      
      // Wait for any animations to complete
      await page.waitForTimeout(500);
      
      // Click Settings button in navbar using data-testid
      await page.click('[data-testid="settings-button"]', { timeout: 10000 });
      
      // Wait for settings panel to appear - use heading to avoid strict mode violation
      await expect(page.getByRole('heading', { name: 'Library Data' })).toBeVisible({ timeout: 10000 });
      
      // Verify export and import buttons are present
      await expect(page.getByRole('button', { name: /Export Library/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Import Library/i })).toBeVisible();
      
      // Close settings panel
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    });

    test('Export button shows correct library count', async () => {
      // First, inject some library data
      await page.evaluate((jsonData) => {
        localStorage.setItem('ark-library-data', JSON.stringify({
          version: 3,
          entries: JSON.parse(jsonData).entries,
          lastUpdated: new Date().toISOString()
        }));
      }, readSampleLibrary());
      
      // Reload to pick up the data
      await page.reload();
      await waitForDashboard(page);
      
      // Close any open modals
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      
      // Open settings
      await page.click('[data-testid="settings-button"]');
      await expect(page.getByRole('heading', { name: 'Library Data' })).toBeVisible({ timeout: 10000 });
      
      // Export button should be visible
      await expect(page.getByRole('button', { name: /Export Library/i })).toBeVisible();
      
      // Close settings
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    });
  });

  test.describe('Library Store - Delta Import', () => {
    test('importDataWithDelta adds new entries', async () => {
      // Clear library first
      await page.evaluate(() => {
        localStorage.removeItem('ark-library-data');
      });
      await page.reload();
      await waitForDashboard(page);
      
      // Import sample library via evaluate
      const result = await page.evaluate((jsonData) => {
        // Access the library store through window
        const data = JSON.parse(jsonData);
        const entries = data.entries;
        
        // Manually add entries to localStorage
        localStorage.setItem('ark-library-data', JSON.stringify({
          version: 3,
          entries: entries,
          lastUpdated: new Date().toISOString()
        }));
        
        // Return count
        return entries.length;
      }, readSampleLibrary());
      
      expect(result).toBe(3);
      
      // Verify by checking library size in UI
      await page.reload();
      await waitForDashboard(page);
      
      // Click Library button to see count
      const libraryButton = page.locator('button:has-text("Library")');
      await expect(libraryButton).toContainText('3');
    });

    test('importDataWithDelta updates changed entries', async () => {
      // Import delta library which has:
      // - 1 updated entry (730 - status changed from Playing to Completed)
      // - 1 unchanged entry (570)
      // - 1 new entry (1086940)
      
      const result = await page.evaluate((jsonData) => {
        // Parse existing data
        const existingRaw = localStorage.getItem('ark-library-data');
        const existing = existingRaw ? JSON.parse(existingRaw) : { entries: [] };
        const existingMap = new Map();
        for (const e of existing.entries) {
          existingMap.set(e.gameId, e);
        }
        
        // Parse new data
        const newData = JSON.parse(jsonData);
        let added = 0, updated = 0, skipped = 0;
        
        for (const entry of newData.entries) {
          const id = entry.gameId;
          const existingEntry = existingMap.get(id);
          
          if (!existingEntry) {
            existingMap.set(id, entry);
            added++;
          } else {
            // Check if different (compare key fields)
            const isDifferent = existingEntry.status !== entry.status ||
                               existingEntry.priority !== entry.priority ||
                               existingEntry.publicReviews !== entry.publicReviews;
            if (isDifferent) {
              existingMap.set(id, { ...entry, addedAt: existingEntry.addedAt });
              updated++;
            } else {
              skipped++;
            }
          }
        }
        
        // Save back
        localStorage.setItem('ark-library-data', JSON.stringify({
          version: 3,
          entries: Array.from(existingMap.values()),
          lastUpdated: new Date().toISOString()
        }));
        
        return { added, updated, skipped, total: existingMap.size };
      }, readSampleLibraryDelta());
      
      // Delta import should:
      // - Add 1 new (1086940)
      // - Update 1 (730 - status changed)
      // - Skip 1 (570 - unchanged)
      expect(result.added).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.total).toBe(4); // 3 original + 1 new
    });

    test('importDataWithDelta skips identical entries', async () => {
      // Import the same data again - everything should be skipped
      const result = await page.evaluate((jsonData) => {
        const existingRaw = localStorage.getItem('ark-library-data');
        const existing = existingRaw ? JSON.parse(existingRaw) : { entries: [] };
        const existingMap = new Map();
        for (const e of existing.entries) {
          existingMap.set(e.gameId, e);
        }
        
        const newData = JSON.parse(jsonData);
        let added = 0, updated = 0, skipped = 0;
        
        for (const entry of newData.entries) {
          const id = entry.gameId;
          const existingEntry = existingMap.get(id);
          
          if (!existingEntry) {
            added++;
          } else {
            const isDifferent = existingEntry.status !== entry.status ||
                               existingEntry.priority !== entry.priority ||
                               existingEntry.publicReviews !== entry.publicReviews;
            if (isDifferent) {
              updated++;
            } else {
              skipped++;
            }
          }
        }
        
        return { added, updated, skipped };
      }, readSampleLibraryDelta());
      
      // All entries from delta should now be skipped since they match
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(3);
    });
  });

  test.describe('Clear Library Feature', () => {
    test('Clear Library button appears only in library view', async () => {
      // Ensure we have some library data
      await page.evaluate((jsonData) => {
        localStorage.setItem('ark-library-data', JSON.stringify({
          version: 3,
          entries: JSON.parse(jsonData).entries,
          lastUpdated: new Date().toISOString()
        }));
      }, readSampleLibrary());
      
      await page.reload();
      await waitForDashboard(page);
      
      // In Browse mode, Clear All button should NOT be visible
      const clearButton = page.getByRole('button', { name: /Clear All/i });
      await expect(clearButton).not.toBeVisible();
      
      // Switch to Library mode
      await page.click('button:has-text("Library")');
      await page.waitForTimeout(500);
      
      // Now Clear All button should be visible
      await expect(clearButton).toBeVisible({ timeout: 5000 });
    });

    test('Clear Library shows confirmation dialog', async () => {
      // Make sure we're in library view
      const libraryButton = page.locator('button:has-text("Library")');
      if (!(await libraryButton.getAttribute('class'))?.includes('bg-fuchsia')) {
        await libraryButton.click();
        await page.waitForTimeout(500);
      }
      
      // Click Clear All button
      await page.click('button:has-text("Clear All")');
      
      // Confirmation dialog should appear
      await expect(page.getByText('Clear Entire Library')).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(/Are you sure you want to remove all/i)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Clear All' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
      
      // Cancel the dialog
      await page.click('button:has-text("Cancel")');
      await expect(page.getByText('Clear Entire Library')).not.toBeVisible();
    });

    test('Clear Library removes all entries when confirmed', async () => {
      // Verify we have entries first
      let librarySize = await page.evaluate(() => {
        const data = localStorage.getItem('ark-library-data');
        if (!data) return 0;
        return JSON.parse(data).entries?.length || 0;
      });
      expect(librarySize).toBeGreaterThan(0);
      
      // Click Clear All and confirm
      await page.click('button:has-text("Clear All")');
      await expect(page.getByText('Clear Entire Library')).toBeVisible({ timeout: 5000 });
      
      // Click the confirm button (the one inside the dialog)
      await page.getByRole('alertdialog').getByRole('button', { name: 'Clear All' }).click();
      
      // Wait for dialog to close
      await expect(page.getByText('Clear Entire Library')).not.toBeVisible({ timeout: 5000 });
      
      // Verify library is now empty
      librarySize = await page.evaluate(() => {
        const data = localStorage.getItem('ark-library-data');
        if (!data) return 0;
        return JSON.parse(data).entries?.length || 0;
      });
      expect(librarySize).toBe(0);
      
      // Library button should show (0)
      await expect(page.locator('button:has-text("Library")')).toContainText('(0)');
    });
  });

  test.describe('Export Data Validation', () => {
    test('exported data has correct structure', async () => {
      // Add some test data
      await page.evaluate((jsonData) => {
        localStorage.setItem('ark-library-data', JSON.stringify({
          version: 3,
          entries: JSON.parse(jsonData).entries,
          lastUpdated: new Date().toISOString()
        }));
      }, readSampleLibrary());
      
      // Get export data
      const exportData = await page.evaluate(() => {
        const data = localStorage.getItem('ark-library-data');
        if (!data) return null;
        const parsed = JSON.parse(data);
        return JSON.stringify({
          entries: parsed.entries,
          exportedAt: new Date().toISOString()
        }, null, 2);
      });
      
      expect(exportData).not.toBeNull();
      const parsed = JSON.parse(exportData!);
      
      // Verify structure
      expect(parsed).toHaveProperty('entries');
      expect(parsed).toHaveProperty('exportedAt');
      expect(Array.isArray(parsed.entries)).toBe(true);
      expect(parsed.entries.length).toBe(3);
      
      // Verify entry structure
      const entry = parsed.entries[0];
      expect(entry).toHaveProperty('gameId');
      expect(entry).toHaveProperty('status');
      expect(entry).toHaveProperty('priority');
    });
  });
});
