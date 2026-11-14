/* Notification display only: no fetch handler, cache, offline pages or case data. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('push', event => {
  let kind;
  try { kind = event.data?.json()?.kind; } catch { return; }
  if (kind !== 'attention' && kind !== 'test') return;
  event.waitUntil(self.registration.showNotification('SafeRide', {
    body: kind === 'test' ? 'Test notification. Your browser received this alert.' : 'A case needs attention. Open the dashboard to review.',
    icon: '/favicon.svg', tag: 'saferide-attention', renotify: true,
    data: { destination: '/cases/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const destination = new URL('/cases/', self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        // Focusing must not discard an unsaved case note or onward-referral draft.
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(destination);
  })());
});
