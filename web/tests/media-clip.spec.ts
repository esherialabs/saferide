import { expect, test } from '@playwright/test';

// The Spice FM clip is the only third-party embed on the public site, so these
// tests pin down its privacy contract: nothing loads until play, the player is
// removed again on close, and the press list stays a list of articles.
test.describe('Spice FM clip', () => {
  test('the story page shows the clip card without touching Facebook', async ({ page }) => {
    const thirdPartyRequests: string[] = [];
    page.on('request', request => {
      if (request.url().includes('facebook.com')) thirdPartyRequests.push(request.url());
    });

    await page.goto('/story/');

    const card = page.getByTestId('media-clip');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'A clip about SafeRide' })).toBeVisible();
    await expect(card).toContainText('Spice FM');
    await expect(page.getByTestId('media-clip-play')).toBeVisible();
    await expect(page.getByTestId('media-clip-iframe')).toHaveCount(0);

    // Nothing third-party may be requested until a visitor presses play: no
    // iframe, preconnect, script, poster or beacon.
    expect(thirdPartyRequests).toEqual([]);
  });

  test('the blog shows the same clip card before the featured guide, also without touching Facebook', async ({ page }) => {
    const thirdPartyRequests: string[] = [];
    page.on('request', request => {
      if (request.url().includes('facebook.com')) thirdPartyRequests.push(request.url());
    });

    await page.goto('/blog/');

    const card = page.getByTestId('media-clip');
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole('heading', { name: 'A clip about SafeRide' })).toBeVisible();
    await expect(page.getByTestId('media-clip-iframe')).toHaveCount(0);
    const clipBox = await card.boundingBox();
    const featuredBox = await page.locator('#featured-update').boundingBox();
    expect(clipBox && featuredBox && clipBox.y < featuredBox.y).toBe(true);
    expect(thirdPartyRequests).toEqual([]);
  });

  test('pressing play mounts the Facebook player and Escape closes it', async ({ page }) => {
    // Keep the test hermetic: no request needs to leave for Facebook.
    await page.route('**facebook.com/**', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }),
    );
    await page.goto('/story/');

    const play = page.getByTestId('media-clip-play');
    await play.scrollIntoViewIfNeeded();
    await play.click();

    const dialog = page.getByTestId('media-clip-dialog');
    await expect(dialog).toBeVisible();

    const frame = page.getByTestId('media-clip-iframe');
    await expect(frame).toHaveAttribute('src', /facebook\.com\/plugins\/video\.php/);
    await expect(frame).toHaveAttribute('src', /2555899891595834/);
    await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(frame).toHaveAttribute('allow', 'autoplay; fullscreen');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('media-clip-iframe')).toHaveCount(0);
    await expect(play).toBeFocused();
  });

  test('the secondary trigger also gets focus back on close', async ({ page }) => {
    await page.route('**facebook.com/**', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }),
    );
    await page.goto('/story/');

    const secondary = page.getByRole('button', { name: 'Watch the clip' });
    await secondary.scrollIntoViewIfNeeded();
    await secondary.click();
    await expect(page.getByTestId('media-clip-dialog')).toBeVisible();

    await page.getByTestId('media-clip-close').click();
    await expect(page.getByTestId('media-clip-dialog')).toBeHidden();
    await expect(secondary).toBeFocused();
  });

  test('the partners press list stays article-only', async ({ page }) => {
    await page.goto('/partners/');

    const press = page.getByTestId('press-section');
    await press.scrollIntoViewIfNeeded();
    await expect(press).toContainText('BusinessDay NG');
    await expect(press).not.toContainText('Spice FM');
  });

  test('the CSP and Permissions-Policy allow only the clip host, and framing is still denied', async ({ request }) => {
    const response = await request.get('/story/');
    const csp = response.headers()['content-security-policy'] ?? '';
    const permissions = response.headers()['permissions-policy'] ?? '';

    expect(csp).toContain('frame-src https://www.facebook.com;');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("frame-src 'none'");
    expect(csp).not.toContain('web.facebook.com');

    // The player needs both capabilities, scoped to that one host only.
    expect(permissions).toContain('autoplay=(self "https://www.facebook.com")');
    expect(permissions).toContain('fullscreen=(self "https://www.facebook.com")');
    expect(permissions).not.toContain('autoplay=()');
  });
});
