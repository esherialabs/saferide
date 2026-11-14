import { test, expect } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

const publicRoutes = [
  '/',
  '/what-we-do',
  '/how-it-works',
  '/for-survivors',
  '/open-source',
  '/partner-dashboard',
  '/partners',
  '/contact',
  '/story',
  '/impact',
  '/pilot',
  '/privacy-safety-trust',
  '/blog',
  '/blog/private-reporting-control',
  '/blog/kenya-support-pathways',
  '/blog/route-safety-without-exposure',
  '/download',
  '/privacy',
  '/terms',
];

test.describe('SafeRide v2  Mozilla near-clone', () => {
  test('homepage returns 200', async ({ page }) => {
    const response = await page.goto(BASE);
    expect(response?.status()).toBe(200);
  });

  test('nav is present and white', async ({ page }) => {
    await page.goto(BASE);
    const nav = page.locator('[data-testid="main-nav"]');
    await expect(nav).toBeVisible();
    const background = await nav.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(background).toMatch(/255, 255, 255|white/);
  });

  test('brand wordmark renders color bars and reacts on hover', async ({ page }) => {
    await page.goto(BASE);
    const logo = page.getByTestId('nav-logo');
    const firstLetter = logo.locator('.brand-wordmark__letter').first();

    const readFirstLetterBar = () => firstLetter.evaluate((element) => {
      const before = getComputedStyle(element, '::before');

      return {
        backgroundColor: before.backgroundColor,
        height: parseFloat(before.height),
      };
    });

    const restingStyle = await readFirstLetterBar();
    expect(restingStyle.backgroundColor).toBe('rgb(248, 133, 57)');
    expect(restingStyle.height).toBeGreaterThan(0);

    for (let reloadCount = 0; reloadCount < 2; reloadCount += 1) {
      await page.reload({ waitUntil: 'load' });
      await expect(logo).toBeVisible();

      const refreshedStyle = await readFirstLetterBar();
      expect(refreshedStyle.backgroundColor).toBe('rgb(248, 133, 57)');
      expect(refreshedStyle.height).toBeGreaterThan(0);
    }

    await logo.hover();
    await page.waitForTimeout(250);

    const hoverHeight = await firstLetter.evaluate((element) => parseFloat(getComputedStyle(element, '::before').height));
    expect(hoverHeight).toBeGreaterThan(restingStyle.height);
  });

  test('desktop submenu opens for keyboard users', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE);

    const nav = page.locator('[data-testid="main-nav"]');
    const trigger = nav.getByRole('link', { name: 'What We Do' }).first();

    await trigger.focus();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: 'How It Works' })).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: 'How It Works' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('ArrowDown');
    await expect(nav.getByRole('link', { name: 'How It Works' })).toBeFocused();
  });

  test('hero accordion has 3 panels', async ({ page }) => {
    await page.goto(BASE);
    const panels = page.locator('[data-testid^="accordion-panel-"]');
    await expect(panels).toHaveCount(3);
  });

  test('first accordion panel is expanded by default', async ({ page }) => {
    await page.goto(BASE);
    const panel = page.locator('[data-testid="accordion-panel-1"]');
    const flexGrow = await panel.evaluate((element) => getComputedStyle(element).flexGrow);
    expect(parseFloat(flexGrow)).toBeGreaterThan(1);
  });

  test('accordion panel expands on hover', async ({ page }) => {
    await page.goto(BASE);
    const panel = page.locator('[data-testid="accordion-panel-2"]');
    await panel.hover();
    await page.waitForTimeout(600);
    const flexGrow = await panel.evaluate((element) => getComputedStyle(element).flexGrow);
    expect(parseFloat(flexGrow)).toBeGreaterThan(1);
  });

  test('kinetic strip cycles headline', async ({ page }) => {
    await page.goto(BASE);
    const headline = page.locator('[data-testid="kinetic-headline"]');
    await expect(headline).toBeVisible();
    const firstText = await headline.innerText();
    await page.waitForTimeout(3500);
    const secondText = await headline.innerText();
    expect(firstText).not.toBe(secondText);
  });

  test('impact numbers section is visible', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('[data-testid="impact-numbers"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-testid="impact-numbers"]')).toBeVisible();
    await expect(page.getByTestId('impact-stat-value-1')).toHaveText('0');
    await expect(page.getByTestId('impact-stat-value-2')).toHaveText('3');
    await expect(page.getByTestId('impact-stat-value-3')).toHaveText('3');
    await expect(page.locator('[data-testid="impact-numbers"]').getByText('forced uploads')).toBeVisible();
  });

  test('editorial grid has 3 cards', async ({ page }) => {
    await page.goto(BASE);
    const grid = page.locator('[data-testid="editorial-grid"]');
    await grid.scrollIntoViewIfNeeded();
    await expect(grid).toBeVisible();
    await expect(grid.locator('article')).toHaveCount(3);
  });

  test('community spotlight renders image carousel', async ({ page }) => {
    await page.goto(BASE);
    const spotlight = page.locator('[data-testid="community-spotlight"]');
    await spotlight.scrollIntoViewIfNeeded();
    await expect(spotlight).toBeVisible();
    // All five cards stay in the DOM for crawlers; exactly one is visible.
    await expect(spotlight.locator('article')).toHaveCount(5);
    await expect(spotlight.locator('article:visible')).toHaveCount(1);
    await expect(spotlight.locator('article:visible img')).toBeVisible();
    await expect(spotlight.getByText('1 / 5')).toBeVisible();
    await expect(spotlight.getByRole('button', { name: /Mombasa pilot/ })).toBeVisible();
    await expect(spotlight.getByRole('button', { name: /Pilot team/ })).toBeVisible();
  });

  test('homepage names the Mombasa pilot and its partner', async ({ page }) => {
    await page.goto(BASE);
    const pilot = page.getByTestId('mombasa-pilot');
    await pilot.scrollIntoViewIfNeeded();
    await expect(pilot).toBeVisible();
    await expect(pilot).toContainText('The pilot has run.');
    await expect(pilot).toContainText('SafeRide ran a supervised pilot with HURIA in Mombasa in October 2026.');
    await expect(pilot).toContainText('October 2026');
    await expect(pilot).not.toContainText('19 October 2026');
    await expect(pilot).not.toContainText('21 October 2026');
    await expect(pilot).not.toContainText('staff onboarding');
    await expect(page.getByTestId('mombasa-pilot-image')).toBeVisible();
    await expect(page.getByTestId('mombasa-region-map')).toBeVisible();
  });

  test('fund CTA is present', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="fund-cta"]')).toBeVisible();
  });

  test('footer is present with 4 columns', async ({ page }) => {
    await page.goto(BASE);
    const footer = page.locator('[data-testid="main-footer"]');
    await expect(footer).toBeVisible();
    // Column titles are nav labels, not document headings (SEO plan P1-6).
    await expect(footer.getByRole('heading')).toHaveCount(0);
    await expect(footer.locator('ul')).toHaveCount(4);
    for (const column of ['Product', 'Source & Models', 'Community', 'Organisation']) {
      await expect(footer.getByText(column, { exact: true }).first()).toBeVisible();
    }
    await expect(footer).toContainText(`© ${new Date().getFullYear()} Esheria Ventures Limited`);
    await expect(footer.locator('li > a[href="https://esheria.org/"]')).toHaveAttribute(
      'href',
      'https://esheria.org/',
    );
  });

  test('Esheria affiliation is prominent, crawlable, and referral-attributable', async ({ page }) => {
    await page.goto(BASE);

    const affiliation = page.getByTestId('home-affiliation');
    await expect(affiliation).toBeVisible();
    await expect(affiliation).toContainText('SafeRide is developed by Esheria');

    const parentLinks = page.locator('a[href="https://esheria.org/"]:visible');
    await expect(parentLinks).toHaveCount(5);

    for (const link of await parentLinks.all()) {
      await expect(link).toBeVisible();
      const rel = (await link.getAttribute('rel')) ?? '';
      expect(rel).not.toMatch(/nofollow|ugc|sponsored|noreferrer/);
    }

    await expect(page.locator('[data-testid="main-nav"]').getByRole('link', { name: /Esheria Foundation initiative/ })).toBeVisible();
    await expect(affiliation.getByRole('link', { name: 'Esheria Foundation' })).toBeVisible();
  });

  test('all routes return 200', async ({ page }) => {
    const routes = [...publicRoutes, '/privacy-safety'];
    for (const route of routes) {
      const response = await page.goto(`${BASE}${route}`);
      expect(response?.status()).toBe(200);
    }
  });

  test('blog article routes render their canonical content', async ({ page }) => {
    const expectedArticles = [
      ['/blog/private-reporting-control', 'How SafeRide keeps a report private until you choose a path'],
      ['/blog/kenya-support-pathways', 'Support after harassment in Kenya'],
      ['/blog/route-safety-without-exposure', 'How anonymous matatu route signals can improve safety without exposing riders'],
    ];

    for (const [route, heading] of expectedArticles) {
      await page.goto(`${BASE}${route}`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://saferide.esheria.org${route}/`);
    }
  });


  test('launch pages are implemented, not stubs', async ({ page }) => {
    test.setTimeout(90000);

    const expected = [
      ['/what-we-do', 'Private reporting, survivor control, and a Mombasa pilot'],
      ['/how-it-works', 'document and report harassment on a matatu'],
      ['/for-survivors', 'your options in Kenya, at your pace'],
      ['/partner-dashboard', 'Where a shared report reaches the partner'],
      ['/open-source', 'auditable open-source snapshot'],
      ['/partners', 'GBV organizations, matatu operators, funders'],
      ['/contact', 'Talk to the SafeRide team'],
      ['/story', 'Built in Nairobi, piloted with HURIA in Mombasa'],
      ['/impact', 'The pilot has run. We are measuring what comes next.'],
      ['/privacy-safety-trust', 'Your report stays private until you decide otherwise'],
      ['/blog', 'Guides to safer, more private reporting in Kenya'],
      ['/download', 'Download SafeRide for Android'],
    ];

    for (const [route, heading] of expected) {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
      expect(await page.getByText('Coming soon').count()).toBe(0);
    }
  });
  test('pilot legal pages are versioned, labelled and flag open points', async ({ page }) => {
    const pages = [
      {
        route: '/privacy',
        heading: 'SafeRide privacy notice',
        facts: [
          'self-hosted server',
          'not the photos, audio, video or documents themselves',
          'map coordinates in your packet are always removed before HURIA sees it',
          'adding a Kenyan mobile number',
          'HURIA then loses access to that report straight away',
          'proposed 90 days',
          'proposed 730 days',
          'approved malware scanner',
          'saferide@esheria.org',
        ],
      },
      {
        route: '/terms',
        heading: 'SafeRide terms of use',
        facts: ['not an emergency service', 'call 999 or 112', 'HURIA (Human Rights Agenda) is an independent organisation'],
      },
    ];

    for (const { route, heading, facts } of pages) {
      const response = await page.goto(`${BASE}${route}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.getByTestId('legal-pilot-label')).toHaveText('Pilot');
      await expect(page.getByTestId('legal-version')).toHaveText('2026-10-22.pilot.1');
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://saferide.esheria.org${route}/`);
      for (const fact of facts) {
        await expect(page.getByTestId('legal-document')).toContainText(fact);
      }
      // Undecided legal facts stay visibly flagged, never silently filled in.
      const placeholders = page.locator('mark[data-placeholder]');
      expect(await placeholders.count()).toBeGreaterThan(0);
      await expect(placeholders.first()).toContainText('To confirm');
      await expect(page.locator('[data-placeholder="effective-date"]')).toBeVisible();
    }

    await page.goto(BASE);
    const footer = page.locator('[data-testid="main-footer"]');
    await expect(footer.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute('href', /^\/privacy\/?$/);
    await expect(footer.getByRole('link', { name: 'Terms of Use' })).toHaveAttribute('href', /^\/terms\/?$/);
  });

  test('sitemap.xml returns 200', async ({ page }) => {
    const response = await page.goto(`${BASE}/sitemap.xml`);
    expect(response?.status()).toBe(200);
    const xml = await response?.text();
    expect(xml).toContain('https://saferide.esheria.org/what-we-do/');
    expect(xml).toContain('https://saferide.esheria.org/contact/');
    expect(xml).toContain('https://saferide.esheria.org/blog/private-reporting-control/');
    expect(xml).toContain('https://saferide.esheria.org/privacy/');
    expect(xml).toContain('https://saferide.esheria.org/terms/');
  });

  test('robots.txt allows crawling in production form', async ({ page }) => {
    const response = await page.goto(`${BASE}/robots.txt`);
    expect(response?.status()).toBe(200);
    const body = await response?.text();
    expect(body).toContain('Allow: /');
    expect(body).not.toContain('Disallow: /');
    expect(body).toContain('Sitemap: https://saferide.esheria.org/sitemap.xml');
  });

  test('privacy-safety alias redirects to canonical trust route', async ({ page }) => {
    const response = await page.goto(`${BASE}/privacy-safety`);
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(new RegExp(`/privacy-safety-trust/?$`));
  });

  test('canonical and social URLs use production domain', async ({ page }) => {
    await page.goto(`${BASE}/partners`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://saferide.esheria.org/partners/');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://saferide.esheria.org/partners/');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://saferide.esheria.org/og/partners.jpg');
  });

  test('structured data is present on key page types', async ({ page }) => {
    const jsonLdText = async (selector: string) =>
      page.locator(selector).evaluate((node) => node.textContent ?? '');

    await page.goto(BASE);
    const siteStructuredData = await jsonLdText('script[type="application/ld+json"]#site-structured-data');
    expect(siteStructuredData).toContain('Organization');
    expect(siteStructuredData).toContain('https://esheria.org/#organization');
    expect(siteStructuredData).toContain('"name":"Esheria Foundation"');
    expect(siteStructuredData).not.toContain('Esheria Ventures Limited');
    expect(siteStructuredData).toContain('"@type":"Brand"');
    expect(await jsonLdText('script[type="application/ld+json"]#home-structured-data')).toContain('BreadcrumbList');

    await page.goto(`${BASE}/download`);
    expect(await jsonLdText('script[type="application/ld+json"]#download-structured-data')).toContain('SoftwareApplication');
    expect(await jsonLdText('script[type="application/ld+json"]#download-structured-data')).toContain('FAQPage');

    await page.goto(`${BASE}/blog/private-reporting-control`);
    expect(await jsonLdText('script[type="application/ld+json"]#article-structured-data')).toContain('Article');
  });

  test('blog articles expose publication data, sources, and useful next steps', async ({ page }) => {
    await page.goto(`${BASE}/blog/kenya-support-pathways`);

    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
    await expect(page.locator('meta[property="article:published_time"]')).toHaveAttribute('content', '2026-05-24');
    await expect(page.locator('meta[property="article:modified_time"]')).toHaveAttribute('content', '2026-10-19');
    await expect(page.getByText('SafeRide by Esheria editorial team').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sources and further reading' })).toBeVisible();
    await expect(page.getByRole('link', { name: /State Department for Gender/ })).toHaveAttribute('href', /gender\.go\.ke/);
    await expect(page.getByRole('heading', { name: 'Choose your next step.' })).toBeVisible();
  });

  test('blog index does not duplicate long-form article body copy', async ({ page }) => {
    await page.goto(`${BASE}/blog`);
    await expect(page.getByText('That distinction matters on public transport', { exact: false })).toHaveCount(0);
  });

  test('homepage uses responsive priority loading for the LCP image', async ({ page }) => {
    await page.goto(BASE);
    const image = page.locator('[data-testid="accordion-panel-1"] img').first();

    await expect(image).toHaveAttribute('fetchpriority', 'high');
    await expect(image).toHaveAttribute('srcset', /matatu-interior-640\.webp 640w/);
    await expect(image).toHaveAttribute('width', '1248');
    await expect(image).toHaveAttribute('height', '848');
  });

  test('public source links point to the canonical open-source repository', async ({ page }) => {
    await page.goto(`${BASE}/open-source`);
    await expect(page.getByRole('link', { name: 'Canonical GitHub repository' })).toHaveAttribute(
      'href',
      'https://github.com/esherialabs/saferide',
    );
    await expect(page.locator('a[href="https://github.com/esherialabs/saferider"]')).toHaveCount(0);
  });

  test('download page publishes the exact APK and checksum', async ({ page }) => {
    await page.goto(`${BASE}/download`);

    await expect(page.getByRole('link', { name: 'Download Android APK' })).toHaveAttribute(
      'href',
      'https://saferide.esheria.org/downloads/SafeRide-1.0.4-26-Android-Preview.apk',
    );
    await expect(page.getByRole('link', { name: 'Download SHA-256' })).toHaveAttribute(
      'href',
      'https://saferide.esheria.org/downloads/SafeRide-1.0.4-26-Android-Preview.apk.sha256',
    );
    await expect(page.getByText('68e28e93f38bfd46579a27d7f7a5551fd9bd3c887363846d6710483f25b20e9d')).toBeVisible();
    await expect(page.getByText('SafeRide 1.0.4 Android Preview (build 26)').first()).toBeVisible();
    await expect(page.getByText('1.0.4 (code 26)')).toBeVisible();
    await expect(page.getByText('e706995f643a480d6fc3b8332670aee149ad5b9df164704099bce5720e57d09d')).toBeVisible();
    await expect(page.getByRole('link', { name: 'View release metadata' })).toHaveAttribute('href', '/releases/saferide-1.0.4-code26-android.json');
    await expect(page.getByText('do not uninstall or clear data', { exact: false })).toBeVisible();
    await expect(page.getByText('Install it as an update and keep your app data', { exact: false })).toBeVisible();
    expect(await page.content()).not.toContain('servers are not online');
    await expect(page.getByText('Full handset acceptance is still pending', { exact: false })).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain('56b61c7a7002a97aedc0c943a382d0e200ef152aec398ea82720effe235c65f5');
    expect(html).not.toContain('clean-install');
    expect(html).toContain('"softwareVersion":"1.0.4 (23)"');
  });

  test('footer contact link opens contact page', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="main-nav"]').getByRole('link', { name: 'Contact' })).toHaveCount(0);
    const footer = page.locator('[data-testid="main-footer"]');
    // Export builds rewrite internal hrefs to the trailing-slash form.
    await expect(footer.getByRole('link', { name: 'Contact' })).toHaveAttribute('href', /^\/contact\/?$/);
  });

  test('contact page uses public SafeRide inbox', async ({ page }) => {
    await page.goto(`${BASE}/contact`);
    await expect(page.getByText('saferide@esheria.org')).toBeVisible();
  });

  test('playbook hero panels render page images', async ({ page }) => {
    for (const route of ['/how-it-works', '/for-survivors', '/privacy-safety-trust']) {
      await page.goto(`${BASE}${route}`);
      const visual = page.getByTestId('page-hero-visual');
      await expect(visual).toBeVisible();
      await expect(visual.locator('img')).toBeVisible();
    }
  });

  test('partners page renders moving partner carousel', async ({ page }) => {
    await page.goto(`${BASE}/partners`);
    const carousel = page.getByTestId('partner-carousel');
    await carousel.scrollIntoViewIfNeeded();
    await expect(carousel).toBeVisible();
    await expect(carousel.getByText('UNICEF Venture Fund').first()).toBeVisible();
    await expect(carousel.getByText('FIDA Kenya').first()).toBeVisible();
    await expect(carousel.getByRole('link', { name: /FIDA Kenya/ }).first()).toHaveAttribute('href', 'https://fidakenya.org/');
    const animationName = await carousel.locator('.partner-marquee__track').evaluate((element) => getComputedStyle(element).animationName);
    expect(animationName).toBe('partner-marquee-scroll');
  });

  test('story page includes one UNICEF presentation photo', async ({ page }) => {
    await page.goto(`${BASE}/story`);
    const moment = page.getByTestId('unicef-presentation-moment');
    await moment.scrollIntoViewIfNeeded();
    await expect(moment).toBeVisible();
    await expect(moment.getByRole('heading', { name: 'SafeRide presented in the room.' })).toBeVisible();
    await expect(moment.locator('img')).toHaveCount(1);
    await expect(moment.getByText('Founder presentation and reviewer discussion during the UNICEF Venture Fund meet.')).toBeVisible();

    await page.goto(`${BASE}/partners`);
    await expect(page.getByTestId('unicef-presentation-moment')).toHaveCount(0);
  });

  test('partners page includes press coverage', async ({ page }) => {
    await page.goto(`${BASE}/partners`);
    const press = page.getByTestId('press-section');
    await press.scrollIntoViewIfNeeded();
    await expect(press).toBeVisible();
    await expect(press.getByText('BusinessDay NG')).toBeVisible();
    await expect(press.getByRole('link', { name: /UNICEF Femtech Ventures backs 11 startups/i })).toHaveAttribute(
      'href',
      'https://businessday.ng/technology/article/unicef-femtech-ventures-backs-11-startups/',
    );
  });

  test('blog page includes press feature with image', async ({ page }) => {
    await page.goto(`${BASE}/blog`);
    const press = page.getByTestId('blog-press-section');
    await press.scrollIntoViewIfNeeded();
    await expect(press).toBeVisible();
    await expect(press.getByText('BusinessDay NG')).toBeVisible();
    await expect(press.locator('img')).toBeVisible();
    const imageFrameIsLandscape = await press.getByTestId('press-image-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();

      return rect.width > rect.height;
    });

    expect(imageFrameIsLandscape).toBe(true);
    await expect(press.getByRole('link', { name: 'Read BusinessDay article' })).toHaveAttribute(
      'href',
      'https://businessday.ng/technology/article/unicef-femtech-ventures-backs-11-startups/',
    );
  });

  test('blog page includes UNICEF meet story with image', async ({ page }) => {
    await page.goto(`${BASE}/blog`);
    const story = page.getByTestId('blog-story-section');
    await story.scrollIntoViewIfNeeded();
    await expect(story).toBeVisible();
    await expect(story.getByText('Field note')).toBeVisible();
    await expect(story.getByRole('heading', { name: /Presenting SafeRide/ })).toBeVisible();
    await expect(story.locator('img')).toBeVisible();
    await expect(story.getByRole('link')).toHaveCount(0);
  });

  test('blog page remains contained on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/blog`);
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(395);

    const press = page.getByTestId('blog-press-section');
    await press.scrollIntoViewIfNeeded();
    const imageFrameIsLandscape = await press.getByTestId('press-image-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();

      return rect.width > rect.height;
    });

    expect(imageFrameIsLandscape).toBe(true);

    const story = page.getByTestId('blog-story-section');
    await story.scrollIntoViewIfNeeded();
    await expect(story.getByTestId('blog-story-image-frame')).toBeVisible();
  });

  test('index stat words fit inside their cards', async ({ page }) => {
    for (const route of ['/impact', '/partner-dashboard']) {
      await page.goto(`${BASE}${route}`);
      for (const value of await page.getByTestId('index-stat-value').all()) {
        const fits = await value.evaluate((element) => {
          const parent = element.parentElement;

          if (!parent) {
            return false;
          }

          return element.getBoundingClientRect().right <= parent.getBoundingClientRect().right;
        });

        expect(fits).toBe(true);
      }
    }
  });

  test('404 page renders for unknown route', async ({ page }) => {
    const response = await page.goto(`${BASE}/does-not-exist-xyz`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText('404')).toBeVisible();
  });

  test('no horizontal scroll on mobile 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE);
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(380);
  });

  test('public routes fit common viewport widths without clipped text', async ({ page }) => {
    test.setTimeout(120000);
    const viewports = [
      { width: 320, height: 740 },
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);

      for (const route of publicRoutes) {
        await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
        const result = await page.evaluate(() => {
          const overflow = document.documentElement.scrollWidth - window.innerWidth;
          const clippedText = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,p,a,button,li,dt,dd'))
            .filter((element) => {
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              const intentionallyHidden = element.closest('.skip-link') || element.closest('[aria-hidden="true"]');
              const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';

              if (!visible || intentionallyHidden) {
                return false;
              }

              return element.scrollWidth > element.clientWidth + 2 && style.overflowX !== 'visible';
            })
            .map((element) => element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80));

          return { overflow, clippedText };
        });

        expect(result.overflow, `${route} overflows at ${viewport.width}px`).toBeLessThanOrEqual(2);
        expect(result.clippedText, `${route} clips text at ${viewport.width}px`).toEqual([]);
      }
    }
  });

  test('mobile drawer hides closed links and closes with Escape', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE);
    const drawer = page.locator('[data-testid="mobile-drawer"]');

    await expect(drawer).toHaveAttribute('aria-hidden', 'true');
    await expect(drawer).toHaveAttribute('inert', '');

    await page.getByTestId('hamburger-btn').click();
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');
    await expect(drawer).not.toHaveAttribute('inert', '');
    await expect(drawer.getByRole('link', { name: 'What We Do' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByTestId('hamburger-btn')).toBeFocused();
  });

  test('single h1 on homepage', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('h1')).toHaveCount(1);
  });

  test('skip to content link exists', async ({ page }) => {
    await page.goto(BASE);
    const skip = page.locator('a[href="#main-content"]');
    await expect(skip).toBeAttached();
  });

  test('search returns real site results', async ({ page }) => {
    await page.goto(BASE);
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('textbox', { name: 'Search SafeRide pages' }).fill('retention');
    await expect(page.locator('[role="dialog"][aria-label="Search"] a').first()).toContainText('Privacy, Safety, and Trust');
    await expect(page.getByRole('link', { name: /Privacy, Safety, and Trust/ })).toBeVisible();
    await expect(page.getByText('Search coming soon')).toHaveCount(0);
  });

  test('CSP header is present', async ({ page }) => {
    const response = await page.goto(BASE);
    const csp = response?.headers()['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain("style-src 'self' 'unsafe-inline'");
  });

  test('visual snapshot  desktop', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('load');
    await page.screenshot({ path: 'tests/screenshots/v2-desktop.png', fullPage: true });
  });

  test('visual snapshot  mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE);
    await page.waitForLoadState('load');
    await page.screenshot({ path: 'tests/screenshots/v2-mobile.png', fullPage: true });
  });
});
