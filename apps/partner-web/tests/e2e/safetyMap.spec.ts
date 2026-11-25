import { expect, expectAccessible, signIn, test } from './helpers.ts';
const zero = { total: 0, open: 0, needsAttention: 0, inProgress: 0, closed: 0 };
function snapshot() {
  return { generatedAt: '2026-10-22T08:00:00Z', windowDays: 30, caseLimit: 200, truncated: false,
    totals: { total: 2, open: 2, needsAttention: 1, inProgress: 0, closed: 0 }, mapped: 1, unmapped: 1,
    areas: ['Changamwe', 'Jomvu', 'Kisauni', 'Likoni', 'Mvita', 'Nyali'].map(name => ({ id: name.toLowerCase(), name,
      counts: name === 'Likoni' ? { total: 1, open: 1, needsAttention: 1, inProgress: 0, closed: 0 } : { ...zero } })) };
}
test('staff map shows current broad-area counts and explicitly unmapped coverage', async ({ page }) => {
  await signIn(page);
  await page.route('**/partner/v1/safety-map?*', route => route.fulfill({ json: snapshot() }));
  await page.goto('/safety-map/');
  await expect(page.getByRole('heading', { level: 1, name: 'Safety map' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Mombasa broad-area case coverage' })).toBeVisible();
  await expect(page.getByText('Unmapped', { exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: 'Likoni 1 1 1 0 0' })).toBeVisible();
  await expect(page.getByRole('paragraph').filter({ hasText: 'This is a case coverage map, not a measure of area safety or risk.' })).toBeVisible();
  await expectAccessible(page, 'staff safety map');
});
test('an outage removes previous map counts instead of retaining withdrawn information', async ({ page }) => {
  await signIn(page);
  await page.route('**/partner/v1/safety-map?*', route => route.fulfill({ json: snapshot() }));
  await page.goto('/safety-map/');
  await expect(page.getByRole('img', { name: 'Mombasa broad-area case coverage' })).toBeVisible();
  await page.unroute('**/partner/v1/safety-map?*');
  await page.route('**/partner/v1/safety-map?*', route => route.abort());
  await page.getByRole('button', { name: 'Refresh map' }).click();
  await expect(page.getByText('The current map is unavailable.', { exact: false })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Mombasa broad-area case coverage' })).toHaveCount(0);
});
