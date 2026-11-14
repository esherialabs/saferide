import { expect, test } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

const FAQ_ROUTES = [
  '/what-we-do',
  '/how-it-works',
  '/for-survivors',
  '/partner-dashboard',
  '/open-source',
  '/partners',
  '/story',
  '/impact',
  '/privacy-safety-trust',
];

// Every page that shows photographs. /pilot is the one deliberate gallery.
const IMAGE_ROUTES = ['/', ...FAQ_ROUTES, '/blog', '/download', '/contact'];

test.describe('page content and images', () => {
  test('hero community panel describes the pilot day, not route mapping', async ({ page }) => {
    await page.goto(BASE);
    const panel = page.getByTestId('accordion-panel-2');
    await panel.hover();
    await expect(panel).toContainText('For communities');
    await expect(panel).toContainText('Out in the community');
    await expect(panel).toContainText('community day in Mombasa');
    await expect(panel.getByRole('link', { name: /See the pilot in pictures/ })).toHaveAttribute('href', /^\/pilot\/?$/);
    const text = (await panel.innerText()).toLowerCase();
    expect(text).not.toContain('route mapping');
    expect(text).not.toContain('see the index');
    // The dotted route diagram is gone; the photo carries pilot tags instead.
    await expect(panel.getByText('With HURIA')).toBeVisible();
    await expect(panel.locator('svg')).toHaveCount(0);
  });

  for (const route of FAQ_ROUTES) {
    test(`${route} answers common questions, each answer opening in place`, async ({ page }) => {
      await page.goto(`${BASE}${route}`);
      const faq = page.getByTestId('page-faq');
      await faq.scrollIntoViewIfNeeded();
      await expect(faq.getByRole('heading', { level: 2, name: 'Questions people ask.' })).toBeVisible();
      const items = faq.locator('details');
      expect(await items.count()).toBeGreaterThanOrEqual(2);
      const first = items.first();
      await first.locator('summary').click();
      await expect(first).toHaveAttribute('open', '');
      await expect(first.locator('p')).toBeVisible();
    });
  }

  test('privacy page explains app permissions next to the permission screen', async ({ page }) => {
    await page.goto(`${BASE}/privacy-safety-trust`);
    const feature = page.getByTestId('page-feature');
    await feature.scrollIntoViewIfNeeded();
    await expect(feature.getByRole('heading', { level: 2 })).toHaveText('You choose what the app can use.');
    await expect(feature.locator('img')).toHaveAttribute('src', '/images/privacy-controls-product.webp');
    await expect.poll(() => feature.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });

  test('no image repeats anywhere on the site outside the /pilot gallery', async ({ page }) => {
    const seen = new Map<string, string>();
    for (const route of IMAGE_ROUTES) {
      await page.goto(`${BASE}${route}`);
      const sources = await page.locator('img[src^="/images/"]').evaluateAll(images =>
        [...new Set(images.map(image => image.getAttribute('src') ?? ''))],
      );
      for (const src of sources) {
        // Partner logos, press covers and the brand mark belong to the page that names them. The Spice FM clip card
        // is one shared component on /story and /blog.
        if (/\/images\/(partners|press)\//.test(src) || src.endsWith('/spice-fm-poster.svg') || (src.endsWith('.svg') && src.includes('logo'))) continue;
        const earlier = seen.get(src);
        expect(earlier, `${src} is on ${earlier} and again on ${route}`).toBeUndefined();
        seen.set(src, route);
      }
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  test('the partner dashboard replaces the route safety index everywhere', async ({ page }) => {
    await page.goto(`${BASE}/partner-dashboard`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Where a shared report reaches the partner');
    const body = (await page.locator('main').innerText()).toLowerCase();
    expect(body).toContain('access is set up with each partner directly');
    expect(body).not.toContain('route safety index');
    // Nothing tells visitors where to sign in: access is given to partners directly.
    await expect(page.locator('main a[href*="dashboard."]')).toHaveCount(0);
    for (const route of ['/', '/what-we-do', '/blog/route-safety-without-exposure']) {
      await page.goto(`${BASE}${route}`);
      const html = await page.content();
      expect(html, route).not.toContain('Route Safety Index');
      expect(html, route).not.toContain('/route-safety-index');
    }
  });

  test('the old route safety index address leads to the partner dashboard', async ({ page }) => {
    await page.goto(`${BASE}/route-safety-index`);
    await page.waitForURL(/\/partner-dashboard\/?$/);
    await expect(page.getByTestId('page-faq')).toBeVisible();
  });
});
