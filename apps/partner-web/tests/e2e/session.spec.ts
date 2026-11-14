import {
  CASEWORKER, auditActions, expect, expectAccessible, expectNoCaseContent, openCase, signIn, snap, test,
} from './helpers.ts';

test.describe('session expiry', () => {
  /** Records every request that could extend the session: writes and GETs with the activity flag. */
  function recordInteractive(page: import('@playwright/test').Page) {
    const seen: Array<{ request: string; at: number }> = [];
    page.on('request', item => {
      const url = new URL(item.url());
      if (!url.pathname.startsWith('/partner/v1/') || url.pathname === '/partner/v1/auth/logout') return;
      if (item.headers()['x-saferide-partner-activity'] === 'interactive' || item.method() !== 'GET') {
        seen.push({ request: `${item.method()} ${url.pathname}`, at: Number(item.headers()['x-mock-client-time']) });
      }
    });
    return seen;
  }

  async function oneInputAt(page: import('@playwright/test').Page, minute: string) {
    await page.clock.fastForward(minute); // no input until then
    await page.getByRole('heading', { level: 1, name: 'Cases' }).click(); // the one real input
    return page.evaluate(() => Date.now());
  }

  async function idleFor(page: import('@playwright/test').Page, minutes: number) {
    for (let minute = 1; minute <= minutes; minute += 1) await page.clock.fastForward('01:00');
  }

  test('reported repro: last input at 5 min, then nothing; one keep-alive at that input, nothing after, signed out at 35 min', async ({ page, request }) => {
    await page.clock.install();
    await signIn(page);
    const interactive = recordInteractive(page);
    const inputAt = await oneInputAt(page, '05:00');
    await expect.poll(() => interactive.length).toBe(1);
    expect(interactive[0]?.request).toBe('GET /partner/v1/me');
    expect(Math.abs((interactive[0]?.at ?? 0) - inputAt), 'sent at the input itself').toBeLessThan(2000);

    await idleFor(page, 29);
    await expect(page).toHaveURL(/\/cases\/$/); // 34 min: still signed in, warned
    await expect(page.getByTestId('session-warning')).toBeVisible();
    await page.clock.fastForward('01:05');
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(page.getByText('You were signed out after 30 minutes without activity.')).toBeVisible();
    expect(interactive, 'nothing extended the session after the last real input').toHaveLength(1);
    const listed = (await auditActions(request)).filter(entry => entry.action === 'partner.referral.list');
    expect(listed.some(entry => entry.background === true), 'the queue kept polling in the background').toBe(true);
  });

  test('one input right after the last request, then nothing: no interactive call, warned at 28 and signed out at 30 min', async ({ page }) => {
    await page.clock.install();
    await signIn(page);
    const interactive = recordInteractive(page);
    await oneInputAt(page, '01:00');

    await idleFor(page, 27); // 28 min after the last request
    await expect(page).toHaveURL(/\/cases\/$/);
    await expect(page.getByTestId('session-warning')).toBeVisible();
    await page.clock.fastForward('02:05');
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(page.getByText('You were signed out after 30 minutes without activity.')).toBeVisible();
    expect(interactive, 'no interactive call after the input').toEqual([]);
  });

  test('a keep-alive that never answers times out and cannot hold the case on screen past the idle limit', async ({ page, request }) => {
    await page.clock.install();
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    await expect(page.getByText('SYNTHETIC. Waiting for the survivor to call')).toBeVisible();
    await page.clock.fastForward('05:00');
    await request.post('/__mock/hang', { data: { route: '/me', count: 1 } });
    const abandoned = page.waitForEvent('requestfailed', item => new URL(item.url()).pathname === '/partner/v1/me');
    await page.getByRole('heading', { level: 1, name: 'Case SR-4T8N-2XHB' }).click(); // input: a keep-alive that hangs
    await idleFor(page, 24);
    await abandoned; // given up after the 15 s request timeout
    await expect(page).toHaveURL(/\/case\/\?id=/); // 29 min after the last request

    await page.clock.fastForward('01:05');
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(page.getByText('You were signed out after 30 minutes without activity.')).toBeVisible();
    await expectNoCaseContent(page);
  });

  test('idle: warns at 28 minutes, then signs out to sign-in without case data', async ({ page, request }) => {
    await page.clock.install();
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    await page.clock.fastForward('28:10');
    const warning = page.getByTestId('session-warning');
    await expect(warning).toBeVisible();
    await expect(warning.getByRole('heading', { name: 'Are you still there?' })).toBeVisible();
    await expect(warning.getByRole('button', { name: 'Stay signed in' })).toBeFocused();
    await expectAccessible(page, 'idle warning dialog');
    await snap(page, '15-idle-warning');

    await page.clock.fastForward('02:00');
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(page.getByText('You were signed out after 30 minutes without activity.')).toBeVisible();
    await expectNoCaseContent(page);
    await expect(page).toHaveTitle('Sign in · SafeRide × HURIA');
    expect((await auditActions(request)).some(entry => entry.action === 'auth.logout')).toBe(true);
    await snap(page, '16-signed-out-idle');
  });

  test('idle: "Stay signed in" keeps the session and refreshes it on the server', async ({ page, request }) => {
    await page.clock.install();
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    const interactiveMe = async () => (await auditActions(request)).filter(entry => entry.action === 'partner.me.read' && !entry.background).length;
    const before = await interactiveMe();
    await page.clock.fastForward('28:30');
    await page.getByTestId('session-warning').getByRole('button', { name: 'Stay signed in' }).click();
    await expect(page.getByTestId('session-warning')).toBeHidden();
    await page.clock.fastForward('05:00');
    await expect(page.getByRole('heading', { level: 1, name: 'Case SR-4T8N-2XHB' })).toBeVisible();
    expect(await interactiveMe(), 'one interactive /me: the "Stay signed in" click').toBe(before + 1);
  });

  test.describe('absolute limit', () => {
    test.use({ mockReset: { absoluteSeconds: 10 * 60 } });

    test('warns 5 minutes before the absolute limit and then signs out even while active', async ({ page, request }) => {
      await page.clock.install();
      await signIn(page);
      await page.clock.fastForward('05:10');
      const warning = page.getByTestId('session-warning');
      await expect(warning.getByRole('heading', { name: 'Your session is ending' })).toBeVisible();
      await warning.getByRole('button', { name: 'Continue' }).click();
      await expect(warning).toBeHidden();
      await page.getByRole('button', { name: 'Refresh' }).click();
      await page.clock.fastForward('05:00');
      await expect(page).toHaveURL(/\/sign-in\/$/);
      await expect(page.getByText('You were signed out because sessions end after 12 hours.')).toBeVisible();
      await expectNoCaseContent(page);
    });
  });

  test('a session ended on the server sends the next action to sign-in and drops the case', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    await request.post('/__mock/expire-sessions');
    await page.getByRole('region', { name: 'Internal notes' }).getByLabel('New note').fill('SYNTHETIC. Draft note.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page).toHaveURL(/\/sign-in\/$/);
    await expect(page.getByText('Your session has ended. Sign in again to continue.')).toBeVisible();
    await expectNoCaseContent(page);
  });

  test('the pre-MFA step ends after 5 minutes', async ({ page }) => {
    await page.clock.install();
    await page.goto('/sign-in/');
    await page.getByLabel('Work email').fill(CASEWORKER.email);
    await page.getByLabel('Password', { exact: true }).fill(CASEWORKER.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('6-digit code')).toBeVisible();
    await page.clock.fastForward('05:01');
    await expect(page.getByText('That took longer than 5 minutes. Enter your email and password again.')).toBeVisible();
    await expect(page.getByLabel('Work email')).toBeVisible();
  });
});
