import type { Page } from '@playwright/test';

import {
  REFERRAL_IDS, auditActions, expect, expectAccessible, expectTargetSizes, openCase, signIn, test,
} from './helpers.ts';

const ID = REFERRAL_IDS;
const ME = 'Amina Test-Caseworker (you)';

function rows(page: Page) {
  return page.getByTestId('queue-row');
}

async function sessions(request: import('@playwright/test').APIRequestContext) {
  return (await (await request.get('/__mock/sessions')).json()).sessions as Array<{ idleExpiresAt: number }>;
}

test.describe('attention banner', () => {
  test('a malformed summary is shown as unavailable, never as an all-clear', async ({ page }) => {
    await page.route('**/partner/v1/summary', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await signIn(page);
    await expect(page.getByTestId('summary-unavailable')).toBeVisible();
    await expect(page.getByTestId('attention-banner')).not.toBeVisible();
    await expectAccessible(page, 'case counts unavailable');
  });
  test('shows on every page with only a count, and links to exactly the cases that need attention', async ({ page }) => {
    await signIn(page);
    const banner = page.getByTestId('attention-banner');
    await expect(banner).toContainText('2 new escalations need attention');
    await expect(banner).not.toContainText(/SR-|SYNTHETIC/);
    await expect(page).toHaveTitle('(2) Cases · SafeRide × HURIA');
    await expect(page.getByTestId('attention-count')).toHaveText('2 need attention');
    await expect(page.getByRole('link', { name: 'Cases 2 need attention' })).toBeVisible();
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon-alert.svg');

    await openCase(page, 'SR-4T8N-2XHB');
    await expect(banner).toContainText('2 new escalations need attention');
    await expect(page).toHaveTitle('(2) Case · SafeRide × HURIA');
    await banner.getByRole('link', { name: 'Show them' }).click();
    await expect(page).toHaveURL(/\/cases\/\?view=attention$/);
    await expect(page.getByRole('radio', { name: 'Needs attention' })).toBeChecked();
    await expect(rows(page).getByRole('link')).toHaveText(['SR-7K3Q-9M2D', 'SR-8ZXC-1VBN']);
    for (const row of await rows(page).all()) {
      await expect(row.getByTestId('needs-attention').first()).toHaveText('Needs attention');
      await expect(row.getByTestId('priority-urgent').first()).toHaveText('Escalation');
    }
    await expectAccessible(page, 'queue: needs attention');
  });

  test('the poll runs at most every 60 s without the activity flag, and idle sign-out still happens', async ({ page, request }) => {
    await page.clock.install();
    await signIn(page);
    const polls: Array<{ at: number; activity: string | undefined }> = [];
    page.on('request', item => {
      if (new URL(item.url()).pathname === '/partner/v1/summary') {
        polls.push({ at: Number(item.headers()['x-mock-client-time']), activity: item.headers()['x-saferide-partner-activity'] });
      }
    });
    const idleBefore = (await sessions(request))[0]!.idleExpiresAt;

    for (let minute = 1; minute <= 28; minute += 1) await page.clock.fastForward('01:00');
    await expect(page).toHaveURL(/\/cases\/$/);
    expect(polls.length, 'the banner kept polling in a visible tab').toBeGreaterThanOrEqual(10);
    expect(polls.every(poll => poll.activity === undefined), 'no poll sends the activity flag').toBe(true);
    for (let index = 1; index < polls.length; index += 1) {
      expect(polls[index]!.at - polls[index - 1]!.at, 'never more often than every 60 s').toBeGreaterThanOrEqual(60_000);
    }
    expect((await sessions(request))[0]!.idleExpiresAt, 'polling left the idle expiry alone').toBe(idleBefore);
    const reads = (await auditActions(request)).filter(entry => entry.action === 'partner.summary.read');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(entry => entry.background === true)).toBe(true);

    await expect(page.getByTestId('session-warning')).toBeVisible();
    await page.clock.fastForward('02:05');
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(page.getByText('You were signed out after 30 minutes without activity.')).toBeVisible();
    await expect(page.getByTestId('attention-banner')).toHaveCount(0);
    await expect(page).toHaveTitle('Sign in · SafeRide × HURIA');
  });

  test('polls only while the tab is visible', async ({ page }) => {
    await page.clock.install();
    await signIn(page);
    let polls = 0;
    page.on('request', item => {
      if (new URL(item.url()).pathname === '/partner/v1/summary') polls += 1;
    });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    for (let minute = 1; minute <= 3; minute += 1) await page.clock.fastForward('01:00');
    expect(polls, 'no poll from a hidden tab').toBe(0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => polls).toBe(1);
  });

  test('the chime is off by default, never asks for notifications, and is off again after a reload', async ({ page }) => {
    await page.addInitScript(() => {
      const calls = { notification: 0 };
      (window as unknown as { __calls: typeof calls }).__calls = calls;
      if ('Notification' in window) {
        window.Notification.requestPermission = () => {
          calls.notification += 1;
          return Promise.resolve('denied');
        };
      }
    });
    await signIn(page);
    const chime = page.getByTestId('chime-toggle');
    await expect(chime).toHaveAccessibleName('Chime for new escalations');
    await expect(chime).toHaveAttribute('aria-pressed', 'false');
    await chime.click();
    await expect(chime).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
    await expect(page.getByTestId('chime-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => (window as unknown as { __calls: { notification: number } }).__calls.notification)).toBe(0);
  });
});

test.describe('acknowledging', () => {
  test('opening a case does not acknowledge it; "Acknowledge" does, and clears "needs attention" everywhere', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    const summary = page.getByTestId('case-summary');
    await expect(summary.getByTestId('priority-urgent')).toHaveText('Escalation');
    await expect(summary.getByTestId('needs-attention')).toHaveText('Needs attention');
    const callout = page.getByTestId('attention-callout');
    await expect(callout.getByRole('heading', { name: 'This escalation needs attention' })).toBeVisible();
    expect((await auditActions(request)).some(entry => entry.action === 'partner.referral.status'), 'opening is a read only').toBe(false);
    await expectAccessible(page, 'case needs attention');
    await expectTargetSizes(page, 'case needs attention');

    await callout.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByTestId('case-flash')).toContainText('Acknowledged.');
    await expect(page.getByTestId('case-flash')).toBeFocused();
    await expect(callout).toHaveCount(0);
    await expect(summary.getByTestId('needs-attention')).toHaveCount(0);
    await expect(summary.getByTestId('priority-urgent')).toHaveText('Escalation');
    await expect(page.getByRole('region', { name: 'Status' }).locator('.chip').first()).toHaveText('Acknowledged');
    await expect(page.getByTestId('timeline')).toContainText(`Acknowledged by ${ME}`);
    await expect(page.getByTestId('attention-banner')).toContainText('1 new escalation needs attention');
    await expect(page).toHaveTitle('(1) Case · SafeRide × HURIA');

    await page.getByRole('link', { name: 'Back to cases' }).click();
    const first = rows(page).first();
    await expect(first.getByRole('link')).toHaveText('SR-7K3Q-9M2D');
    await expect(first.getByTestId('needs-attention')).toHaveCount(0);
    await expect(first).toContainText('Acknowledged');
    await expect(page.getByTestId('stat-needsAttention')).toContainText('1');
  });

  test('an acknowledgement made elsewhere first is not overwritten (409)', async ({ page, request }) => {
    await signIn(page);
    await page.goto(`/case/?id=${ID['SR-8ZXC-1VBN']}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Case SR-8ZXC-1VBN' })).toBeVisible();
    await request.post(`/__mock/referrals/${ID['SR-8ZXC-1VBN']}/status`, { data: { status: 'acknowledged' } });
    await page.getByTestId('attention-callout').getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByTestId('attention-callout')).toContainText('Someone else updated this case after you opened it.');
    await page.getByTestId('attention-callout').getByRole('button', { name: 'Reload case' }).click();
    await expect(page.getByTestId('attention-callout')).toHaveCount(0);
  });
});

test.describe('in charge', () => {
  test('assign to me, change to a colleague, and refuse a stale change (409)', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    const charge = page.getByRole('region', { name: 'In charge' });
    await expect(charge.getByTestId('charge-assignee')).toHaveText('Nobody is in charge of this case yet.');
    await expect(page.getByTestId('summary-assignee')).toHaveText('Unassigned');

    await charge.getByRole('button', { name: 'Assign to me' }).click();
    await expect(charge.getByTestId('charge-assignee')).toHaveText(ME);
    await expect(page.getByTestId('summary-assignee')).toHaveText(ME);
    await expect(charge).toContainText(`${ME} is now in charge.`);
    await expect(page.getByTestId('timeline')).toContainText(`${ME} took charge`);
    await expect(charge.getByRole('button', { name: 'Assign to me' })).toHaveCount(0);

    await charge.getByRole('button', { name: 'Change' }).click();
    const picker = page.getByTestId('staff-picker');
    await expect(picker.getByRole('heading', { name: 'Who is in charge of this case?' })).toBeVisible();
    await expect(picker.getByRole('radio')).toHaveCount(5);
    await expect(picker.getByRole('radio', { name: /Amina Test-Caseworker \(you\)/ })).toBeChecked();
    await expectAccessible(page, 'staff picker');
    await picker.getByRole('radio', { name: /Juma Test-Caseworker/ }).check();
    await picker.getByRole('button', { name: 'Save' }).click();
    await expect(picker).toBeHidden();
    await expect(charge.getByTestId('charge-assignee')).toHaveText('Juma Test-Caseworker');
    await expect(page.getByTestId('timeline')).toContainText(`${ME} assigned it to Juma Test-Caseworker`);

    // Meanwhile, the admin gives the case to themselves in another browser.
    await request.post(`/__mock/referrals/${ID['SR-7K3Q-9M2D']}/assign`, { data: { assigneeId: 'usr_admin' } });
    await charge.getByRole('button', { name: 'Assign to me' }).click();
    await expect(charge).toContainText('Someone else changed who is in charge after you opened this case.');
    await expect(charge.getByTestId('charge-conflict-current')).toHaveText('Zawadi Test-Admin is in charge now. Reload the case to see the latest.');
    await expect(charge.getByTestId('charge-assignee')).toHaveText('Juma Test-Caseworker'); // nothing overwritten
    const denied = (await auditActions(request)).filter(entry => entry.action === 'partner.referral.assign' && entry.outcome === 'denied');
    expect(denied).toHaveLength(1);
    await charge.getByRole('button', { name: 'Reload case' }).click();
    await expect(charge.getByTestId('charge-assignee')).toHaveText('Zawadi Test-Admin');

    // Taking it back now works, and "Mine" lists it.
    await charge.getByRole('button', { name: 'Assign to me' }).click();
    await expect(charge.getByTestId('charge-assignee')).toHaveText(ME);
    await page.getByRole('link', { name: 'Back to cases' }).click();
    await page.locator('label.pill').filter({ hasText: /^Mine$/ }).click();
    await expect(rows(page).getByRole('link')).toHaveText(['SR-7K3Q-9M2D', 'SR-4T8N-2XHB']);
  });

  test('only active staff can be assigned: a deactivated account is refused (400 invalid_assignee)', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    const charge = page.getByRole('region', { name: 'In charge' });
    await charge.getByRole('button', { name: 'Choose someone' }).click();
    const picker = page.getByTestId('staff-picker');
    await expect(picker.getByRole('radio')).toHaveCount(5);
    await request.post('/__mock/users/usr_colleague/disable');
    await picker.getByRole('radio', { name: /Juma Test-Caseworker/ }).check();
    await picker.getByRole('button', { name: 'Save' }).click();
    await expect(charge).toContainText('That person can no longer be assigned');
    await expect(charge.getByTestId('charge-assignee')).toHaveText('Nobody is in charge of this case yet.');
    await charge.getByRole('button', { name: 'Choose someone' }).click();
    await expect(picker.getByRole('radio')).toHaveCount(4); // the inactive account is no longer listed
  });

  test('when SafeRide disables a staff account, their cases are released and the history says SafeRide did it', async ({ page, request }) => {
    await request.post('/__mock/users/usr_colleague/disable');
    await signIn(page);
    const row = rows(page).filter({ hasText: 'SR-9PQR-6WZA' });
    await expect(row.getByTestId('queue-assignee').first()).toHaveText('Unassigned');
    await expect(page.getByTestId('stat-unassigned')).toContainText('4');
    await openCase(page, 'SR-9PQR-6WZA');
    await expect(page.getByRole('region', { name: 'In charge' }).getByTestId('charge-assignee')).toHaveText('Nobody is in charge of this case yet.');
    const entry = page.getByTestId('timeline').locator('li[data-actor="saferide"]');
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('SafeRide released the case: the person in charge can no longer use the dashboard');
    await expect(entry.locator('svg')).toHaveCount(1); // the neutral shield, not a person
    await expect(page.getByTestId('timeline')).not.toContainText('SafeRide (you)');
    await expectAccessible(page, 'case released by SafeRide');
  });

  test('a case can be left with nobody in charge', async ({ page }) => {
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    const charge = page.getByRole('region', { name: 'In charge' });
    await expect(charge.getByTestId('charge-assignee')).toHaveText(ME);
    await charge.getByRole('button', { name: 'Change' }).click();
    const picker = page.getByTestId('staff-picker');
    await picker.getByRole('radio', { name: 'Nobody' }).check();
    await picker.getByRole('button', { name: 'Save' }).click();
    await expect(charge.getByTestId('charge-assignee')).toHaveText('Nobody is in charge of this case yet.');
    await expect(page.getByTestId('timeline')).toContainText(`${ME} removed the person in charge`);
  });
});

test.describe('onward referrals', () => {
  test('the in-progress case shows who is in charge and its police referral', async ({ page }) => {
    await signIn(page);
    const row = rows(page).filter({ hasText: 'SR-9PQR-6WZA' });
    await expect(row.getByTestId('queue-assignee').first()).toHaveText('Juma Test-Caseworker');
    await expect(row.getByTestId('queue-onward').first()).toContainText('Police');
    await expect(row.getByTestId('queue-onward').first()).toContainText('Accepted');
    await expect(row.getByTestId('queue-onward').first()).toContainText('+1 more');

    await openCase(page, 'SR-9PQR-6WZA');
    await expect(page.getByRole('region', { name: 'In charge' }).getByTestId('charge-assignee')).toHaveText('Juma Test-Caseworker');
    await expect(page.getByRole('region', { name: 'In charge' })).toContainText('Assigned by Zawadi Test-Admin');
    const police = page.getByTestId('onward-item').filter({ has: page.getByRole('heading', { name: 'Police' }) });
    await expect(police.getByTestId('onward-status')).toHaveText('Accepted');
    await expect(police).toContainText('Gender desk officer');
    await expect(police).toContainText('OB 14/21/10/2026');
    await expect(police).toContainText('Recorded by Juma Test-Caseworker');
    await expect(police.getByRole('button')).toHaveText(['Mark completed']);
    await expect(page.getByTestId('timeline')).toContainText('Juma Test-Caseworker marked the Police referral accepted');
  });

  test('add a police referral and move it through the allowed statuses only', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    const panel = page.getByRole('region', { name: 'Onward referrals' });
    await expect(panel.getByTestId('onward-privacy')).toHaveText(
      'Record roles, not personal details. This stays inside HURIA and is deleted if the survivor stops sharing.',
    );
    await expect(panel.getByTestId('onward-none')).toBeVisible();
    await panel.getByRole('button', { name: 'Add onward referral' }).click();
    const form = panel.getByTestId('onward-form');
    await expect(form.getByRole('heading', { name: 'New onward referral' })).toBeFocused();
    await expect(form.getByTestId('onward-privacy')).toBeVisible();
    await expect(form.getByRole('radio')).toHaveCount(9); // seven types, then planned / made
    await expect(form.getByLabel('Organisation (optional)')).toHaveAttribute('maxlength', '120');
    await expect(form.getByLabel('Contact role (optional)')).toHaveAttribute('maxlength', '120');
    await expect(form.getByLabel('Their reference (optional)')).toHaveAttribute('maxlength', '80');
    await expect(form.getByLabel('Note (optional)')).toHaveAttribute('maxlength', '1000');

    await form.getByRole('button', { name: 'Save onward referral' }).click();
    await expect(form.getByRole('link', { name: 'Choose where the survivor is referred to.' })).toBeVisible();
    await expectAccessible(page, 'onward referral form');
    await expectTargetSizes(page, 'onward referral form');

    await form.getByRole('radio', { name: /^Police/ }).check();
    await form.getByLabel('Organisation (optional)').fill('Central Police Station (synthetic)');
    await form.getByLabel('Contact role (optional)').fill('Gender desk officer');
    await form.getByLabel('Their reference (optional)').fill('OB 33/22/10/2026');
    await form.getByRole('button', { name: 'Save onward referral' }).click();
    await expect(form).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Add onward referral' })).toBeFocused();

    const item = panel.getByTestId('onward-item').filter({ hasText: 'OB 33/22/10/2026' });
    await expect(item.getByTestId('onward-status')).toHaveText('Planned');
    await expect(item).toContainText(`Recorded by ${ME}`);
    await expect(item.getByRole('button')).toHaveText(['Mark as made', 'Cancel referral']);
    await expect(page.getByTestId('timeline')).toContainText(`${ME} recorded an onward referral: Police (planned)`);

    const confirm = page.getByTestId('onward-confirm');
    const steps: Array<[string, string, string[]]> = [
      ['Mark as made', 'Made', ['Mark accepted', 'Mark declined']],
      ['Mark accepted', 'Accepted', ['Mark completed']],
      ['Mark completed', 'Completed', []],
    ];
    for (const [action, status, next] of steps) {
      await item.getByRole('button', { name: action }).click();
      await expect(confirm.getByRole('heading', { name: 'Update this onward referral?' })).toBeVisible();
      await confirm.getByRole('button', { name: 'Update referral' }).click();
      await expect(item.getByTestId('onward-status')).toHaveText(status);
      await expect(item.getByRole('button')).toHaveText(next);
    }
    await expect(page.getByTestId('timeline')).toContainText(`${ME} marked the Police referral completed`);
    const moves = (await auditActions(request)).filter(entry => entry.action === 'partner.onward.status');
    expect(moves.map(entry => entry.outcome)).toEqual(['success', 'success', 'success']);

    await page.getByRole('link', { name: 'Back to cases' }).click();
    const row = rows(page).filter({ hasText: 'SR-4T8N-2XHB' });
    await expect(row.getByTestId('queue-onward').first()).toContainText('Police');
    await expect(row.getByTestId('queue-onward').first()).toContainText('Completed');
  });

  test('control characters are stripped as typed, and refused text is shown at the field', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    const panel = page.getByRole('region', { name: 'Onward referrals' });
    await panel.getByRole('button', { name: 'Add onward referral' }).click();
    const form = panel.getByTestId('onward-form');
    await form.getByRole('radio', { name: /^Police/ }).check();
    const reference = form.getByLabel('Their reference (optional)');
    await reference.fill('OB\u0007 44/22/10/2026\u001b');
    await expect(reference).toHaveValue('OB 44/22/10/2026');
    const sent: string[] = [];
    page.on('request', item => {
      if (item.method() === 'POST' && /\/onward$|\/notes$/.test(new URL(item.url()).pathname)) sent.push(item.postData() ?? '');
    });

    // The server refuses the text anyway (as #314 would for a control character): shown at the field.
    await request.post('/__mock/refuse-text', { data: { count: 1 } });
    await form.getByRole('button', { name: 'Save onward referral' }).click();
    await expect(form.getByRole('link', { name: /SafeRide did not accept the Their reference/ })).toBeVisible();
    await expect(reference).toHaveAttribute('aria-invalid', 'true');
    await expect(form.locator('#onward-externalReference-error')).toContainText('Remove any unusual characters');
    await expectAccessible(page, 'onward form refused text');
    await form.getByRole('button', { name: 'Save onward referral' }).click();
    await expect(panel.getByTestId('onward-item').filter({ hasText: 'OB 44/22/10/2026' })).toBeVisible();

    const notes = page.getByRole('region', { name: 'Internal notes' });
    const note = notes.getByLabel('New note');
    await note.fill('SYNTHETIC.\u0000 Called back\n\tlater');
    await expect(note).toHaveValue('SYNTHETIC. Called back\n\tlater');
    await request.post('/__mock/refuse-text', { data: { count: 1 } });
    await notes.getByRole('button', { name: 'Add note' }).click();
    await expect(notes.locator('#note-error')).toHaveText(/SafeRide did not accept this note/);
    await expect(note).toHaveAttribute('aria-invalid', 'true');
    await expect(note).toHaveValue('SYNTHETIC. Called back\n\tlater'); // kept for another try
    await notes.getByRole('button', { name: 'Add note' }).click();
    await expect(notes.getByTestId('notes-list')).toContainText('SYNTHETIC. Called back');
    expect(sent.length).toBe(4);
    for (const body of sent) expect(body, 'no control characters reach the API').not.toMatch(/\\u00(0[0-8]|0[bcef]|1[0-9a-f]|7f)|\\[bfr]/i);
  });

  test('a stale onward update is refused (409) and the case reloads', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-9PQR-6WZA');
    const counselling = page.getByTestId('onward-item').filter({ has: page.getByRole('heading', { name: 'Counselling' }) });
    await expect(counselling.getByTestId('onward-status')).toHaveText('Planned');
    await request.post(`/__mock/referrals/${ID['SR-9PQR-6WZA']}/onward-status`, {
      data: { onwardId: '0e0e0000-0000-4000-8000-000000000002', status: 'made' },
    });
    await counselling.getByRole('button', { name: 'Mark as made' }).click();
    await page.getByTestId('onward-confirm').getByRole('button', { name: 'Update referral' }).click();
    const panel = page.getByRole('region', { name: 'Onward referrals' });
    await expect(panel).toContainText('Someone else updated this onward referral after you opened the case.');
    await expect(counselling.getByTestId('onward-status')).toHaveText('Planned');
    await panel.getByRole('button', { name: 'Reload case' }).click();
    await expect(counselling.getByTestId('onward-status')).toHaveText('Made');
  });

  test('a case no longer shared shows no onward referrals or assignee', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-9PQR-6WZA');
    await request.post(`/__mock/referrals/${ID['SR-9PQR-6WZA']}/withdraw`);
    await page.getByRole('region', { name: 'In charge' }).getByRole('button', { name: 'Assign to me' }).click();
    await expect(page.getByTestId('withdrawn-tombstone')).toBeVisible();
    await expect(page.getByTestId('onward-panel')).toHaveCount(0);
    await expect(page.getByTestId('charge-panel')).toHaveCount(0);
    await expect(page.getByRole('main')).not.toContainText(/Police|Juma|OB 14/);
  });
});

test.describe('queue', () => {
  test('quick filters: needs attention, mine, unassigned and escalations, with counts from the summary', async ({ page }) => {
    await signIn(page);
    await expect(page.getByTestId('stat-needsAttention')).toContainText('2');
    await expect(page.getByTestId('stat-newTotal')).toContainText('3');
    await expect(page.getByTestId('stat-inProgress')).toContainText('1');
    await expect(page.getByTestId('stat-unassigned')).toContainText('3');
    await expect(page.getByTestId('stat-mine')).toContainText('1');

    const pill = (name: string) => page.locator('label.pill').filter({ hasText: new RegExp(`^${name}$`) });
    await pill('Needs attention').click();
    await expect(rows(page).getByRole('link')).toHaveText(['SR-7K3Q-9M2D', 'SR-8ZXC-1VBN']);
    await expect(page.getByTestId('attention-filter-note')).toBeVisible();
    await pill('Mine').click();
    await expect(page).toHaveURL(/\?view=mine$/);
    await expect(rows(page).getByRole('link')).toHaveText(['SR-4T8N-2XHB']);
    await expect(rows(page).first().getByTestId('queue-assignee').first()).toHaveText(ME);
    await pill('Unassigned').click();
    await expect(rows(page).getByRole('link')).toHaveText(['SR-7K3Q-9M2D', 'SR-5DFG-7QWE', 'SR-8ZXC-1VBN']);
    await pill('Escalations').click();
    await expect(rows(page).getByRole('link')).toHaveText(['SR-7K3Q-9M2D', 'SR-9PQR-6WZA', 'SR-8ZXC-1VBN']);
    // The view survives a reload through the address bar (a fixed code, no case data).
    await page.reload();
    await expect(page.getByRole('radio', { name: 'Escalations' })).toBeChecked();
    await expect(rows(page)).toHaveCount(3);
    await pill('All').first().click();
    await expect(page).toHaveURL(/\/cases\/$/);
    await expect(rows(page)).toHaveCount(5);
  });

  test('rows open the case by click and by keyboard', async ({ page }) => {
    await signIn(page);
    const row = rows(page).filter({ hasText: 'SR-2MNB-8CVD' });
    await row.locator('td').nth(3).click(); // the Status cell, not the link
    await expect(page.getByRole('heading', { level: 1, name: 'Case SR-2MNB-8CVD' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to cases' }).click();
    await rows(page).filter({ hasText: 'SR-9PQR-6WZA' }).getByRole('link', { name: 'SR-9PQR-6WZA' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Case SR-9PQR-6WZA' })).toBeVisible();
  });

  test('escalations are red with an icon and words; the attention dot pulses, and stays still with reduced motion', async ({ page }) => {
    await signIn(page);
    const urgent = rows(page).first();
    await expect(urgent).toHaveAttribute('data-priority', 'urgent');
    await expect(urgent.getByTestId('priority-urgent').first()).toHaveText('Escalation');
    await expect(urgent.getByTestId('priority-urgent').first().locator('svg')).toHaveCount(1);
    const edge = await urgent.locator('td').first().evaluate(cell => getComputedStyle(cell).boxShadow);
    expect(edge).toContain('inset');
    const normal = rows(page).filter({ hasText: 'SR-4T8N-2XHB' });
    await expect(normal).toHaveAttribute('data-priority', 'normal');
    expect(await normal.locator('td').first().evaluate(cell => getComputedStyle(cell).boxShadow)).toBe('none');

    const ping = urgent.getByTestId('attention-ping').first();
    expect(await ping.evaluate(element => getComputedStyle(element).animationName)).toBe('ping');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await ping.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await expect(urgent.getByTestId('needs-attention').first()).toBeVisible();
    await expect(page.locator('.attention-ping')).not.toHaveCount(0);
    const moving = await page.evaluate(() => [...document.querySelectorAll('.attention-ping')].filter(element => getComputedStyle(element).animationName !== 'none').length);
    expect(moving, 'no animation anywhere under reduced motion').toBe(0);
  });
});
