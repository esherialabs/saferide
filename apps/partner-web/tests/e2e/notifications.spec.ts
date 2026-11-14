import { expect, signIn, test } from './helpers.ts';

test('permission, explicit subscription, test queuing and unsubscribe are separate visible steps', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { pushConfigured: true } });
  // The CI headless shell reports native notification permission as denied
  // even with grantPermissions. Simulate a granted device for UI integration;
  // provider transport and actual OS display remain separate acceptance checks.
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
    let current: PushSubscription | null = null;
    Object.defineProperty(PushManager.prototype, 'getSubscription', { value: async () => current });
    Object.defineProperty(PushManager.prototype, 'subscribe', { value: async () => {
      const status = await (await fetch('/partner/v1/notifications')).json();
      current = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-browser',
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-browser', keys: { p256dh: status.publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' } }),
        unsubscribe: async () => { current = null; return true; },
      } as unknown as PushSubscription;
      return current;
    } });
  });
  await signIn(page);
  expect(await page.evaluate(() => Notification.permission)).toBe('granted');
  const settings = page.getByTestId('notification-settings');
  await settings.locator('summary').click();
  await expect(settings.getByRole('button', { name: 'Enable notifications' })).toBeEnabled();
  await settings.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(settings.getByRole('button', { name: 'Disable notifications' })).toBeEnabled();
  await settings.getByRole('button', { name: 'Send test notification' }).click();
  await expect(page.getByTestId('notification-feedback')).toContainText('Test queued');
  await expect(page.getByTestId('notification-feedback')).toContainText('does not prove delivery');
  await settings.getByRole('button', { name: 'Disable notifications' }).click();
  await expect(settings.getByRole('button', { name: 'Enable notifications' })).toBeEnabled();
});

test('a denied permission explains browser settings and does not offer a false enabled state', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { pushConfigured: true } });
  await page.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'denied' }));
  await signIn(page);
  const settings = page.getByTestId('notification-settings');
  await settings.locator('summary').click();
  await expect(settings).toContainText('Notifications are blocked');
  await expect(settings.getByRole('button', { name: 'Enable notifications' })).toBeDisabled();
});

test('unconfigured service stays explicit without requesting browser permission', async ({ page }) => {
  await signIn(page);
  const settings = page.getByTestId('notification-settings');
  await settings.locator('summary').click();
  await expect(settings).toContainText('not configured on this server');
  await expect(settings.getByRole('button', { name: 'Enable notifications' })).toBeDisabled();
});
