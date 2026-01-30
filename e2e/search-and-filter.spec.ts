import { test, expect } from '@playwright/test';

test.describe('Search and Filter', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app and wait for loading screen to complete
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Add Game/i })).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);
  });

  test.describe('Search', () => {
    test('filters games by title', async ({ page }) => {
      const searchInput = page.getByPlaceholder(/Search games/i);
      await searchInput.fill('Zelda');
      
      // Wait for debounce
      await page.waitForTimeout(300);
      
      // Should show filtered results
      await expect(page.getByText(/Showing \d+ of \d+ games/i)).toBeVisible();
      await expect(page.getByText('Filtered')).toBeVisible();
      
      // Should show Zelda games
      await expect(page.getByText(/Zelda/i).first()).toBeVisible();
    });

    test('shows clear button when search has value', async ({ page }) => {
      const searchInput = page.getByPlaceholder(/Search games/i);
      await searchInput.fill('Test');
      
      const clearButton = page.getByRole('button', { name: /Clear search/i });
      await expect(clearButton).toBeVisible();
    });

    test('clears search when clear button is clicked', async ({ page }) => {
      const searchInput = page.getByPlaceholder(/Search games/i);
      await searchInput.fill('Test');
      
      await page.getByRole('button', { name: /Clear search/i }).click();
      
      await expect(searchInput).toHaveValue('');
    });

    test('shows no results message when no games match', async ({ page }) => {
      const searchInput = page.getByPlaceholder(/Search games/i);
      await searchInput.fill('xyznonexistentgame123');
      
      await page.waitForTimeout(300);
      
      await expect(page.getByText('No games found')).toBeVisible();
    });
  });

  test.describe('Status Filter', () => {
    test('filters games by status', async ({ page }) => {
      await page.getByRole('combobox', { name: /Filter by status/i }).click();
      await page.getByRole('option', { name: 'Want to Play' }).click();
      
      await expect(page.getByText('Filtered')).toBeVisible();
    });
  });

  test.describe('Priority Filter', () => {
    test('filters games by priority', async ({ page }) => {
      await page.getByRole('combobox', { name: /Filter by priority/i }).click();
      await page.getByRole('option', { name: 'High' }).click();
      
      await expect(page.getByText('Filtered')).toBeVisible();
    });
  });

  test.describe('Genre Filter', () => {
    test('filters games by genre', async ({ page }) => {
      await page.getByRole('combobox', { name: /Filter by genre/i }).click();
      await page.getByRole('option', { name: 'Action' }).click();
      
      await expect(page.getByText('Filtered')).toBeVisible();
    });
  });

  test.describe('Platform Filter', () => {
    test('filters games by platform', async ({ page }) => {
      await page.getByRole('combobox', { name: /Filter by platform/i }).click();
      await page.getByRole('option', { name: 'PC' }).click();
      
      await expect(page.getByText('Filtered')).toBeVisible();
    });
  });

  test.describe('Reset Filters', () => {
    test('reset button clears all filters', async ({ page }) => {
      // Apply some filters
      const searchInput = page.getByPlaceholder(/Search games/i);
      await searchInput.fill('Test');
      await page.getByRole('combobox', { name: /Filter by priority/i }).click();
      await page.getByRole('option', { name: 'High' }).click();
      
      // Reset
      await page.getByRole('button', { name: /Reset all filters/i }).click();
      
      await expect(searchInput).toHaveValue('');
      await expect(page.getByText('Filtered')).not.toBeVisible();
    });

    test('reset button is disabled when no filters are active', async ({ page }) => {
      const resetButton = page.getByRole('button', { name: /Reset all filters/i });
      await expect(resetButton).toBeDisabled();
    });
  });
});

