import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { expect, expectAccessible, expectTargetSizes, openCase, signIn, test } from './helpers.ts';

// Visual review set: sign-in, queue, case detail and the "no longer shared"
// (withdrawn) case at four widths, light and dark. Every screen also runs axe
// (contrast included, so both palettes are checked), the 44 px target check and
// a no-horizontal-scroll check. Screenshots go to VISUAL_SCREENSHOT_DIR, or
// test-results/visual; they are for review, not pixel assertions.
const WIDTHS = [1440, 1024, 768, 390] as const;
const SCHEMES = ['light', 'dark'] as const;
const OUT_DIR = process.env.VISUAL_SCREENSHOT_DIR ?? path.join('test-results', 'visual');

async function shoot(page: Page, name: string, { fullPage = true } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Let the self-hosted fonts finish loading so every capture uses them.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage, animations: 'disabled' });
}

/**
 * On wide screens the case actions are a sticky column that scrolls on its
 * own. A full-page capture keeps the window height, which would cut that
 * column off, so capture the whole page in a window as tall as the page, and
 * the sticky column as it looks mid-scroll in the real window.
 */
async function shootCaseDetail(page: Page, name: string) {
  const viewport = page.viewportSize();
  if (!viewport || viewport.width < 1024) {
    await shoot(page, name);
    return;
  }
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: Math.max(height, viewport.height) });
  await shoot(page, name);
  await page.setViewportSize(viewport);
  await page.getByRole('region', { name: 'Evidence' }).scrollIntoViewIfNeeded();
  await shoot(page, name.replace('case-detail', 'case-detail-sticky'), { fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function expectNoHorizontalScroll(page: Page, screen: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `no horizontal scroll on ${screen}`).toBeLessThanOrEqual(0);
}

async function check(page: Page, screen: string, name: string) {
  await expectNoHorizontalScroll(page, screen);
  await expectAccessible(page, screen);
  await expectTargetSizes(page, screen);
  await (name.startsWith('case-detail') ? shootCaseDetail(page, name) : shoot(page, name));
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test.describe(`${scheme} at ${width} px`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: width >= 1024 ? 900 : 844 } });

      test('sign-in, queue, case detail and a case no longer shared', async ({ page }) => {
        const tag = `${width}-${scheme}`;
        await page.goto('/sign-in/');
        await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
        await check(page, `sign-in ${tag}`, `sign-in-${tag}`);

        await signIn(page);
        await check(page, `queue ${tag}`, `queue-${tag}`);

        await openCase(page, 'SR-7K3Q-9M2D');
        await check(page, `case detail ${tag}`, `case-detail-${tag}`);

        await page.getByRole('link', { name: 'Back to cases' }).first().click();
        await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
        await openCase(page, 'SR-6HJK-3LTE');
        await expect(page.getByTestId('withdrawn-tombstone')).toBeVisible();
        await check(page, `no longer shared ${tag}`, `no-longer-shared-${tag}`);
      });
    });
  }
}

// Case-management review set (escalation colours, banner, queue, case
// detail, onward-referral form) at 1440/768/390 px, light and dark, each
// checked with axe, the 44 px target check and no horizontal scroll.
// Screenshots go to CASE_MGMT_SCREENSHOT_DIR, or test-results/case-mgmt.
const CASE_MGMT_WIDTHS = [1440, 768, 390] as const;
const CASE_MGMT_DIR = process.env.CASE_MGMT_SCREENSHOT_DIR ?? path.join('test-results', 'case-mgmt');

async function shootTo(page: Page, dir: string, name: string, { fullPage = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage, animations: 'disabled' });
}

async function checkAndShoot(page: Page, screen: string, name: string, options: { fullPage?: boolean } = {}) {
  await expectNoHorizontalScroll(page, screen);
  await expectAccessible(page, screen);
  await expectTargetSizes(page, screen);
  // Wide case pages: a window as tall as the page, so the sticky actions column is captured whole.
  const viewport = page.viewportSize();
  if (name.startsWith('case-detail') && viewport && viewport.width >= 1024) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: viewport.width, height: Math.max(height, viewport.height) });
    await shootTo(page, CASE_MGMT_DIR, name, options);
    await page.setViewportSize(viewport);
    return;
  }
  await shootTo(page, CASE_MGMT_DIR, name, options);
}

