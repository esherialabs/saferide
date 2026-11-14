import {
  CASEWORKER, INVITEE, REFERRAL_IDS, auditActions, expect, expectAccessible, expectNoCaseContent, expectTargetSizes, openCase, signIn, snap, test,
  totpAt,
} from './helpers.ts';

test.describe('sign-in and TOTP', () => {
  test('signs in with password then TOTP and shows the queue', async ({ page, request }) => {
    await page.goto('/sign-in/');
    await expect(page).toHaveTitle('Sign in · SafeRide × HURIA');
    await expect(page.getByText('SafeRide × HURIA').first()).toBeVisible();
    await expectAccessible(page, 'sign-in');
    await expectTargetSizes(page, 'sign-in');
    await snap(page, '01-sign-in');

    await page.getByLabel('Work email').fill(CASEWORKER.email);
    await page.getByLabel('Password', { exact: true }).fill(CASEWORKER.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Enter your authenticator code' })).toBeFocused();
    await expectAccessible(page, 'sign-in TOTP step');
    await snap(page, '02-sign-in-totp');

    await page.getByLabel('6-digit code').fill(totpAt(CASEWORKER.totpKey));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/cases\/$/);
    await expect(page.getByTestId('signed-in-as')).toHaveText(`Signed in as ${CASEWORKER.displayName}, Human Rights Agenda (HURIA)`);
    const actions = (await auditActions(request)).map(entry => `${entry.action}:${entry.outcome}`);
    expect(actions).toEqual(expect.arrayContaining(['auth.login:success', 'auth.totp:success', 'partner.me.read:success']));
  });

  test('a wrong password fails without saying which detail was wrong', async ({ page }) => {
    await page.goto('/sign-in/');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'There is a problem' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Enter your work email.' })).toBeVisible();
    await expectAccessible(page, 'sign-in with errors');

    await page.getByLabel('Work email').fill(CASEWORKER.email);
    await page.getByLabel('Password', { exact: true }).fill('test-wrong-passphrase');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Sign-in failed. Check your email and password.')).toBeVisible();
    await expect(page.getByLabel('6-digit code')).toHaveCount(0);
  });

  test('a wrong TOTP code is refused and the newest code is accepted', async ({ page }) => {
    await page.goto('/sign-in/');
    await page.getByLabel('Work email').fill(CASEWORKER.email);
    await page.getByLabel('Password', { exact: true }).fill(CASEWORKER.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('6-digit code').fill('12345');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Enter the 6 digits from your authenticator app.' })).toBeVisible();
    const wrong = totpAt(CASEWORKER.totpKey) === '000000' ? '111111' : '000000';
    await page.getByLabel('6-digit code').fill(wrong);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('That code did not work.')).toBeVisible();
    await page.getByLabel('6-digit code').fill(totpAt(CASEWORKER.totpKey));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/cases\/$/);
  });

  test('"Start again" returns to the password step', async ({ page }) => {
    await page.goto('/sign-in/');
    await page.getByLabel('Work email').fill(CASEWORKER.email);
    await page.getByLabel('Password', { exact: true }).fill(CASEWORKER.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Start again' }).click();
    await expect(page.getByLabel('Work email')).toBeVisible();
  });

  test('can be completed with the keyboard only', async ({ page }) => {
    await page.goto('/sign-in/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Work email')).toBeFocused();
    await page.keyboard.type(CASEWORKER.email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(CASEWORKER.password);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Enter your authenticator code' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('6-digit code')).toBeFocused();
    await page.keyboard.type(totpAt(CASEWORKER.totpKey));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/cases\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeFocused();
  });

  test('protected pages send a visitor without a session to sign-in', async ({ page }) => {
    await page.goto(`/case/?id=${REFERRAL_IDS['SR-7K3Q-9M2D']}`);
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expectNoCaseContent(page);
    await page.goto('/cases/');
    await expect(page).toHaveURL(/\/sign-in\/$/);
  });
});

test.describe('sign-out', () => {
  test('revokes the session, leaves no case data, and Back does not bring it back', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    await expect(page.getByText('SYNTHETIC TEST CASE.').first()).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(page.getByText('You have signed out.')).toBeVisible();
    await expectNoCaseContent(page);
    expect((await auditActions(request)).some(entry => entry.action === 'auth.logout' && entry.outcome === 'success')).toBe(true);

    await page.goBack();
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expectNoCaseContent(page);
  });
});

test.describe('enrolment', () => {
  test('sets a password, shows a local SVG QR code and manual key, and finishes with TOTP', async ({ page, request }) => {
    const external: string[] = [];
    page.on('request', item => {
      if (!item.url().startsWith('http://localhost:')) external.push(item.url());
    });
    await page.goto(`/enroll#token=${INVITEE.enrollmentToken}`);
    await expect(page).toHaveURL(/\/enroll\/$/); // the one-time token leaves the address bar
    await expect(page.getByText(`Welcome, ${INVITEE.displayName}.`)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
    await expectAccessible(page, 'enrolment password step');
    await expectTargetSizes(page, 'enrolment password step');
    await snap(page, '03-enrol-password');

    await page.getByLabel('New password').fill('short');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('link', { name: 'Use at least 12 characters.' })).toBeVisible();
    await page.getByLabel('New password').fill('calm river at dawn 2026');
    await page.getByLabel('Confirm password').fill('calm river at dusk 2026');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('link', { name: 'The passwords do not match.' })).toBeVisible();
    await page.getByLabel('Confirm password').fill('calm river at dawn 2026');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Set up your authenticator app' })).toBeFocused();
    const qr = page.getByRole('img', { name: 'QR code that adds SafeRide Partners to your authenticator app' });
    await expect(qr).toBeVisible();
    expect(await qr.evaluate(element => element.tagName.toLowerCase())).toBe('svg');
    const key = (await page.getByTestId('totp-manual-key').innerText()).replace(/\s+/g, '');
    expect(key).toMatch(/^[A-Z2-7]{32}$/);
    await expectAccessible(page, 'enrolment TOTP step');
    await expectTargetSizes(page, 'enrolment TOTP step');
    await snap(page, '04-enrol-totp');

    await page.getByLabel('Enter the 6-digit code your app now shows').fill(totpAt(key));
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page).toHaveURL(/\/cases\/$/);
    await expect(page.getByTestId('signed-in-as')).toContainText(INVITEE.displayName);
    expect(external, 'no third-party requests (QR drawn locally)').toEqual([]);
    const actions = (await auditActions(request)).map(entry => `${entry.action}:${entry.outcome}`);
    expect(actions.filter(action => action === 'auth.enroll.start:success')).toHaveLength(1);
    expect(actions).toContain('auth.enroll.complete:success');
  });

  test('an invalid or missing link gives a clear message', async ({ page }) => {
    await page.goto(`/enroll#token=srpe_${'x'.repeat(43)}`);
    await expect(page.getByText('This enrolment link is invalid or has expired. Ask SafeRide for a new one.')).toBeVisible();
    await expectAccessible(page, 'enrolment invalid link');
    await page.goto('/enroll/');
    await expect(page.getByText('Open this page from the enrolment link SafeRide sent you.')).toBeVisible();
  });
});
