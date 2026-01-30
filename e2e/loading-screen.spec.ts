import { test, expect } from '@playwright/test';

test.describe('Loading Screen', () => {
  test.beforeEach(async ({ page }) => {
    // Loading screen is now the landing page, shown immediately
    await page.goto('/');
  });

  test('displays terminal with loading messages', async ({ page }) => {
    // Match actual terminal messages in loading-screen.tsx
    await expect(page.getByText('gametracker init --database')).toBeVisible({ timeout: 3000 });
  });

  test('shows progress messages during loading', async ({ page }) => {
    // Match actual terminal messages in loading-screen.tsx
    await expect(page.getByText(/Game library loaded/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/170 games discovered/i)).toBeVisible({ timeout: 5000 });
  });

  test('auto-transitions to dashboard after loading', async ({ page }) => {
    // Wait for loading to complete and auto-transition to dashboard
    await expect(page.getByRole('heading', { name: 'Game Tracker' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/games in library/i)).toBeVisible();
  });

  test('displays final ready message', async ({ page }) => {
    // Wait for the final message to appear
    await expect(page.getByText('🎮 Game Tracker ready')).toBeVisible({ timeout: 8000 });
  });
});
