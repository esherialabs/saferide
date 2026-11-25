import { expect, expectAccessible, expectTargetSizes, openCase, signIn, test } from './helpers.ts';

test('appearance follows the device until overridden, across screens, without storing data', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page);
  const light = page.getByRole('button', { name: 'Light mode. Switch to dark mode' });
  await expect(light).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByRole('button', { name: 'Dark mode. Switch to light mode' })).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await page.getByRole('button', { name: 'Dark mode. Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await expectAccessible(page, 'manual light on a dark device');
  await openCase(page, 'SR-7K3Q-9M2D');
  await expect(light).toBeVisible();
  await light.click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expectAccessible(page, 'manual dark on a light device');
  await page.getByRole('button', { name: 'Use device setting' }).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(page.getByText('Device setting', { exact: true })).toBeVisible();
});

test('appearance can be changed by keyboard before sign-in at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/sign-in/');
  const toggle = page.getByRole('button', { name: 'Light mode. Switch to dark mode' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expectAccessible(page, 'phone sign-in in manual dark');
  await expectTargetSizes(page, 'phone appearance controls');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await page.reload();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
});
