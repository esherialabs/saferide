import type { BrowserContext, Page } from '@playwright/test';

import {
  REFERRAL_IDS, expect, expectNoCaseContent, expectNoStorage, openCase, signIn, snap, test,
} from './helpers.ts';

/** A second tab on the same session (same cookie), opened on a case. */
async function secondTabOnCase(context: BrowserContext, reference: keyof typeof REFERRAL_IDS): Promise<Page> {
  const tab = await context.newPage();
  await tab.goto(`/case/?id=${REFERRAL_IDS[reference]}`);
  await expect(tab.getByRole('heading', { level: 1, name: `Case ${reference}` })).toBeVisible();
  return tab;
}

function noteBox(page: Page) {
  return page.getByRole('region', { name: 'Internal notes' }).getByLabel('New note');
}

test.describe('several tabs share one session', () => {
  test('activity in one tab keeps an idle tab (and the shared session) signed in', async ({ page, context, request }) => {
    await context.clock.install();
    await signIn(page);
    const idle = await context.newPage();
    await idle.goto('/cases/');
    await expect(idle.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();

    await openCase(page, 'SR-4T8N-2XHB');
    await noteBox(page).click();
    await page.keyboard.type('SYNTHETIC. Draft in the busy tab.');
    await context.clock.fastForward('20:00');
    // This input is 20 min after the last request, so it sends a keep-alive; let it land before moving time.
    const keepAlive = page.waitForResponse(response => new URL(response.url()).pathname === '/partner/v1/me'
      && response.request().headers()['x-saferide-partner-activity'] === 'interactive' && response.ok());
    await noteBox(page).click();
    await page.keyboard.type(' More.');
    await keepAlive;
    await context.clock.fastForward('15:00'); // the idle tab has had no input of its own for 35 min

    await expect(idle).toHaveURL(/\/cases\/$/);
    await expect(idle.getByTestId('session-warning')).toBeHidden();
    await expect(page).toHaveURL(/\/case\/\?id=/);
    await expect(noteBox(page)).toHaveValue('SYNTHETIC. Draft in the busy tab. More.');
    await expectNoStorage(idle);
  });

  test('signing out in one tab wipes every other tab at once', async ({ page, context }) => {
    await signIn(page);
    const other = await secondTabOnCase(context, 'SR-7K3Q-9M2D');
    await expect(other.getByText('SYNTHETIC TEST CASE.').first()).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(other).toHaveURL(/\/sign-in\/$/);
    await expect(other.getByText('You have signed out.')).toBeVisible();
    await expectNoCaseContent(other);
    await expectNoStorage(other);
  });

  test('a session ended on the server is noticed by the background check and wipes every tab at once', async ({ page, context, request }) => {
    await context.clock.install();
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    const other = await secondTabOnCase(context, 'SR-4T8N-2XHB');
    await context.clock.fastForward('10:00');
    await expect(page).toHaveURL(/\/case\/\?id=/);
    await expect(other).toHaveURL(/\/case\/\?id=/);

    await request.post('/__mock/expire-sessions'); // e.g. revoked by an operator at 10 min, long before any local limit
    await context.clock.fastForward('01:05');
    for (const tab of [page, other]) {
      await expect(tab).toHaveURL(/\/sign-in\/$/);
      await expect(tab.getByText('Your session has ended. Sign in again to continue.')).toBeVisible();
      await expectNoCaseContent(tab);
    }
  });

  test('a note typed in another tab is warned about before signing out', async ({ page, context }) => {
    await signIn(page);
    const other = await secondTabOnCase(context, 'SR-4T8N-2XHB');
    await noteBox(other).fill('SYNTHETIC. Not added yet.');

    await page.getByRole('button', { name: 'Sign out' }).click();
    const prompt = page.getByTestId('sign-out-draft');
    await expect(prompt).toContainText('A note started in another SafeRide tab has not been added yet.');
    await expect(prompt.getByRole('button', { name: 'Keep working' })).toBeFocused();
    await snap(page, '19-sign-out-draft-elsewhere');
    await prompt.getByRole('button', { name: 'Keep working' }).click();
    await expect(prompt).toBeHidden();
    await expect(other).toHaveURL(/\/case\/\?id=/);
    await expect(noteBox(other)).toHaveValue('SYNTHETIC. Not added yet.');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByTestId('sign-out-draft').getByRole('button', { name: 'Sign out anyway' }).click();
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(other).toHaveURL(/\/sign-in\/$/);
    await expectNoCaseContent(other);
  });

  test('a note in this tab is warned about on sign-out and in the idle warning', async ({ page, context, request }) => {
    await context.clock.install();
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    await noteBox(page).fill('SYNTHETIC. Half-written.');

    await page.getByRole('button', { name: 'Sign out' }).click();
    const prompt = page.getByTestId('sign-out-draft');
    await expect(prompt).toContainText('You have a note you have not added yet. It will be lost if you sign out.');
    await prompt.getByRole('button', { name: 'Keep working' }).click();

    await context.clock.fastForward('28:10');
    const warning = page.getByTestId('session-warning');
    await expect(warning.getByTestId('session-warning-draft')).toHaveText(
      'You have a note you have not added yet. It will be lost unless you stay signed in.',
    );
    await snap(page, '20-idle-warning-draft');
    await warning.getByRole('button', { name: 'Stay signed in' }).click();
    await expect(noteBox(page)).toHaveValue('SYNTHETIC. Half-written.');
  });
});

test.describe('without BroadcastChannel (storage-free fallback)', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true });
    });
  });

  test('a sign-out in another tab is noticed by the background session check', async ({ page, context, request }) => {
    await context.clock.install();
    await signIn(page);
    const other = await secondTabOnCase(context, 'SR-7K3Q-9M2D');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(other).toHaveURL(/\/case\/\?id=/); // no channel: not told yet

    await context.clock.fastForward('00:31');
    await expect(other).toHaveURL(/\/sign-in\/$/);
    await expect(other.getByText('Your session has ended. Sign in again to continue.')).toBeVisible();
    await expectNoCaseContent(other);
  });

  test('an idle tab asks the server before signing out a session used in another tab', async ({ page, context, request }) => {
    await context.clock.install();
    await signIn(page);
    const idle = await context.newPage();
    await idle.goto('/cases/');
    await expect(idle.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();

    await context.clock.fastForward('25:00');
    // User activity in the other tab, seen by the server: let it land before moving time.
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/partner/v1/referrals'
      && response.request().headers()['x-saferide-partner-activity'] === 'interactive' && response.ok());
    await page.getByRole('button', { name: 'Refresh' }).click();
    await refreshed;
    await context.clock.fastForward('05:10'); // the idle tab's own 30 minutes are up

    await expect(idle.getByTestId('session-warning')).toBeHidden();
    await expect(idle).toHaveURL(/\/cases\/$/);
    await expect(idle.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
  });
});
