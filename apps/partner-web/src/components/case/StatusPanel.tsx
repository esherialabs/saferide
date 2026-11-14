import { useState, type FormEvent } from 'react';

import { api, store } from '../../lib/app.ts';
import { t } from '../../lib/i18n.ts';
import {
  CLOSURE_REASONS, PartnerApiError, isClosureReasonCode, nextStatuses, type ClosureReason, type PartnerStatus, type Referral,
} from '../../lib/partnerApi.ts';
import { activityRecorded } from '../../lib/store.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { FlagIcon } from '../icons.tsx';
import { CardHeading, ErrorNotice, ErrorSummary, Notice, StatusBadge, type FieldError } from '../ui.tsx';

type Target = Exclude<PartnerStatus, 'new'>;

/** A stored closure reason: one of the dashboard's codes, or text kept as it is. */
function closureReasonText(reason: string): string {
  return isClosureReasonCode(reason) ? t(`closure.${reason}`) : reason;
}

export function StatusPanel({ referral, onChanged, onReload, onWithdrawn }: {
  referral: Referral;
  onChanged: (referral: Referral) => void;
  onReload: () => void;
  onWithdrawn: () => void;
}) {
  const options = nextStatuses(referral).filter((status): status is Target => status !== 'new');
  const [target, setTarget] = useState<Target | ''>('');
  const [reason, setReason] = useState<ClosureReason | ''>('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'done'; status: PartnerStatus } | { kind: 'conflict' } | { kind: 'error'; error: unknown } | null>(null);

  function review(event: FormEvent) {
    event.preventDefault();
    const found: FieldError[] = [];
    if (!target) found.push({ fieldId: `status-${options[0] ?? 'closed'}`, message: t('statusPanel.pickTarget') });
    if (target === 'closed' && !reason) found.push({ fieldId: 'closure-reason', message: t('statusPanel.pickReason') });
    setErrors(found);
    setResult(null);
    if (found.length === 0) setConfirming(true);
  }

  async function apply() {
    if (!target) return;
    setBusy(true);
    store.update(state => activityRecorded(state, Date.now()));
    try {
      const response = await api.changeStatus(referral.id, {
        to: target,
        expectedStatus: referral.status,
        closureReason: target === 'closed' && reason ? reason : undefined,
      });
      setConfirming(false);
      setTarget('');
      setReason('');
      setResult({ kind: 'done', status: response.referral.status });
      onChanged(response.referral);
    } catch (error) {
      setConfirming(false);
      if (error instanceof PartnerApiError && error.kind === 'gone') onWithdrawn();
      else setResult(error instanceof PartnerApiError && error.kind === 'conflict' ? { kind: 'conflict' } : { kind: 'error', error });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="status-heading" className="card space-y-4">
      <CardHeading id="status-heading" icon={<FlagIcon />}>{t('statusPanel.heading')}</CardHeading>
      <div className="space-y-2 rounded-xl bg-surface-2 p-3">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{t('statusPanel.current')}:</span>
          <StatusBadge status={referral.status} />
        </p>
        <p className="text-sm text-ink-2">{t('statusPanel.survivorSees', { text: t(`survivorSees.${referral.status}`) })}</p>
      </div>

      {result?.kind === 'done' ? (
        <Notice tone="success" live="polite">{t('statusPanel.updated', { status: t(`status.${result.status}`) })}</Notice>
      ) : null}
      {result?.kind === 'conflict' ? (
        <Notice tone="warning" live="assertive">
          <p>{t('statusPanel.conflict')}</p>
          <button type="button" className="btn-secondary mt-3" onClick={onReload}>{t('statusPanel.reload')}</button>
        </Notice>
      ) : null}
      {result?.kind === 'error' ? <ErrorNotice error={result.error} /> : null}

      {options.length === 0 ? (
        <div className="space-y-1">
          <p className="text-ink-2">{t('statusPanel.closed')}</p>
          {referral.closureReason ? (
            <p className="text-sm text-ink-2">{t('statusPanel.closedReason', { reason: closureReasonText(referral.closureReason) })}</p>
          ) : null}
        </div>
      ) : (
        <form className="space-y-4" noValidate onSubmit={review}>
          <ErrorSummary errors={errors} />
          <fieldset>
            <legend className="label">{t('statusPanel.changeTo')}</legend>
            <div className="mt-2 space-y-2">
              {options.map(option => (
                <div
                  key={option}
                  className="flex min-h-target items-center gap-3 rounded-xl border border-line px-3 transition-colors hover:bg-surface-2 has-[:checked]:border-ink has-[:checked]:bg-surface-2"
                >
                  <input
                    id={`status-${option}`}
                    type="radio"
                    name="status-target"
                    className="h-5 w-5 shrink-0 accent-[rgb(var(--c-ink))]"
                    value={option}
                    checked={target === option}
                    onChange={() => setTarget(option)}
                  />
                  <label htmlFor={`status-${option}`} className="flex min-h-target flex-1 cursor-pointer items-center">
                    {t(`status.${option}`)}
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
          {target === 'closed' ? (
            <div>
              <label className="label" htmlFor="closure-reason">{t('statusPanel.closureReason')}</label>
              {errors.some(error => error.fieldId === 'closure-reason') ? (
                <span id="closure-reason-error" className="field-error">{t('statusPanel.pickReason')}</span>
              ) : null}
              <select
                id="closure-reason"
                className="input mt-2"
                value={reason}
                aria-invalid={errors.some(error => error.fieldId === 'closure-reason') || undefined}
                aria-describedby={errors.some(error => error.fieldId === 'closure-reason') ? 'closure-reason-error' : undefined}
                onChange={event => setReason(event.target.value as ClosureReason | '')}
              >
                <option value="">{t('statusPanel.chooseReason')}</option>
                {CLOSURE_REASONS.map(code => <option key={code} value={code}>{t(`closure.${code}`)}</option>)}
              </select>
            </div>
          ) : null}
          <button type="submit" className="btn-primary w-full">{t('statusPanel.update')}</button>
        </form>
      )}

      <ConfirmDialog
        open={confirming}
        title={t('statusPanel.confirmTitle')}
        confirmLabel={t('statusPanel.confirm')}
        busy={busy}
        onConfirm={() => void apply()}
        onCancel={() => setConfirming(false)}
        testId="status-confirm"
      >
        {target ? (
          <p>
            {t('statusPanel.confirmBody', {
              from: t(`status.${referral.status}`), to: t(`status.${target}`), survivor: t(`survivorSees.${target}`),
            })}
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
