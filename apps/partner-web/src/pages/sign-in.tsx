import { useRouter } from 'next/router';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Layout } from '../components/Layout.tsx';
import { QrCode } from '../components/QrCode.tsx';
import {
  ErrorSummary, FocusHeading, Loading, Notice, TextField, errorText, type FieldError,
} from '../components/ui.tsx';
import { AuthCardHeader, AuthTrustNotes } from '../components/brand/AuthCardHeader.tsx';
import { InfoIcon, KeyIcon, SpinnerIcon } from '../components/icons.tsx';
import { api, sessionSync, store, useAppState } from '../lib/app.ts';
import { t } from '../lib/i18n.ts';
import { PartnerApiError, type AuthStepResponse, type TotpKey } from '../lib/partnerApi.ts';
import { groupKey } from '../lib/qr.ts';
import { sessionPhase } from '../lib/session.ts';
import { initialState, passwordAccepted, sessionStarted, type SignOutReason } from '../lib/store.ts';

const SIGN_OUT_REASONS: readonly SignOutReason[] = ['user', 'idle', 'absolute', 'expired'];

function failureText(error: unknown, unauthorizedText: string): string {
  return error instanceof PartnerApiError && error.kind === 'unauthorized' ? unauthorizedText : errorText(error);
}

export default function SignInPage() {
  const router = useRouter();
  const auth = useAppState(state => state.auth);
  // totp: enter a code. totp_setup: the org requires MFA and this person has
  // no authenticator yet, so they add one first. With MFA off for the org,
  // a correct password signs straight in and neither step is shown.
  const [step, setStep] = useState<'credentials' | 'totp' | 'totp_setup'>('credentials');
  const [setupKey, setSetupKey] = useState<TotpKey | null>(null);
  const [setupAccount, setSetupAccount] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A sign-out reason arrives as a fixed code in the URL; show it, then drop
  // it through the router (Next re-applies the query after hydration).
  const urlHandled = useRef(false);
  useEffect(() => {
    if (!router.isReady || urlHandled.current) return;
    urlHandled.current = true;
    const reason = router.query.signedOut;
    if (typeof reason === 'string' && (SIGN_OUT_REASONS as readonly string[]).includes(reason)) {
      setNotice(t(`signedOut.${reason as SignOutReason}`));
    }
    if (Object.keys(router.query).length > 0 || window.location.hash) {
      void router.replace('/sign-in/', undefined, { shallow: true, scroll: false });
    }
  }, [router, router.isReady]);

  // The password-only session lasts 5 minutes.
  useEffect(() => {
    if (step === 'credentials' || auth.status !== 'pre_mfa') return;
    const { clock } = auth;
    const timer = window.setInterval(() => {
      if (sessionPhase(clock, Date.now()).phase !== 'expired') return;
      store.update(() => initialState({ status: 'signed_out' }));
      setStep('credentials');
      setCode('');
      setSetupKey(null);
      setErrors([]);
      setFailure(t('signIn.preMfaExpired'));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step, auth]);

  async function submitCredentials(event: FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    if (!email.trim()) found.push({ fieldId: 'email', message: t('signIn.emailRequired') });
    if (!password) found.push({ fieldId: 'password', message: t('signIn.passwordRequired') });
    setErrors(found);
    setFailure(null);
    if (found.length > 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.login(email.trim(), password);
      setPassword('');
      if (!result.mfaRequired) {
        await finishSignIn(result);
        return;
      }
      store.update(state => passwordAccepted(state, result, Date.now(), api.serverNow()));
      if (result.totpSetupRequired) {
        setStep('totp_setup');
        setSetupAccount(email.trim().toLowerCase());
        try {
          setSetupKey((await api.totpSetup()).totp);
        } catch (error) {
          setFailure(failureText(error, t('signIn.setupFailed')));
        }
      } else {
        setStep('totp');
      }
    } catch (error) {
      setFailure(failureText(error, t('signIn.failed')));
    } finally {
      setBusy(false);
    }
  }

  /** A full session: the person goes on to their cases, or first to "Choose a new password". */
  async function finishSignIn(result: AuthStepResponse) {
    store.update(state => sessionStarted(state, result, Date.now(), api.serverNow()));
    sessionSync().sessionStarted(); // the shared cookie changed: other tabs refresh or leave
    await router.replace(result.mustChangePassword ? '/change-password/' : '/cases/');
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    const digits = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setErrors([{ fieldId: 'code', message: t('signIn.codeFormat') }]);
      setFailure(null);
      return;
    }
    setErrors([]);
    setFailure(null);
    setBusy(true);
    try {
      const result = await api.verifyTotp(digits);
      setSetupKey(null);
      await finishSignIn(result);
    } catch (error) {
      setCode('');
      setFailure(failureText(error, t('signIn.codeFailed')));
      setBusy(false);
    }
  }

  function startAgain() {
    store.update(() => initialState({ status: 'signed_out' }));
    setStep('credentials');
    setCode('');
    setSetupKey(null);
    setErrors([]);
    setFailure(null);
  }

  const fieldError = (id: string) => errors.find(error => error.fieldId === id)?.message;

  return (
    <Layout title={t('title.signIn')} variant="auth">
      <div className="mx-auto max-w-[30rem] space-y-6 sm:pt-6">
        <div className="space-y-6">
          <div className="card space-y-6 p-6 sm:p-10">
            <AuthCardHeader heading={t('signIn.heading')} />
            {notice ? <Notice tone="info" live="polite">{notice}</Notice> : null}
            <ErrorSummary errors={errors} />
            {failure ? <Notice tone="error" live="assertive">{failure}</Notice> : null}

            {step === 'credentials' ? (
              <form className="space-y-5" noValidate onSubmit={submitCredentials} aria-describedby="sign-in-intro">
                <p id="sign-in-intro" className="text-ink-2">{t('signIn.intro')}</p>
                <TextField
                  id="email" label={t('signIn.email')} type="email" autoComplete="username" inputMode="email"
                  value={email} onChange={setEmail} error={fieldError('email')} required spellCheck={false}
                />
                <TextField
                  id="password" label={t('signIn.password')} type="password" autoComplete="current-password"
                  value={password} onChange={setPassword} error={fieldError('password')} required
                />
                <button type="submit" className="btn-primary w-full" disabled={busy}>
                  {busy ? <SpinnerIcon /> : null}
                  {t('signIn.continue')}
                </button>
              </form>
            ) : step === 'totp_setup' && !setupKey ? (
              failure ? (
                <button type="button" className="btn-secondary" onClick={startAgain}>{t('signIn.startAgain')}</button>
              ) : <Loading label={t('signIn.setupLoading')} />
            ) : (
              <form className="space-y-5" noValidate onSubmit={submitCode}>
                {step === 'totp_setup' && setupKey ? (
                  <>
                    <div className="flex items-center gap-3">
                      <span className="card-icon"><KeyIcon /></span>
                      <FocusHeading>{t('signIn.setupHeading')}</FocusHeading>
                    </div>
                    <p className="text-ink-2">{t('signIn.setupIntro')}</p>
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                      <QrCode text={setupKey.keyUri} label={t('enroll.qrLabel')} />
                      <div className="min-w-0 space-y-2">
                        <h3>{t('enroll.manualKey')}</h3>
                        <p className="break-all font-mono text-lg tracking-wide text-ink" data-testid="totp-manual-key">
                          {groupKey(setupKey.secret)}
                        </p>
                        <p className="text-sm text-ink-3">
                          {t('enroll.manualDetails', { account: setupAccount, digits: setupKey.digits, period: setupKey.periodSeconds })}
                        </p>
                        <p className="text-sm text-ink-3">{t('enroll.keyPrivate')}</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <span className="card-icon"><KeyIcon /></span>
                      <FocusHeading>{t('signIn.totpHeading')}</FocusHeading>
                    </div>
                    <p className="text-ink-2">{t('signIn.totpIntro')}</p>
                  </>
                )}
                <TextField
                  id="code" label={t('signIn.code')} hint={t('signIn.codeHint')} autoComplete="one-time-code"
                  inputMode="numeric" maxLength={7} value={code} onChange={setCode} error={fieldError('code')} required
                  spellCheck={false}
                />
                <div className="flex flex-wrap gap-3">
                  <button type="submit" className="btn-primary flex-1" disabled={busy}>
                    {busy ? <SpinnerIcon /> : null}
                    {t('signIn.submit')}
                  </button>
                  <button type="button" className="btn-secondary" onClick={startAgain} disabled={busy}>{t('signIn.startAgain')}</button>
                </div>
              </form>
            )}
            <AuthTrustNotes />
          </div>

          <p className="flex gap-2 px-1 text-sm text-ink-3">
            <InfoIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('signIn.help')}</span>
          </p>
        </div>
      </div>
    </Layout>
  );
}
