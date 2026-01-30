import { test, expect } from '@playwright/test';

test.describe('Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app and wait for loading screen to complete
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Add Game/i })).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500); // Allow UI to stabilize
  });

  test('page has proper heading hierarchy', async ({ page }) => {
    // H1 should be Game Tracker
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveText('Game Tracker');
    
    // H3 headings for stat cards
    const h3s = page.getByRole('heading', { level: 3 });
    await expect(h3s.first()).toBeVisible();
  });

  test('interactive elements are keyboard accessible', async ({ page }) => {
    // Add Game button should be focusable
    const addButton = page.getByRole('button', { name: /Add Game/i });
    await addButton.focus();
    await page.keyboard.press('Enter');
    
    // Dialog should open
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('search input has accessible label', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/Search games/i);
    await expect(searchInput).toBeVisible();
  });

  test('buttons have accessible names', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Add Game/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Grid view/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /List view/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Reset all filters/i })).toBeVisible();
  });

  test('filter dropdowns have accessible labels', async ({ page }) => {
    await expect(page.getByRole('combobox', { name: /Filter by status/i })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Filter by priority/i })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Filter by genre/i })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Filter by platform/i })).toBeVisible();
  });

  test('dialog can be closed with Escape key', async ({ page }) => {
    await page.getByRole('button', { name: /Add Game/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    
    await page.keyboard.press('Escape');
    
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('toast notifications are announced to screen readers', async ({ page }) => {
    await page.getByRole('button', { name: /Add Game/i }).click();
    
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(300);
    
    await dialog.getByLabel(/Title/i).fill('Accessibility Test Game');
    await dialog.getByRole('button', { name: 'Action', exact: true }).click();
    await dialog.getByRole('button', { name: 'PC', exact: true }).click();
    
    // Submit the form
    const submitButton = dialog.locator('button[type="submit"]');
    await submitButton.click();
    
    // Toast should have status role for screen readers
    const toast = page.getByRole('status');
    await expect(toast).toBeVisible({ timeout: 5000 });
  });
});