for (const scheme of SCHEMES) {
  for (const width of CASE_MGMT_WIDTHS) {
    test.describe(`case management, ${scheme} at ${width} px`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: width >= 1024 ? 900 : 844 } });

      test('banner, queue, case detail, staff picker and onward-referral form', async ({ page }) => {
        const tag = `${width}-${scheme}`;
        await signIn(page);
        await expect(page.getByTestId('attention-banner')).toBeVisible();
        await expect(page.getByTestId('queue-summary')).toBeVisible();
        await checkAndShoot(page, `cm queue ${tag}`, `queue-${tag}`);
        // The banner as it first appears: the top of the window.
        await shootTo(page, CASE_MGMT_DIR, `banner-${tag}`, { fullPage: false });

        await openCase(page, 'SR-7K3Q-9M2D');
        await expect(page.getByTestId('attention-callout')).toBeVisible();
        await checkAndShoot(page, `cm case needs attention ${tag}`, `case-detail-escalation-${tag}`);

        await page.getByRole('link', { name: 'Back to cases' }).click();
        await openCase(page, 'SR-9PQR-6WZA');
        await expect(page.getByTestId('onward-item')).toHaveCount(2);
        await checkAndShoot(page, `cm case in progress ${tag}`, `case-detail-in-progress-${tag}`);
        await page.getByRole('region', { name: 'In charge' }).getByRole('button', { name: 'Change' }).click();
        await expect(page.getByTestId('staff-picker').getByRole('radio')).toHaveCount(5);
        await expectAccessible(page, `cm staff picker ${tag}`);
        await shootTo(page, CASE_MGMT_DIR, `staff-picker-${tag}`, { fullPage: false });
        await page.getByTestId('staff-picker').getByRole('button', { name: 'Cancel' }).click();

        await page.getByRole('link', { name: 'Back to cases' }).click();
        await openCase(page, 'SR-4T8N-2XHB');
        await page.getByRole('region', { name: 'Onward referrals' }).getByRole('button', { name: 'Add onward referral' }).click();
        const form = page.getByTestId('onward-form');
        await form.getByRole('radio', { name: /^Police/ }).check();
        await form.getByLabel('Contact role (optional)').fill('Gender desk officer');
        await form.getByLabel('Their reference (optional)').fill('OB 33/22/10/2026');
        await form.scrollIntoViewIfNeeded();
        await checkAndShoot(page, `cm onward form ${tag}`, `onward-form-${tag}`);
      });
    });
  }
}

test.describe('narrowest supported width', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('every screen fits 360 px without horizontal scrolling', async ({ page }) => {
    await page.goto('/sign-in/');
    await expectNoHorizontalScroll(page, 'sign-in 360');
    await signIn(page);
    await expectNoHorizontalScroll(page, 'queue 360');
    await expectTargetSizes(page, 'queue 360');
    await openCase(page, 'SR-7K3Q-9M2D');
    await expectNoHorizontalScroll(page, 'case detail 360');
    await expectTargetSizes(page, 'case detail 360');
    await page.getByRole('link', { name: 'Back to cases' }).click();
    await openCase(page, 'SR-9PQR-6WZA');
    await page.getByRole('region', { name: 'Onward referrals' }).getByRole('button', { name: 'Add onward referral' }).click();
    await expectNoHorizontalScroll(page, 'onward form 360');
    await expectTargetSizes(page, 'onward form 360');
  });
});

test('the lockup shows both logos with text alternatives, all from this origin', async ({ page }) => {
  await page.goto('/sign-in/');
  const lockup = page.getByTestId('brand-lockup');
  await expect(lockup.getByRole('img', { name: 'SafeRide' })).toBeVisible();
  await expect(lockup.getByRole('img', { name: 'Human Rights Agenda (HURIA)' })).toBeVisible();
  await expect(page.locator('[data-logo-slot="huria"]')).toHaveAttribute('data-logo-source', 'file');
  const images = await page.evaluate(() => [...document.images].map(image => ({ src: image.src, loaded: image.complete && image.naturalWidth > 0 })));
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) {
    expect(new URL(image.src).origin).toBe(new URL(page.url()).origin);
    expect(image.loaded).toBe(true);
  }
});
