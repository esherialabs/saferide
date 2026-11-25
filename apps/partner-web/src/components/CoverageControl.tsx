import { useEffect, useRef, useState } from 'react';
import { api, store, useAppState } from '../lib/app.ts';
import { coverageWindowLoaded, csrfTokenOf } from '../lib/store.ts';
import { t } from '../lib/i18n.ts';

/** Explicit operator choice; no browser storage and no implicit opt-in from polling. */
export function CoverageControl() {
  const auth = useAppState(state => state.auth);
  const active = auth.status === 'signed_in' && auth.clock.coverageActive === true;
  const session = auth.status === 'signed_in' ? auth.csrfToken : null;
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<'checking' | 'connected' | 'unavailable'>('checking');
  const [error, setError] = useState(false);
  const lastSuccess = useRef(0);

  useEffect(() => {
    if (!active || !session) return;
    let cancelled = false;
    let pending = false;
    setConnection('checking');
    async function renew() {
      if (pending) return;
      pending = true;
      try {
        const response = await api.coverageHeartbeat();
        if (!cancelled) {
          store.update(state => coverageWindowLoaded(state, response.session, session!, Date.now(), api.serverNow()));
          lastSuccess.current = Date.now();
          setConnection('connected');
        }
      } catch {
        if (!cancelled) setConnection('unavailable');
      } finally { pending = false; }
    }
    function check() {
      if (Date.now() - lastSuccess.current > 90_000) setConnection('unavailable');
      void renew();
    }
    void renew();
    const timer = window.setInterval(check, 60_000);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [active, session]);

  if (auth.status !== 'signed_in' || !auth.identity || auth.identity.mustChangePassword) return null;
  async function toggle() {
    if (!session || busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await api.coverage(!active);
      store.update(state => coverageWindowLoaded(state, response.session, session, Date.now(), api.serverNow()));
    } catch { if (csrfTokenOf(store.get()) === session) setError(true); }
    finally { setBusy(false); }
  }
  return (
    <section className="border-b border-line bg-surface" aria-label={t('coverage.label')}>
      <div className="mx-auto flex max-w-content flex-wrap items-center gap-3 px-4 py-2 sm:px-6 lg:px-8">
        <button type="button" className="btn-secondary" aria-pressed={active} disabled={busy} onClick={() => void toggle()} data-testid="coverage-toggle">
          {busy ? t('coverage.changing') : active ? t('coverage.stop') : t('coverage.start')}
        </button>
        <p className="text-sm text-ink-3">{t(active ? 'coverage.activeHint' : 'coverage.hint')}</p>
        <p role="status" aria-atomic="true" className="text-sm" data-testid="coverage-status">
          {error ? t('coverage.error') : active ? t(`coverage.${connection}`) : t('coverage.off')}
        </p>
      </div>
    </section>
  );
}
