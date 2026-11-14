import {
  CASEWORKER, ISSUED, auditActions, expect, expectAccessible, expectTargetSizes, snap, test, totpAt,
} from './helpers.ts';

/** Signs in with email and password only (no code step follows when the org has MFA off). */
async function enterPassword(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/sign-in/');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test.describe('org with MFA off: password-only sign-in (migration 013)', () => {
  test.use({ mockReset: { mfaRequired: false } });

  test('the sign-in page never mentions an authenticator', async ({ page }) => {
    await page.goto('/sign-in/');
    await expect(page.getByText('Sign in with your work email and password.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/authenticator|6-digit/i);
  });

  test('an operator-issued password signs in, then must be replaced before anything else', async ({ page, request }) => {
    await enterPassword(page, ISSUED.email, ISSUED.password);
    // No TOTP step at all: straight to "Choose a new password".
    await expect(page).toHaveURL(/\/change-password\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeVisible();
    await expect(page.getByLabel('6-digit code')).toHaveCount(0);
    await expectAccessible(page, 'change password (forced)');
    await expectTargetSizes(page, 'change password (forced)');
    await snap(page, '30-change-password');

    // Every other page sends the person back here.
    await page.goto('/cases/');
    await expect(page).toHaveURL(/\/change-password\/$/);
    await expect(page.getByTestId('queue-row')).toHaveCount(0);

    // Client checks: a predictable password and a mismatch.
    await page.getByLabel('Current password').fill(ISSUED.password);
    await page.getByLabel('New password', { exact: true }).fill('Password2026!');
    await page.getByLabel('Confirm new password').fill('Password2026!');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByRole('link', { name: /too easy to guess/ })).toBeVisible();
    await expectAccessible(page, 'change password with errors');

    // The server refuses a wrong current password and keeps the session.
    await page.getByLabel('Current password').fill('not the issued password');
    await page.getByLabel('New password', { exact: true }).fill(ISSUED.newPassword);
    await page.getByLabel('Confirm new password').fill(ISSUED.newPassword);
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByText('Your current password was not accepted.')).toBeVisible();
    await expect(page).toHaveURL(/\/change-password\/$/);

    await page.getByLabel('Current password').fill(ISSUED.password);
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page).toHaveURL(/\/cases\/$/);
    await expect(page.getByTestId('signed-in-as')).toHaveText(`Signed in as ${ISSUED.displayName}, Human Rights Agenda (HURIA)`);
    await expect(page.getByTestId('queue-row').first()).toBeVisible();

    const actions = (await auditActions(request)).map(entry => `${entry.action}:${entry.outcome}`);
    expect(actions).toEqual(expect.arrayContaining([
      'auth.login:success', 'auth.password.change:denied', 'auth.password.change:success',
    ]));
    expect(actions).not.toContain('auth.totp:success');

    // The old password no longer works; the new one signs straight in.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in\//);
    await enterPassword(page, ISSUED.email, ISSUED.password);
    await expect(page.getByText('Sign-in failed. Check your email and password.')).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(ISSUED.newPassword);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/cases\/$/);
  });

  test('a user who already has an authenticator also signs in with the password alone', async ({ page }) => {
    await enterPassword(page, CASEWORKER.email, CASEWORKER.password);
    await expect(page).toHaveURL(/\/cases\/$/);
    await expect(page.getByTestId('queue-row').first()).toBeVisible();
  });
});

test.describe('org with MFA required (the default)', () => {
  test('a user without an authenticator sets one up at sign-in, then changes the issued password', async ({ page }) => {
    await enterPassword(page, ISSUED.email, ISSUED.password);
    await expect(page.getByRole('heading', { name: 'Set up your authenticator app' })).toBeFocused();
    const qr = page.getByRole('img', { name: 'QR code that adds SafeRide Partners to your authenticator app' });
    await expect(qr).toBeVisible();
    const key = (await page.getByTestId('totp-manual-key').innerText()).replace(/\s+/g, '');
    await expectAccessible(page, 'sign-in authenticator setup');
    await expectTargetSizes(page, 'sign-in authenticator setup');
    await snap(page, '31-sign-in-totp-setup');

    await page.getByLabel('6-digit code').fill(totpAt(key));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/change-password\/$/);
    await page.getByLabel('Current password').fill(ISSUED.password);
    await page.getByLabel('New password', { exact: true }).fill(ISSUED.newPassword);
    await page.getByLabel('Confirm new password').fill(ISSUED.newPassword);
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page).toHaveURL(/\/cases\/$/);

    // Next time the code step is the usual one, with the key just enrolled.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in\//);
    await enterPassword(page, ISSUED.email, ISSUED.newPassword);
    await expect(page.getByRole('heading', { name: 'Enter your authenticator code' })).toBeFocused();
    await expect(page.getByTestId('totp-manual-key')).toHaveCount(0);
    await page.getByLabel('6-digit code').fill(totpAt(key, Date.now() / 1000 + 30));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/cases\/$/);
  });
});
