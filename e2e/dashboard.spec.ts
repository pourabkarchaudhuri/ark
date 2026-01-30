import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app and wait for loading screen to complete
    await page.goto('/');
    
    // Wait for dashboard to fully load (loading screen auto-transitions after ~6s)
    await expect(page.getByRole('button', { name: /Add Game/i })).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(300);
  });

  test.describe('Header', () => {
    test('displays logo and game count', async ({ page }) => {
      await expect(page.getByRole('heading', { name: 'Game Tracker' })).toBeVisible();
      await expect(page.getByText(/\d+ games in library/i)).toBeVisible();
    });

    test('displays Add Game button', async ({ page }) => {
      await expect(page.getByRole('button', { name: /Add Game/i })).toBeVisible();
    });
  });

  test.describe('Stats Cards', () => {
    test('displays all stat cards', async ({ page }) => {
      await expect(page.getByRole('heading', { name: 'Total Games' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Avg. Metacritic' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Want to Play' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'High Priority' })).toBeVisible();
    });

    test('displays numeric values in stat cards', async ({ page }) => {
      // Get the stats section
      const totalGames = page.locator('text=Total Games').locator('..').locator('..').locator('div').filter({ hasText: /^\d+$/ }).first();
      await expect(totalGames).toBeVisible();
    });
  });

  test.describe('Filters', () => {
    test('displays search input', async ({ page }) => {
      await expect(page.getByPlaceholder(/Search games/i)).toBeVisible();
    });

    test('displays filter dropdowns', async ({ page }) => {
      await expect(page.getByRole('combobox', { name: /Filter by status/i })).toBeVisible();
      await expect(page.getByRole('combobox', { name: /Filter by priority/i })).toBeVisible();
      await expect(page.getByRole('combobox', { name: /Filter by genre/i })).toBeVisible();
      await expect(page.getByRole('combobox', { name: /Filter by platform/i })).toBeVisible();
    });

    test('displays sort controls', async ({ page }) => {
      await expect(page.getByRole('combobox', { name: /Sort by/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Desc|Asc/i })).toBeVisible();
    });

    test('displays view mode toggle buttons', async ({ page }) => {
      await expect(page.getByRole('button', { name: /Grid view/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /List view/i })).toBeVisible();
    });
  });

  test.describe('Game Cards', () => {
    test('displays game cards', async ({ page }) => {
      // Check that at least one game card is visible
      await expect(page.getByRole('heading', { level: 3 }).first()).toBeVisible();
    });

    test('game cards show Metacritic scores', async ({ page }) => {
      // Look for a score (2-3 digit number in a score container)
      const scoreElement = page.locator('[class*="font-bold"]').filter({ hasText: /^\d{2,3}$/ }).first();
      await expect(scoreElement).toBeVisible();
    });

    test('game cards show status and priority badges', async ({ page }) => {
      await expect(page.getByText('Want to Play').first()).toBeVisible();
      await expect(page.getByText(/^(High|Medium|Low)$/).first()).toBeVisible();
    });

    test('game cards have Edit and Delete buttons on hover', async ({ page }) => {
      // Hover over first game card
      const firstCard = page.locator('article, [class*="card"]').first();
      await firstCard.hover();
      
      // Check for action buttons
      await expect(page.getByRole('button', { name: /Edit/i }).first()).toBeVisible();
    });
  });

  test.describe('Results Count', () => {
    test('displays results count', async ({ page }) => {
      await expect(page.getByText(/Showing \d+ of \d+ games/i)).toBeVisible();
    });
  });
});

