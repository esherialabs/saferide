import type { Page } from '@playwright/test';

import { CASEWORKER, auditActions, expect, expectAccessible, expectTargetSizes, signIn, snap, test, totpAt } from './helpers.ts';

const NEWEST_FIRST = ['SR-7K3Q-9M2D', 'SR-4T8N-2XHB', 'SR-9PQR-6WZA', 'SR-2MNB-8CVD', 'SR-6HJK-3LTE', 'SR-5DFG-7QWE', 'SR-8ZXC-1VBN'];

function pill(page: Page, name: string) {
  return page.locator('label.pill').filter({ hasText: new RegExp(`^${name}$`) });
}

test.describe('case queue', () => {
  test('lists cases newest first with minimal fields, a page at a time', async ({ page }) => {
    await signIn(page);
    // Only a count of cases needing attention may reach the title.
    await expect(page).toHaveTitle('(2) Cases · SafeRide × HURIA');
    const rows = page.getByTestId('queue-row');
    await expect(rows).toHaveCount(5);
    await expect(page.getByRole('columnheader')).toHaveText(['Priority', 'Reference', 'Type', 'Status', 'Assigned to', 'Onward referral', 'Received']);
    await expect(rows.first()).toContainText('Escalation');
    await expect(rows.first()).toContainText('New');
    await expect(rows.nth(4)).toContainText('No longer shared');
    await expect(rows.nth(4)).toContainText('Not shown');
    await expectAccessible(page, 'queue');
    await expectTargetSizes(page, 'queue');
    await snap(page, '05-queue');

    await page.getByRole('button', { name: 'Load more cases' }).click();
    await expect(rows).toHaveCount(7);
    await expect(rows.getByRole('link')).toHaveText(NEWEST_FIRST);
    await expect(page.getByRole('button', { name: 'Load more cases' })).toHaveCount(0);
    // Minimal fields only: no narrative, no other organisation's case.
    await expect(page.getByRole('main')).not.toContainText('SYNTHETIC');
    await expect(page.getByRole('main')).not.toContainText('SR-OTHR-0RG1');
  });

  test('filters by status and view, with a clear empty state', async ({ page }) => {
    await signIn(page);
    await pill(page, 'New').click();
    const rows = page.getByTestId('queue-row');
    await expect(rows.getByRole('link')).toHaveText(['SR-7K3Q-9M2D', 'SR-5DFG-7QWE', 'SR-8ZXC-1VBN']);
    await pill(page, 'Escalations').click();
    await expect(rows.getByRole('link')).toHaveText(['SR-7K3Q-9M2D', 'SR-9PQR-6WZA', 'SR-8ZXC-1VBN']);
    await pill(page, 'New').click();
    await expect(rows.getByRole('link')).toHaveText(['SR-7K3Q-9M2D', 'SR-8ZXC-1VBN']);
    await pill(page, 'Closed').click();
    await expect(page.getByTestId('queue-empty')).toContainText('No cases match these filters.');
    await expectAccessible(page, 'queue filtered empty');
    await snap(page, '06-queue-filtered-empty');
    await page.getByRole('button', { name: 'Show all cases' }).click();
    await expect(rows).toHaveCount(5);
    await pill(page, 'No longer shared').click();
    await expect(rows.getByRole('link')).toHaveText(['SR-6HJK-3LTE']);
    await expect(rows.first()).toContainText('No longer shared');
    await expect(page.getByRole('table')).not.toContainText(/withdr|survivor|SafeRide/i); // the row names no cause
    await snap(page, '06b-queue-no-longer-shared-filter');
  });

  test('the filters work from the keyboard', async ({ page }) => {
    await signIn(page);
    await page.getByRole('radio', { name: 'All' }).nth(1).focus(); // the status group's "All"
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'New', exact: true })).toBeChecked();
    await expect(page.getByTestId('queue-row')).toHaveCount(3);
    await page.getByRole('radio', { name: 'All' }).first().focus(); // the view group's "All"
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Needs attention' })).toBeChecked();
    await expect(page.getByTestId('queue-row')).toHaveCount(2);
  });

  test('refreshes in the background at most every 60 s, without the activity flag, so idle is not extended', async ({ page, request }) => {
    await page.clock.install();
    await signIn(page);
    const listRequests: Array<{ at: number; activity: string | undefined }> = [];
    page.on('request', item => {
      if (item.url().includes('/partner/v1/referrals?') || item.url().endsWith('/partner/v1/referrals')) {
        listRequests.push({ at: Date.now(), activity: item.headers()['x-saferide-partner-activity'] });
      }
    });
    const idleBefore = (await (await request.get('/__mock/sessions')).json()).sessions[0].idleExpiresAt as number;

    await page.clock.fastForward('00:50');
    await page.waitForTimeout(300);
    expect(listRequests, 'no refresh before 60 s').toEqual([]);

    await page.waitForTimeout(1100); // let real time pass so a sliding idle timer would move
    await page.clock.fastForward('00:15');
    await expect.poll(() => listRequests.length).toBe(1);
    expect(listRequests[0]?.activity, 'background polling sends no activity flag').toBeUndefined();
    const idleAfterBackground = (await (await request.get('/__mock/sessions')).json()).sessions[0].idleExpiresAt as number;
    expect(idleAfterBackground, 'background refresh leaves the idle expiry alone').toBe(idleBefore);
    const listed = (await auditActions(request)).filter(entry => entry.action === 'partner.referral.list');
    expect(listed.at(-1)?.background).toBe(true);

    await page.clock.fastForward('00:30');
    await page.waitForTimeout(300);
    expect(listRequests, 'still only one refresh within 60 s').toHaveLength(1);

    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => listRequests.length).toBe(2);
    expect(listRequests[1]?.activity).toBe('interactive');
    const idleAfterClick = (await (await request.get('/__mock/sessions')).json()).sessions[0].idleExpiresAt as number;
    expect(idleAfterClick).toBeGreaterThan(idleBefore);
  });
});

test.describe('empty queue', () => {
  test.use({ mockReset: { scenario: 'empty' } });

  test('says clearly that there are no cases yet', async ({ page }) => {
    await page.goto('/sign-in/');
    await page.getByLabel('Work email').fill(CASEWORKER.email);
    await page.getByLabel('Password', { exact: true }).fill(CASEWORKER.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('6-digit code').fill(totpAt(CASEWORKER.totpKey));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByTestId('queue-empty')).toHaveText(
      'No cases yet. New cases appear here when a survivor chooses to share with HURIA.',
    );
    await expect(page.getByRole('table')).toHaveCount(0);
    await expectAccessible(page, 'queue empty');
    await snap(page, '07-queue-empty');
  });
});
