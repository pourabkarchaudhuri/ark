import { test, expect } from '@playwright/test';

test.describe('View Modes', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app and wait for loading screen to complete
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Add Game/i })).toBeVisible({ timeout: 15000 });
  });

  test('grid view is selected by default', async ({ page }) => {
    const gridButton = page.getByRole('button', { name: /Grid view/i });
    await expect(gridButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('can switch to list view', async ({ page }) => {
    await page.getByRole('button', { name: /List view/i }).click();
    
    const listButton = page.getByRole('button', { name: /List view/i });
    await expect(listButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('can switch back to grid view', async ({ page }) => {
    // Switch to list
    await page.getByRole('button', { name: /List view/i }).click();
    
    // Switch back to grid
    await page.getByRole('button', { name: /Grid view/i }).click();
    
    const gridButton = page.getByRole('button', { name: /Grid view/i });
    await expect(gridButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('list view shows games in a different layout', async ({ page }) => {
    // Switch to list view
    await page.getByRole('button', { name: /List view/i }).click();
    
    // Games should still be visible
    await expect(page.getByRole('heading', { level: 3 }).first()).toBeVisible();
  });
});

