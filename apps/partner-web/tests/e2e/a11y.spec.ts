import { expect, expectAccessible, expectTargetSizes, openCase, signIn, snap, test } from './helpers.ts';

test.describe('accessibility at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('queue and case detail pass axe and keep 44 px targets on a phone', async ({ page }) => {
    await signIn(page);
    await expectAccessible(page, 'queue (phone)');
    await expectTargetSizes(page, 'queue (phone)');
    await snap(page, '17-queue-phone');
    await openCase(page, 'SR-7K3Q-9M2D');
    await expectAccessible(page, 'case detail (phone)');
    await expectTargetSizes(page, 'case detail (phone)');
    await snap(page, '18-case-phone');
  });
});

test('the 404 page passes axe', async ({ page }) => {
  const response = await page.goto('/no-such-page/');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expectAccessible(page, '404');
});

test('status and priority are never shown by colour alone', async ({ page }) => {
  await signIn(page);
  // Every chip in the queue: case status, the red "Escalation" badge, onward-referral status (desktop and phone copies).
  const badges = page.getByTestId('queue-row').locator('.chip');
  const count = await badges.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    await expect(badges.nth(index)).toHaveText(/New|Acknowledged|In progress|Referred onward|Closed|No longer shared|Escalation|Planned|Made|Accepted|Declined|Completed|Cancelled/);
    await expect(badges.nth(index).locator('svg')).toHaveAttribute('aria-hidden', 'true');
  }
  // The pulsing red dot always comes with the bold words.
  const attention = page.getByTestId('queue-row').getByTestId('needs-attention');
  for (const label of await attention.all()) {
    if (await label.isVisible()) await expect(label).toHaveText('Needs attention');
  }
});

test('the skip link moves focus to the main content', async ({ page }) => {
  await signIn(page);
  await page.goto('/cases/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
});
