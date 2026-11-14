import { useEffect, useState } from 'react';
import { api, store, useAppState } from '../lib/app.ts';
import { csrfTokenOf } from '../lib/store.ts';
import type { NotificationStatus } from '../lib/partnerApi.ts';
import { t } from '../lib/i18n.ts';

export function NotificationControl() {
  const auth = useAppState(state => state.auth);
  const session = auth.status === 'signed_in' ? auth.csrfToken : null;
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    setStatus(null);
    setSupported(window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window);
    if ('Notification' in window) setPermission(Notification.permission);
    if (!session) return;
    let cancelled = false;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const value = await api.notifications();
        if (!cancelled) {
          setStatus(value);
          if ('Notification' in window) setPermission(Notification.permission);
          setFeedback(previous => previous === t('notifications.unavailable') ? '' : previous);
        }
      }
      catch { if (!cancelled) setFeedback(t('notifications.unavailable')); }
      finally { pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [session]);
  if (auth.status !== 'signed_in' || !auth.identity || auth.identity.mustChangePassword) return null;
  const current = () => csrfTokenOf(store.get()) === session;

  async function change(enable: boolean) {
    if (!session || busy) return;
    setBusy(true); setFeedback('');
    try {
      if (enable) {
        if (!status?.configured || !status.publicKey) throw new Error('Unavailable');
        const allowed = await Notification.requestPermission();
        if (!current()) return;
        if (current()) setPermission(allowed);
        if (allowed !== 'granted') { if (current()) setFeedback(t('notifications.blocked')); return; }
        const registration = await navigator.serviceWorker.register('/notifications-sw.js', { scope: '/' });
        await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Worker unavailable')), 10_000))]);
        const key = Uint8Array.from(atob(status.publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
        // Explicit re-enrolment refreshes an endpoint the provider may have expired.
        await (await registration.pushManager.getSubscription())?.unsubscribe();
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const json = subscription.toJSON();
        if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('Subscription unavailable');
        if (!current()) return;
        await api.subscribeNotifications({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      } else {
        await api.unsubscribeNotifications();
        const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : undefined;
        await (await registration?.pushManager.getSubscription())?.unsubscribe();
        for (const notification of await registration?.getNotifications() ?? []) notification.close();
      }
      const next = await api.notifications();
      if (current()) { setStatus(next); setFeedback(t(enable ? 'notifications.enabled' : 'notifications.disabled')); }
    } catch { if (current()) setFeedback(t('notifications.error')); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    try { await api.testNotifications(); if (current()) setFeedback(t('notifications.queued')); }
    catch { if (current()) setFeedback(t('notifications.error')); }
    finally { setBusy(false); }
  }
  return (
    <details className="mx-auto max-w-content px-4 py-2 text-sm sm:px-6 lg:px-8" data-testid="notification-settings">
      <summary className="inline-flex min-h-target cursor-pointer items-center font-semibold">{t('notifications.label')}</summary>
      <p className="max-w-prose py-2 text-ink-3">{t('notifications.hint')}</p>
      <p>{!status ? t('notifications.loading') : !status.configured ? t('notifications.unconfigured') : !supported ? t('notifications.unsupported') : permission === 'denied' ? t('notifications.blocked') : t(status.enabled ? 'notifications.enabled' : 'notifications.disabled')}</p>
      <div className="flex flex-wrap gap-3 py-2">
        <button className="btn-secondary" type="button" disabled={busy || (!status?.enabled && (!supported || !status?.configured || permission === 'denied'))} onClick={() => void change(!status?.enabled)}>
          {busy ? t('notifications.working') : t(status?.enabled ? 'notifications.disable' : 'notifications.enable')}
        </button>
        {status?.enabled ? <button className="btn-secondary" type="button" disabled={busy} onClick={() => void test()}>{t('notifications.test')}</button> : null}
      </div>
      {status?.lastAcceptedAt ? <p>{t('notifications.accepted', { at: new Date(status.lastAcceptedAt).toLocaleString() })}</p> : null}
      {status?.lastOutcome === 'retry' || status?.lastOutcome === 'refused' ? <p>{t('notifications.deliveryFailure')}</p> : null}
      <p role="status" aria-atomic="true" data-testid="notification-feedback">{feedback}</p>
    </details>
  );
}
