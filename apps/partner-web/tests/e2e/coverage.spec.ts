import { expect, signIn, test } from './helpers.ts';

test('live coverage survives normal idle expiry; stopping restores normal limits', async ({ page }) => {
  await page.clock.install();
  await signIn(page);
  await page.getByTestId('coverage-toggle').click();
  await expect(page.getByTestId('coverage-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('coverage-status')).toHaveText('Coverage connection confirmed');
  for (let minute = 0; minute < 36; minute++) {
    await page.clock.fastForward('01:00');
    await expect(page.getByTestId('coverage-status')).toHaveText('Coverage connection confirmed');
  }
  await expect(page).toHaveURL(/\/cases\/$/);
  await expect(page.getByTestId('session-warning')).toBeHidden();
  await page.getByTestId('coverage-toggle').click();
  await expect(page.getByTestId('coverage-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.clock.fastForward('30:05');
  await expect(page).toHaveURL(/\/sign-in\/$/);
});

test('coverage exposes connection loss instead of claiming monitoring is healthy', async ({ page }) => {
  await page.clock.install();
  await signIn(page);
  await page.getByTestId('coverage-toggle').click();
  await expect(page.getByTestId('coverage-status')).toHaveText('Coverage connection confirmed');
  await page.route('**/partner/v1/coverage/heartbeat', route => route.abort());
  await page.clock.fastForward('01:01');
  await expect(page.getByTestId('coverage-status')).toContainText('unavailable');
  await page.unroute('**/partner/v1/coverage/heartbeat');
  await page.clock.fastForward('01:01');
  await expect(page.getByTestId('coverage-status')).toHaveText('Coverage connection confirmed');
});

test('coverage can renew past the original twelve-hour limit', async ({ page }) => {
  await page.clock.install();
  await signIn(page);
  await page.getByTestId('coverage-toggle').click();
  await expect(page.getByTestId('coverage-status')).toHaveText('Coverage connection confirmed');
  for (let hour = 0; hour < 13; hour++) {
    const renewed = page.waitForResponse(response => response.url().endsWith('/coverage/heartbeat') && response.ok());
    await page.clock.fastForward('01:00:00');
    await renewed;
    await expect(page.getByTestId('coverage-status')).toHaveText('Coverage connection confirmed');
    await expect(page).toHaveURL(/\/cases\/$/);
  }
});

test('another tab observes coverage mode and manual sign-out still ends every tab', async ({ page, context }) => {
  await context.clock.install();
  await signIn(page);
  const other = await context.newPage();
  await other.goto('/cases/');
  await expect(other.getByTestId('coverage-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('coverage-toggle').click();
  await expect(page.getByTestId('coverage-status')).toHaveText('Coverage connection confirmed');
  // The second tab's background identity check adopts the server's mode without simulating input.
  await context.clock.fastForward('01:05');
  await expect(other.getByTestId('coverage-toggle')).toHaveAttribute('aria-pressed', 'true');
  await other.getByTestId('coverage-toggle').click();
  await expect(other.getByTestId('coverage-toggle')).toHaveAttribute('aria-pressed', 'false');
  await context.clock.fastForward('01:05');
  await expect(page.getByTestId('coverage-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in\/$/);
  await expect(other).toHaveURL(/\/sign-in\/$/);
});
