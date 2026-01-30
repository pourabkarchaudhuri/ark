import { test, expect } from '@playwright/test';

// Set a longer timeout for CRUD tests since they involve navigation and dialogs
test.describe('CRUD Operations', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60000); // 60 second timeout
    // Navigate to app and wait for loading screen to complete
    await page.goto('/');
    
    // Wait for dashboard to fully load (loading screen auto-transitions after ~6s)
    await expect(page.getByRole('button', { name: /Add Game/i })).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(300); // Allow UI to stabilize
  });

  test.describe('Create Game', () => {
    test('opens Add Game dialog when Add Game button is clicked', async ({ page }) => {
      await page.getByRole('button', { name: /Add Game/i }).click();
      
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('heading', { name: /Add New Game/i })).toBeVisible();
    });

    test('dialog has all required form fields', async ({ page }) => {
      await page.getByRole('button', { name: /Add Game/i }).click();
      
      // Wait for dialog to be visible
      await expect(page.getByRole('dialog')).toBeVisible();
      
      // Check fields within dialog context
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel(/Title/i)).toBeVisible();
      await expect(dialog.getByLabel(/Developer/i)).toBeVisible();
      await expect(dialog.getByLabel(/Publisher/i)).toBeVisible();
      await expect(dialog.locator('#metacriticScore')).toBeVisible();
      await expect(dialog.getByLabel(/Release Date/i)).toBeVisible();
      await expect(dialog.getByText('Genres')).toBeVisible();
      await expect(dialog.getByText('Platforms')).toBeVisible();
    });

    test('shows validation error when submitting without required fields', async ({ page }) => {
      await page.getByRole('button', { name: /Add Game/i }).click();
      
      // Wait for dialog to be fully visible
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(300); // Allow dialog animation to complete
      
      // Find and click the submit button (it says "Add Game" inside the dialog)
      const submitButton = dialog.locator('button[type="submit"]');
      await expect(submitButton).toBeVisible();
      await submitButton.click();
      
      // Should show validation errors
      await expect(page.getByText(/Title is required/i)).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(/Select at least one genre/i)).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(/Select at least one platform/i)).toBeVisible({ timeout: 5000 });
    });

    test('can create a new game', async ({ page }) => {
      // Get initial game count
      const headerText = await page.getByText(/\d+ games in library/i).textContent();
      const initialNumber = parseInt(headerText?.match(/\d+/)?.[0] || '0');

      await page.getByRole('button', { name: /Add Game/i }).click();
      
      const dialog = page.getByRole('dialog');
      
      // Fill out the form
      await dialog.getByLabel(/Title/i).fill('E2E Test Game');
      await dialog.getByLabel(/Developer/i).fill('E2E Developer');
      await dialog.locator('#metacriticScore').fill('88');
      
      // Select genre
      await dialog.getByRole('button', { name: 'Action', exact: true }).click();
      
      // Select platform
      await dialog.getByRole('button', { name: 'PC', exact: true }).click();
      
      // Submit
      await dialog.getByRole('button', { name: /Add Game/i }).click();
      
      // Dialog should close
      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3000 });
      
      // Toast should appear
      await expect(page.getByRole('status')).toContainText(/added to your library/i);
      
      // Game count should increase
      await expect(page.getByText(new RegExp(`${initialNumber + 1} games in library`, 'i'))).toBeVisible({ timeout: 3000 });
    });

    test('can cancel adding a game', async ({ page }) => {
      await page.getByRole('button', { name: /Add Game/i }).click();
      
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(/Title/i).fill('Cancelled Game');
      
      await dialog.getByRole('button', { name: /Cancel/i }).click();
      
      await expect(page.getByRole('dialog')).not.toBeVisible();
    });
  });

  test.describe('Edit Game', () => {
    test('opens Edit dialog when Edit button is clicked', async ({ page }) => {
      // Find a game card with visible edit button
      const editButton = page.getByRole('button', { name: /Edit/i }).first();
      await editButton.click();
      
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('heading', { name: /Edit Game/i })).toBeVisible();
    });

    test('edit dialog is pre-filled with game data', async ({ page }) => {
      // Click first edit button
      await page.getByRole('button', { name: /Edit/i }).first().click();
      
      // Title field should have value
      const dialog = page.getByRole('dialog');
      const titleInput = dialog.getByLabel(/Title/i);
      await expect(titleInput).not.toBeEmpty();
    });

    test('can update a game', async ({ page }) => {
      // Search for a specific game first
      await page.getByPlaceholder(/Search games/i).fill('Zelda');
      await page.waitForTimeout(300);
      
      // Click edit button
      await page.getByRole('button', { name: /Edit/i }).first().click();
      
      const dialog = page.getByRole('dialog');
      
      // Submit
      await dialog.getByRole('button', { name: /Update Game/i }).click();
      
      // Dialog should close
      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 2000 });
      
      // Toast should appear
      await expect(page.getByRole('status')).toContainText(/updated successfully/i);
    });
  });

  test.describe('Delete Game', () => {
    test('shows confirmation dialog when delete is clicked', async ({ page }) => {
      // Add a test game first
      await page.getByRole('button', { name: /Add Game/i }).click();
      const addDialog = page.getByRole('dialog');
      await addDialog.getByLabel(/Title/i).fill('DeleteTest1');
      await addDialog.getByRole('button', { name: 'Action', exact: true }).click();
      await addDialog.getByRole('button', { name: 'PC', exact: true }).click();
      await addDialog.getByRole('button', { name: /Add Game/i }).click();
      await expect(addDialog).not.toBeVisible({ timeout: 3000 });
      
      // Wait for toast to auto-dismiss
      await page.waitForTimeout(4000);
      
      // Search for the game
      await page.getByPlaceholder(/Search games/i).fill('DeleteTest1');
      await page.waitForTimeout(500);
      
      // Wait for game to appear
      await expect(page.getByRole('heading', { name: 'DeleteTest1' })).toBeVisible();
      
      // Find the delete button specifically for this game
      const deleteButton = page.getByRole('button', { name: /Delete DeleteTest1/i });
      await deleteButton.click();
      
      // Confirmation dialog should appear
      await expect(page.getByText(/Are you sure you want to delete/i)).toBeVisible({ timeout: 3000 });
    });

    test('can cancel deletion', async ({ page }) => {
      // Add a test game
      await page.getByRole('button', { name: /Add Game/i }).click();
      const addDialog = page.getByRole('dialog');
      await addDialog.getByLabel(/Title/i).fill('DeleteTest2');
      await addDialog.getByRole('button', { name: 'Action', exact: true }).click();
      await addDialog.getByRole('button', { name: 'PC', exact: true }).click();
      const submitBtn = addDialog.locator('button[type="submit"]');
      await submitBtn.click();
      await expect(addDialog).not.toBeVisible({ timeout: 5000 });
      
      // Search for the game (don't need to wait for toast)
      await page.getByPlaceholder(/Search games/i).fill('DeleteTest2');
      await page.waitForTimeout(500);
      
      // Wait for the game to appear
      await expect(page.getByRole('heading', { name: 'DeleteTest2' })).toBeVisible({ timeout: 5000 });
      
      // Click delete
      await page.getByRole('button', { name: /Delete DeleteTest2/i }).click();
      
      // Wait for dialog and cancel
      await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5000 });
      await page.getByRole('button', { name: /Cancel/i }).last().click();
      
      // Wait for dialog to close
      await page.waitForTimeout(300);
      
      // Game should still exist
      await expect(page.getByRole('heading', { name: 'DeleteTest2' })).toBeVisible();
    });

    test('can confirm deletion', async ({ page }) => {
      const headerText = await page.getByText(/\d+ games in library/i).textContent();
      const initialNumber = parseInt(headerText?.match(/\d+/)?.[0] || '0');

      // Add a test game
      await page.getByRole('button', { name: /Add Game/i }).click();
      const addDialog = page.getByRole('dialog');
      await addDialog.getByLabel(/Title/i).fill('DeleteTest3');
      await addDialog.getByRole('button', { name: 'Action', exact: true }).click();
      await addDialog.getByRole('button', { name: 'PC', exact: true }).click();
      const submitBtn = addDialog.locator('button[type="submit"]');
      await submitBtn.click();
      await expect(addDialog).not.toBeVisible({ timeout: 5000 });
      
      // Search for the game (don't need to wait for toast)
      await page.getByPlaceholder(/Search games/i).fill('DeleteTest3');
      await page.waitForTimeout(500);
      
      // Wait for the game to appear
      await expect(page.getByRole('heading', { name: 'DeleteTest3' })).toBeVisible({ timeout: 5000 });
      
      // Click delete
      await page.getByRole('button', { name: /Delete DeleteTest3/i }).click();
      
      // Wait for dialog and confirm
      await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5000 });
      
      // Click the Delete confirm button
      await page.getByRole('button', { name: /^Delete$/i }).click();
      
      // Wait for deletion to complete
      await page.waitForTimeout(500);
      
      // Toast should appear with delete message (filter for the specific one)
      await expect(page.getByRole('status').filter({ hasText: /removed from/i })).toBeVisible({ timeout: 5000 });
      
      // Clear search
      await page.getByRole('button', { name: /Clear search/i }).click();
      await page.waitForTimeout(300);
      
      // Verify count is back to original
      await expect(page.getByText(new RegExp(`${initialNumber} games in library`, 'i'))).toBeVisible({ timeout: 5000 });
    });
  });
});
