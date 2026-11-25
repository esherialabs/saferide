import { useRouter } from 'next/router';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Layout } from '../components/Layout.tsx';
import { AuthCardHeader } from '../components/brand/AuthCardHeader.tsx';
import { QrCode } from '../components/QrCode.tsx';
import {
  ErrorSummary, FocusHeading, Loading, Notice, TextField, errorText, type FieldError,
} from '../components/ui.tsx';
import { api, replaceUrl, sessionSync, store } from '../lib/app.ts';
import { t } from '../lib/i18n.ts';
import {
  PartnerApiError, isEnrollmentToken, passwordProblem, type EnrollStartResponse,
} from '../lib/partnerApi.ts';
import { groupKey } from '../lib/qr.ts';
import { sessionStarted } from '../lib/store.ts';

type Stage =
  | { kind: 'checking' }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'password' }
  | { kind: 'totp' };

/** The token arrives in the link's #fragment (never sent to a server by the browser). */
function takeTokenFromFragment(): string | null {
  const fragment = window.location.hash.replace(/^#/, '');
  const token = new URLSearchParams(fragment).get('token');
  if (window.location.hash) replaceUrl('/enroll/');
  return token;
}

export default function EnrollPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [invite, setInvite] = useState<EnrollStartResponse | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const token = useRef<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // enroll/start issues a new authenticator key each call, so call it once.
    if (started.current) return;
    started.current = true;
    const found = takeTokenFromFragment();
    if (!found) {
      setStage({ kind: 'missing' });
      return;
    }
    if (!isEnrollmentToken(found)) {
      setStage({ kind: 'invalid' });
      return;
    }
    token.current = found;
    api.enrollStart(found)
      .then(result => {
        setInvite(result);
        setStage({ kind: 'password' });
      })
      .catch((error: unknown) => {
        if (error instanceof PartnerApiError && error.kind === 'not_found') setStage({ kind: 'invalid' });
        else setStage({ kind: 'failed', error });
      });
  }, []);

  const fieldError = (id: string) => errors.find(error => error.fieldId === id)?.message;

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!invite) return;
    const found: FieldError[] = [];
    const problem = passwordProblem(password, invite.user.email);
    if (problem) found.push({ fieldId: 'new-password', message: t(`password.${problem}`) });
    if (!confirm) found.push({ fieldId: 'confirm-password', message: t('password.confirmRequired') });
    else if (!problem && confirm !== password) found.push({ fieldId: 'confirm-password', message: t('password.mismatch') });
    setErrors(found);
    setFailure(null);
    if (found.length === 0) setStage({ kind: 'totp' });
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    const digits = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setErrors([{ fieldId: 'enroll-code', message: t('signIn.codeFormat') }]);
      setFailure(null);
      return;
    }
    if (!token.current) return;
    setErrors([]);
    setFailure(null);
    setBusy(true);
    try {
      const result = await api.enrollComplete(token.current, password, digits);
      token.current = null;
      setPassword('');
      setConfirm('');
      setInvite(null);
      store.update(state => sessionStarted(state, result, Date.now(), api.serverNow()));
      sessionSync().sessionStarted(); // the shared cookie changed: other tabs refresh or leave
      await router.replace('/cases/');
    } catch (error) {
      setBusy(false);
      setCode('');
      if (error instanceof PartnerApiError && error.kind === 'not_found') {
        setStage({ kind: 'invalid' });
      } else if (error instanceof PartnerApiError && error.kind === 'conflict') {
        setFailure(t('enroll.startFirst'));
      } else if (error instanceof PartnerApiError && error.kind === 'bad_request' && error.serverMessage) {
        // P2's 400 messages are about the password or the code, never case data.
        setFailure(error.serverMessage);
      } else {
        setFailure(errorText(error));
      }
    }
  }

  return (
    <Layout title={t('title.enroll')} variant="auth">
      <div className="mx-auto max-w-[36rem] sm:pt-6">
        <div className="space-y-6">
          <div className="card p-6 sm:p-10">
            <AuthCardHeader heading={t('enroll.heading')} />
          </div>
          {stage.kind === 'checking' ? <Loading label={t('enroll.checking')} /> : null}
          {stage.kind === 'missing' ? <Notice tone="warning" live="polite">{t('enroll.missing')}</Notice> : null}
          {stage.kind === 'invalid' ? <Notice tone="error" live="assertive">{t('enroll.invalid')}</Notice> : null}
          {stage.kind === 'failed' ? <Notice tone="error" live="assertive">{errorText(stage.error)}</Notice> : null}

          {invite && (stage.kind === 'password' || stage.kind === 'totp') ? (
            <>
              <p className="text-ink-2">
                {t('enroll.welcome', { name: invite.user.displayName, role: t(`role.${invite.role}`), org: invite.org.displayName })}
              </p>
              <ErrorSummary errors={errors} />
              {failure ? <Notice tone="error" live="assertive">{failure}</Notice> : null}
            </>
          ) : null}

          {invite && stage.kind === 'password' ? (
            <form className="card space-y-5" noValidate onSubmit={submitPassword}>
              <p className="eyebrow">{t('enroll.step', { n: 1 })}</p>
              <FocusHeading>{t('enroll.passwordHeading')}</FocusHeading>
              {/* Lets password managers save the right account name. */}
              <input type="email" name="username" autoComplete="username" value={invite.user.email} readOnly hidden />
              <TextField
                id="new-password" label={t('enroll.newPassword')} type="password" autoComplete="new-password"
                hint={t('enroll.passwordRules')} value={password} onChange={setPassword} error={fieldError('new-password')} required
              />
              <TextField
                id="confirm-password" label={t('enroll.confirmPassword')} type="password" autoComplete="new-password"
                value={confirm} onChange={setConfirm} error={fieldError('confirm-password')} required
              />
              <button type="submit" className="btn-primary">{t('enroll.continue')}</button>
            </form>
          ) : null}

          {invite && stage.kind === 'totp' ? (
            <form className="card space-y-5" noValidate onSubmit={submitCode}>
              <p className="eyebrow">{t('enroll.step', { n: 2 })}</p>
              <FocusHeading>{t('enroll.totpHeading')}</FocusHeading>
              <p className="text-ink-2">{t('enroll.totpIntro')}</p>
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <QrCode text={invite.totp.keyUri} label={t('enroll.qrLabel')} />
                <div className="min-w-0 space-y-2">
                  <h3>{t('enroll.manualKey')}</h3>
                  <p className="break-all font-mono text-lg tracking-wide text-ink" data-testid="totp-manual-key">
                    {groupKey(invite.totp.secret)}
                  </p>
                  <p className="text-sm text-ink-3">
                    {t('enroll.manualDetails', {
                      account: invite.user.email, digits: invite.totp.digits, period: invite.totp.periodSeconds,
                    })}
                  </p>
                  <p className="text-sm text-ink-3">{t('enroll.keyPrivate')}</p>
                </div>
              </div>
              <TextField
                id="enroll-code" label={t('enroll.code')} autoComplete="one-time-code" inputMode="numeric" maxLength={7}
                value={code} onChange={setCode} error={fieldError('enroll-code')} required spellCheck={false}
              />
              <div className="flex flex-wrap gap-3">
                <button type="submit" className="btn-primary" disabled={busy}>{t('enroll.finish')}</button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    setErrors([]);
                    setFailure(null);
                    setStage({ kind: 'password' });
                  }}
                >
                  {t('enroll.back')}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}
