import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { CASEWORKER } from '../../mock/fixtures.mjs';
import { totpAt } from '../../mock/totp.mjs';

export { CASEWORKER };
export { ADMIN, INVITEE, ISSUED, REFERRAL_IDS } from '../../mock/fixtures.mjs';
export { totpAt };

type MockReset = {
  scenario?: 'default' | 'empty';
  pageSize?: number;
  absoluteSeconds?: number;
  /** P3's PARTNER_EVIDENCE_DOWNLOAD; the mock defaults to 'disabled' like the API. */
  evidenceDownload?: 'disabled' | 'originals';
  /** Migration 013's per-org switch for HURIA; the mock defaults to required like the API. */
  mfaRequired?: boolean;
};

/**
 * Every test starts from fresh synthetic data and fails on any CSP
 * violation or page error, and on anything written to browser storage.
 */
export const test = base.extend<{ mockReset: MockReset; guard: void }>({
  mockReset: [{}, { option: true }],
  guard: [
    async ({ page, request, mockReset }, use) => {
      const reset = await request.post('/__mock/reset', { data: mockReset });
      expect(reset.status()).toBe(204);
      // Tell the mock the browser's time on every request, so its clock follows
      // page.clock / context.clock and server and browser time can't drift.
      await page.context().addInitScript(() => {
        const realFetch = window.fetch.bind(window);
        window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
          const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
          headers.set('x-mock-client-time', String(Date.now()));
          return realFetch(input, { ...init, headers });
        };
      });
      const problems: string[] = [];
      page.on('console', message => {
        if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text());
      });
      page.on('pageerror', error => problems.push(`page error: ${error.message}`));
      await use();
      if (!page.isClosed()) {
        const stored = await page
          .evaluate(async () => ({
            local: window.localStorage.length,
            session: window.sessionStorage.length,
            indexedDb: (await indexedDB.databases()).length,
            cookies: document.cookie,
          }))
          .catch(() => null);
        if (stored) expect(stored, 'nothing may be kept in browser storage').toEqual({ local: 0, session: 0, indexedDb: 0, cookies: '' });
      }
      expect(problems, 'no CSP violations or page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Nothing in localStorage, sessionStorage, IndexedDB or readable cookies (for extra tabs). */
export async function expectNoStorage(page: Page) {
  const stored = await page.evaluate(async () => ({
    local: window.localStorage.length,
    session: window.sessionStorage.length,
    indexedDb: (await indexedDB.databases()).length,
    cookies: document.cookie,
  }));
  expect(stored).toEqual({ local: 0, session: 0, indexedDb: 0, cookies: '' });
}

type Account = { email: string; password: string; totpKey: string };

/** Signs in through the UI (as the caseworker unless another account is given). */
export async function signIn(page: Page, { stepOffset = 0, as = CASEWORKER }: { stepOffset?: number; as?: Account } = {}) {
  await page.goto('/sign-in/');
  await page.getByLabel('Work email').fill(as.email);
  await page.getByLabel('Password', { exact: true }).fill(as.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your authenticator code' })).toBeVisible();
  await page.getByLabel('6-digit code').fill(totpAt(as.totpKey, Date.now() / 1000 + stepOffset * 30));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/cases\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
  await expect(page.getByTestId('queue-row').first()).toBeVisible();
}

export async function openCase(page: Page, reference: string) {
  await page.getByRole('link', { name: reference }).click();
  await expect(page).toHaveURL(/\/case\/\?id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await expect(page.getByRole('heading', { level: 1, name: `Case ${reference}` })).toBeVisible();
}

export async function auditActions(request: APIRequestContext): Promise<Array<{ action: string; outcome: string; referralId?: string; attachmentId?: string; background?: boolean }>> {
  const response = await request.get('/__mock/audit');
  return (await response.json()).entries;
}

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** axe-core with the WCAG 2.0-2.2 A/AA rules; any violation fails the test. */
export async function expectAccessible(page: Page, screen: string) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const violations = results.violations.map(violation => `${violation.id} (${violation.impact}): ${violation.nodes.map(node => node.target.join(' ')).join(', ')}`);
  const review = results.incomplete.map(item => item.id).join(', ');
  console.log(`axe ${screen}: ${results.violations.length} violations, ${results.passes.length} rules passed, ${results.incomplete.length} need review${review ? ` (${review})` : ''}`);
  expect(violations, `axe violations on ${screen}`).toEqual([]);
}

/** Every visible control is at least 44 x 44 CSS px (radio dots count through their label). */
export async function expectTargetSizes(page: Page, screen: string) {
  const small = await page.evaluate(() => {
    const selector = 'button, a[href], input:not([type="hidden"]):not([type="radio"]), select, textarea, label.pill, input[type="radio"] + label';
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter(element => {
        if (element.closest('.sr-only, .skip-link') || element.classList.contains('sr-only')) return false;
        const box = element.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return false;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        return box.height < 44 || box.width < 44;
      })
      .map(element => `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 40)}" ${Math.round(element.getBoundingClientRect().width)}x${Math.round(element.getBoundingClientRect().height)}`);
  });
  expect(small, `targets under 44 px on ${screen}`).toEqual([]);
}

/** Saves a screenshot when SCREENSHOT_DIR is set (for review; not part of the assertions). */
export async function snap(page: Page, name: string) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}

/** No synthetic case content anywhere in the page text. */
export async function expectNoCaseContent(page: Page) {
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/SYNTHETIC|SR-[0-9A-Z]{4}-[0-9A-Z]{4}|\+254/);
}
