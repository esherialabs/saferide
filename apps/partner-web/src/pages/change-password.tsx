import { useRouter } from 'next/router';
import { useState, type FormEvent } from 'react';

import { Layout } from '../components/Layout.tsx';
import { RequireSession } from '../components/RequireSession.tsx';
import { ErrorSummary, Notice, PageHeading, TextField, errorText, type FieldError } from '../components/ui.tsx';
import { api, sessionSync, store, useAppState } from '../lib/app.ts';
import { t } from '../lib/i18n.ts';
import { PartnerApiError, passwordProblem } from '../lib/partnerApi.ts';
import { sessionStarted } from '../lib/store.ts';

/**
 * "Choose a new password": where a person whose password SafeRide issued
 * (`partnerAdmin user:set-password`) lands after signing in. Until they
 * save their own, the API answers only /me, this change and sign-out, and
 * every other page sends them here. The answer is a new session (new cookie
 * and CSRF token); every other session of the person ends.
 */
function ChangePasswordForm() {
  const router = useRouter();
  const identity = useAppState(state => (state.auth.status === 'signed_in' ? state.auth.identity : null));
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!identity) return null;
  const forced = identity.mustChangePassword;

  const fieldError = (id: string) => errors.find(error => error.fieldId === id)?.message;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!identity) return;
    const found: FieldError[] = [];
    if (!current) found.push({ fieldId: 'current-password', message: t('password.currentRequired') });
    const problem = passwordProblem(next, identity.email);
    if (problem) found.push({ fieldId: 'new-password', message: t(`password.${problem}`) });
    else if (current && next === current) found.push({ fieldId: 'new-password', message: t('password.sameAsCurrent') });
    if (!confirm) found.push({ fieldId: 'confirm-password', message: t('password.confirmRequired') });
    else if (!problem && confirm !== next) found.push({ fieldId: 'confirm-password', message: t('password.mismatch') });
    setErrors(found);
    setFailure(null);
    if (found.length > 0) return;
    setBusy(true);
    try {
      const result = await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      store.update(state => sessionStarted(state, result, Date.now(), api.serverNow()));
      sessionSync().sessionStarted(); // the shared cookie changed: other tabs refresh or leave
      await router.replace('/cases/');
    } catch (error) {
      setBusy(false);
      setCurrent('');
      // P2's 400 messages are about the passwords, never case data.
      setFailure(error instanceof PartnerApiError && error.kind === 'bad_request' && error.serverMessage
        ? error.serverMessage
        : errorText(error));
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <PageHeading>{t('changePassword.heading')}</PageHeading>
      <ErrorSummary errors={errors} />
      {failure ? <Notice tone="error" live="assertive">{failure}</Notice> : null}
      <form className="card space-y-5" noValidate onSubmit={submit} aria-describedby="change-password-intro">
        <p id="change-password-intro" className="text-ink-2">
          {forced ? t('changePassword.intro') : t('changePassword.introVoluntary')}
        </p>
        {/* Lets password managers save the new password for the right account. */}
        <input type="email" name="username" autoComplete="username" value={identity.email} readOnly hidden />
        <TextField
          id="current-password" label={t('changePassword.current')} type="password" autoComplete="current-password"
          hint={forced ? t('changePassword.currentHint') : undefined}
          value={current} onChange={setCurrent} error={fieldError('current-password')} required
        />
        <TextField
          id="new-password" label={t('changePassword.new')} type="password" autoComplete="new-password"
          hint={t('enroll.passwordRules')} value={next} onChange={setNext} error={fieldError('new-password')} required
        />
        <TextField
          id="confirm-password" label={t('changePassword.confirm')} type="password" autoComplete="new-password"
          value={confirm} onChange={setConfirm} error={fieldError('confirm-password')} required
        />
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? t('changePassword.saving') : t('changePassword.submit')}
        </button>
      </form>
    </div>
  );
}

export default function ChangePasswordPage() {
  return (
    <Layout title={t('title.changePassword')}>
      <RequireSession allowPasswordChange>
        <ChangePasswordForm />
      </RequireSession>
    </Layout>
  );
}
