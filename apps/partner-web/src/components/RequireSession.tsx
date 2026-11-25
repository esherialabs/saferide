import { useRouter } from 'next/router';
import { useEffect, useState, type ReactNode } from 'react';

import { api, isEnding, store, useAppState } from '../lib/app.ts';
import { t } from '../lib/i18n.ts';
import { PartnerApiError } from '../lib/partnerApi.ts';
import { identityLoaded } from '../lib/store.ts';
import { ErrorNotice, Loading } from './ui.tsx';

/**
 * Renders its children only for a signed-in session. On a fresh page load
 * it asks the server (GET /me); without a session it goes to sign-in and
 * renders nothing of the page. While the person must replace a password
 * SafeRide issued, every page but the change-password page
 * (`allowPasswordChange`) sends them there instead.
 */
export function RequireSession({ children, allowPasswordChange = false }: { children: ReactNode; allowPasswordChange?: boolean }) {
  const auth = useAppState(state => state.auth);
  const router = useRouter();
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const needsIdentity = auth.status === 'unknown' || (auth.status === 'signed_in' && auth.identity === null);
  const mustChangePassword = auth.status === 'signed_in' && auth.identity?.mustChangePassword === true;

  useEffect(() => {
    if (mustChangePassword && !allowPasswordChange && !isEnding()) void router.replace('/change-password/');
  }, [mustChangePassword, allowPasswordChange, router]);

  useEffect(() => {
    if (auth.status === 'signed_out' || auth.status === 'pre_mfa') {
      if (!isEnding()) void router.replace('/sign-in/');
      return;
    }
    if (!needsIdentity) return;
    let cancelled = false;
    const startedUnknown = auth.status === 'unknown';
    setFailure(null);
    api.me()
      .then(me => {
        if (!cancelled) store.update(state => identityLoaded(state, me, Date.now(), api.serverNow()));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof PartnerApiError && error.kind === 'unauthorized') {
          // A signed-in session that ends is handled by the API client.
          if (startedUnknown && !isEnding()) void router.replace('/sign-in/');
          return;
        }
        setFailure(error);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.status, needsIdentity, router, attempt]);

  if (auth.status === 'signed_in' && auth.identity && (!mustChangePassword || allowPasswordChange)) return <>{children}</>;
  if (failure) {
    return (
      <ErrorNotice error={failure}>
        <button type="button" className="btn-secondary mt-3" onClick={() => setAttempt(value => value + 1)}>
          {t('case.retry')}
        </button>
      </ErrorNotice>
    );
  }
  return <Loading label={t('app.checking')} />;
}
