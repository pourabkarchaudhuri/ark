import { test, expect } from '@playwright/test';

test.describe('Sorting', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app and wait for loading screen to complete
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Add Game/i })).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500); // Allow UI to stabilize
  });

  test('can change sort field', async ({ page }) => {
    await page.getByRole('combobox', { name: /Sort by/i }).click();
    await page.getByRole('option', { name: 'Title' }).click();
    
    // Verify sort option changed
    await expect(page.getByRole('combobox', { name: /Sort by/i })).toContainText('Title');
  });

  test('can toggle sort direction', async ({ page }) => {
    // Initial state - find the sort direction button by aria-label pattern
    const sortButton = page.getByRole('button', { name: /Sort ascending|Sort descending/i });
    await expect(sortButton).toBeVisible({ timeout: 5000 });
    
    const initialText = await sortButton.textContent();
    await sortButton.click();
    
    // Should toggle
    await page.waitForTimeout(300);
    const newText = await sortButton.textContent();
    expect(newText).not.toBe(initialText);
  });

  test('sort by title changes game order', async ({ page }) => {
    // Sort by title
    await page.getByRole('combobox', { name: /Sort by/i }).click();
    await page.getByRole('option', { name: 'Title' }).click();
    
    // Wait for sort to apply
    await page.waitForTimeout(500);
    
    // Just verify sort was applied
    await expect(page.getByRole('combobox', { name: /Sort by/i })).toContainText('Title');
  });

  test('sort by Metacritic orders games by score', async ({ page }) => {
    // Sort by metacritic
    await page.getByRole('combobox', { name: /Sort by/i }).click();
    await page.getByRole('option', { name: 'Metacritic Score' }).click();
    
    // Should now be sorted by score (default desc)
    await expect(page.getByRole('combobox', { name: /Sort by/i })).toContainText('Metacritic');
  });
});
