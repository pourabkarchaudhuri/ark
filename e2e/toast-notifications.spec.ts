import { test, expect } from '@playwright/test';

test.describe('Toast Notifications', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app and wait for loading screen to complete
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Add Game/i })).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500); // Allow UI to stabilize
  });

  test('shows success toast when game is added', async ({ page }) => {
    await page.getByRole('button', { name: /Add Game/i }).click();
    
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Title/i).fill('Toast Test Game');
    await dialog.getByRole('button', { name: 'Action', exact: true }).click();
    await dialog.getByRole('button', { name: 'PC', exact: true }).click();
    await dialog.getByRole('button', { name: /Add Game/i }).click();
    
    // Toast should appear
    const toast = page.getByRole('status');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/added to your library/i);
  });

  test('toast can be dismissed manually', async ({ page }) => {
    await page.getByRole('button', { name: /Add Game/i }).click();
    
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Title/i).fill('Dismissable Toast Game');
    await dialog.getByRole('button', { name: 'Action', exact: true }).click();
    await dialog.getByRole('button', { name: 'PC', exact: true }).click();
    await dialog.getByRole('button', { name: /Add Game/i }).click();
    
    // Wait for toast
    const toast = page.getByRole('status');
    await expect(toast).toBeVisible();
    
    // Click dismiss button on toast
    await toast.getByRole('button', { name: /Dismiss/i }).click();
    
    // Toast should disappear
    await expect(toast).not.toBeVisible({ timeout: 2000 });
  });

  test('toast auto-dismisses after timeout', async ({ page }) => {
    await page.getByRole('button', { name: /Add Game/i }).click();
    
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Title/i).fill('Auto Dismiss Toast Game');
    await dialog.getByRole('button', { name: 'Action', exact: true }).click();
    await dialog.getByRole('button', { name: 'PC', exact: true }).click();
    await dialog.getByRole('button', { name: /Add Game/i }).click();
    
    // Toast should appear
    const toast = page.getByRole('status');
    await expect(toast).toBeVisible();
    
    // Wait for auto-dismiss (3 seconds + buffer)
    await expect(toast).not.toBeVisible({ timeout: 5000 });
  });
});
