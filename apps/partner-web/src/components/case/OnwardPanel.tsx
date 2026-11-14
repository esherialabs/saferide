import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { api, store } from '../../lib/app.ts';
import { setDraft } from '../../lib/drafts.ts';
import { formatDateTime, t } from '../../lib/i18n.ts';
import {
  ONWARD_INITIAL_STATUSES, ONWARD_LIMITS, ONWARD_TYPES, PartnerApiError, nextOnwardStatuses, onwardInputProblems, stripControlCharacters,
  type OnwardInitialStatus, type OnwardReferral, type OnwardStatus, type OnwardTextField, type OnwardType,
} from '../../lib/partnerApi.ts';
import { activityRecorded } from '../../lib/store.ts';
import { OnwardStatusChip, OnwardTypeIcon, actorText } from '../caseBadges.tsx';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { ArrowUturnRightIcon, PlusIcon, ShieldCheckIcon } from '../icons.tsx';
import { CardHeading, ErrorNotice, ErrorSummary, LiveMessage, Notice, type FieldError } from '../ui.tsx';

type Move = { onward: OnwardReferral; to: OnwardStatus };
type Result = { kind: 'conflict' } | { kind: 'error'; error: unknown } | null;

const EMPTY_FORM: Record<OnwardTextField, string> = { organisation: '', contactRole: '', externalReference: '', note: '' };

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Onward referrals: where HURIA sent the survivor on to (police, a clinic,
 * counselling, legal aid, a shelter, child protection), recorded by role
 * and reference only. Status moves are limited to the allowed ones and
 * carry the status the person saw, so a stale update is refused (409).
 */
export function OnwardPanel({ referralId, onward, myUserId, onChanged, onReload, onWithdrawn }: {
  referralId: string;
  onward: OnwardReferral[];
  myUserId: string | null;
  /** A referral was added or moved: the case reloads its history. */
  onChanged: (onward: OnwardReferral) => void;
  onReload: () => void;
  onWithdrawn: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [move, setMove] = useState<Move | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [announcement, setAnnouncement] = useState('');
  const addButton = useRef<HTMLButtonElement>(null);
  const ordered = [...onward].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  async function applyMove() {
    if (!move) return;
    setBusy(true);
    setResult(null);
    setAnnouncement('');
    store.update(state => activityRecorded(state, Date.now()));
    try {
      const response = await api.changeOnwardStatus(referralId, move.onward.id, { to: move.to, expectedStatus: move.onward.status });
      const status = response?.onward?.status ?? move.to;
      setAnnouncement(t('onwardPanel.moved', { type: t(`onward.type.${move.onward.type}`), status: lower(t(`onward.status.${status}`)) }));
      onChanged(response?.onward ?? { ...move.onward, status: move.to, allowedTransitions: nextOnwardStatuses({ status: move.to }) });
      setMove(null);
    } catch (error) {
      setMove(null);
      if (error instanceof PartnerApiError && error.kind === 'gone') onWithdrawn();
      else setResult(error instanceof PartnerApiError && error.kind === 'conflict' ? { kind: 'conflict' } : { kind: 'error', error });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="onward-heading" className="card space-y-4" data-testid="onward-panel">
      <CardHeading id="onward-heading" icon={<ArrowUturnRightIcon />}>{t('onwardPanel.heading')}</CardHeading>
      {adding ? null : (
        <p className="flex items-start gap-2 text-sm text-ink-2" data-testid="onward-privacy">
          <ShieldCheckIcon className="mt-0.5 h-5 w-5 shrink-0" />
          {t('onwardPanel.privacy')}
        </p>
      )}

      <LiveMessage message={announcement} />
      {result?.kind === 'conflict' ? (
        <Notice tone="warning" live="assertive">
          <p>{t('onwardPanel.conflict')}</p>
          <button
            type="button"
            className="btn-secondary mt-3"
            onClick={() => {
              setResult(null);
              onReload();
            }}
          >
            {t('statusPanel.reload')}
          </button>
        </Notice>
      ) : null}
      {result?.kind === 'error' ? <ErrorNotice error={result.error} /> : null}

      {ordered.length === 0 && !adding ? <p className="text-ink-2" data-testid="onward-none">{t('onwardPanel.none')}</p> : null}

      {ordered.length > 0 ? (
        <ul className="space-y-3" data-testid="onward-list">
          {ordered.map(item => (
            <OnwardItem key={item.id} item={item} myUserId={myUserId} busy={busy} onMove={to => setMove({ onward: item, to })} />
          ))}
        </ul>
      ) : null}

      {adding ? (
        <OnwardForm
          referralId={referralId}
          onCancel={() => {
            setAdding(false);
            window.setTimeout(() => addButton.current?.focus(), 0);
          }}
          onSaved={saved => {
            setAdding(false);
            setAnnouncement(t('onwardPanel.saved', { type: t(`onward.type.${saved.type}`) }));
            onChanged(saved);
            window.setTimeout(() => addButton.current?.focus(), 0);
          }}
          onWithdrawn={onWithdrawn}
        />
      ) : (
        <button ref={addButton} type="button" className="btn-secondary" onClick={() => setAdding(true)}>
          <PlusIcon />
          {t('onwardPanel.add')}
        </button>
      )}

      <ConfirmDialog
        open={move !== null}
        title={t('onwardPanel.confirmTitle')}
        confirmLabel={t('onwardPanel.confirm')}
        busy={busy}
        testId="onward-confirm"
        onConfirm={() => void applyMove()}
        onCancel={() => setMove(null)}
      >
        {move ? (
          <p>
            {t('onwardPanel.confirmBody', {
              type: t(`onward.type.${move.onward.type}`),
              from: lower(t(`onward.status.${move.onward.status}`)),
              to: lower(t(`onward.status.${move.to}`)),
            })}
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

function OnwardItem({ item, myUserId, busy, onMove }: {
  item: OnwardReferral;
  myUserId: string | null;
  busy: boolean;
  onMove: (to: OnwardStatus) => void;
}) {
  const moves = nextOnwardStatuses(item);
  const headingId = `onward-${item.id}`;
  const details: Array<{ label: string; value: string | null }> = [
    { label: t('onwardPanel.contactRoleLabel'), value: item.contactRole },
    { label: t('onwardPanel.externalReferenceLabel'), value: item.externalReference },
    { label: t('onwardPanel.noteLabel'), value: item.note },
  ];
  return (
    <li className="rounded-xl border border-line p-4" data-testid="onward-item">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="card-icon">
            <OnwardTypeIcon type={item.type} />
          </span>
          <div className="min-w-0">
            <h3 id={headingId}>{t(`onward.type.${item.type}`)}</h3>
            {item.organisation ? <p className="text-ink-2">{item.organisation}</p> : null}
          </div>
        </div>
        <OnwardStatusChip status={item.status} />
      </div>
      {details.some(detail => detail.value) ? (
        <dl className="mt-3">
          {details.filter(detail => detail.value).map(detail => (
            <div key={detail.label} className="kv-row">
              <dt>{detail.label}</dt>
              <dd className={detail.label === t('onwardPanel.externalReferenceLabel') ? 'font-mono' : undefined}>{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="mt-2 text-sm text-ink-3">
        {t('onwardPanel.recorded', { name: actorText(item.createdBy, myUserId), time: formatDateTime(item.createdAt) })}
        {item.statusChangedAt && item.statusChangedAt !== item.createdAt
          ? ` · ${t('onwardPanel.statusChanged', { time: formatDateTime(item.statusChangedAt) })}`
          : ''}
      </p>
      {moves.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`${t('onwardPanel.updateLegend')}: ${t(`onward.type.${item.type}`)}`}>
          {moves.map(to => (
            <button key={to} type="button" className="btn-secondary" disabled={busy} onClick={() => onMove(to)}>
              {t(`onwardPanel.move.${to as Exclude<OnwardStatus, 'planned'>}`)}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function OnwardForm({ referralId, onCancel, onSaved, onWithdrawn }: {
  referralId: string;
  onCancel: () => void;
  onSaved: (onward: OnwardReferral) => void;
  onWithdrawn: () => void;
}) {
  const [type, setType] = useState<OnwardType | ''>('');
  const [fields, setFields] = useState<Record<OnwardTextField, string>>(EMPTY_FORM);
  const [status, setStatus] = useState<OnwardInitialStatus>('planned');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const draftKey = `onward-${useId()}`;
  const noteLength = [...fields.note].length;

  useEffect(() => {
    heading.current?.focus();
  }, []);

  // Sign-out and the expiry warnings say when an unsaved onward referral would be lost.
  useEffect(() => {
    setDraft(draftKey, type !== '' || Object.values(fields).some(value => value.trim().length > 0));
  }, [draftKey, type, fields]);
  useEffect(() => () => setDraft(draftKey, false), [draftKey]);

  const set = (field: OnwardTextField) => (value: string) => setFields(current => ({ ...current, [field]: stripControlCharacters(value) }));
  const errorFor = (fieldId: string) => errors.find(error => error.fieldId === fieldId)?.message;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const problems = onwardInputProblems({ type, ...fields });
    const found: FieldError[] = problems.map(problem => problem.field === 'type'
      ? { fieldId: `onward-type-${ONWARD_TYPES[0]}`, message: t('onwardPanel.pickType') }
      : { fieldId: `onward-${problem.field}`, message: t(`onwardPanel.tooLong.${problem.field}`) });
    setErrors(found);
    if (found.length > 0 || !type) return;
    setBusy(true);
    store.update(state => activityRecorded(state, Date.now()));
    try {
      const response = await api.addOnward(referralId, { type, ...fields, status });
      setDraft(draftKey, false);
      onSaved(response.onward);
    } catch (error) {
      if (error instanceof PartnerApiError && error.kind === 'gone') onWithdrawn();
      else if (error instanceof PartnerApiError && error.kind === 'bad_request') {
        // Refused text: shown at the fields that hold text, listed in the summary.
        const filled = (Object.keys(EMPTY_FORM) as OnwardTextField[]).filter(field => fields[field].trim());
        setErrors(filled.length > 0
          ? filled.map(field => ({ fieldId: `onward-${field}`, message: t('onwardPanel.rejected', { field: t(`onwardPanel.${field}Label`) }) }))
          : [{ fieldId: `onward-type-${type}`, message: t('onwardPanel.rejectedForm') }]);
      } else setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  const textField = (field: OnwardTextField, multiline = false) => {
    const id = `onward-${field}`;
    const hintId = `${id}-hint`;
    const error = errorFor(id);
    const errorId = error ? `${id}-error` : undefined;
    const common = {
      id,
      name: id,
      className: 'input mt-2',
      value: fields[field],
      maxLength: ONWARD_LIMITS[field],
      spellCheck: false,
      autoComplete: 'off',
      'aria-invalid': error ? true : undefined,
      'aria-describedby': [hintId, errorId, multiline ? `${id}-counter` : undefined].filter(Boolean).join(' '),
    } as const;
    return (
      <div>
        <label className="label" htmlFor={id}>{t(`onwardPanel.${field}`)}</label>
        <span id={hintId} className="hint">{t(`onwardPanel.${field}Hint`)}</span>
        {error ? <span id={errorId} className="field-error">{error}</span> : null}
        {multiline ? (
          <>
            <textarea {...common} rows={4} autoCorrect="off" autoCapitalize="off" onChange={event => set(field)(event.target.value)} />
            <span id={`${id}-counter`} className="hint">{t('onwardPanel.noteCounter', { count: noteLength })}</span>
          </>
        ) : (
          <input {...common} type="text" autoCorrect="off" autoCapitalize="off" onChange={event => set(field)(event.target.value)} />
        )}
      </div>
    );
  };

  return (
    <form className="space-y-5 rounded-xl border border-line-strong/60 bg-surface-2/50 p-4" noValidate onSubmit={submit} data-testid="onward-form" aria-labelledby="onward-form-heading">
      <h3 id="onward-form-heading" ref={heading} tabIndex={-1} className="text-lg">{t('onwardPanel.formHeading')}</h3>
      <ErrorSummary errors={errors} />
      <fieldset>
        <legend className="label">{t('onwardPanel.typeLegend')}</legend>
        {errorFor(`onward-type-${ONWARD_TYPES[0]}`) ? <span className="field-error">{t('onwardPanel.pickType')}</span> : null}
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {ONWARD_TYPES.map(option => (
            <div key={option} className="choice bg-surface">
              <input
                id={`onward-type-${option}`}
                type="radio"
                name="onward-type"
                value={option}
                checked={type === option}
                onChange={() => setType(option)}
                aria-describedby={`onward-type-${option}-hint`}
              />
              <label htmlFor={`onward-type-${option}`}>
                <OnwardTypeIcon type={option} className="h-5 w-5 shrink-0 text-ink-2" />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="font-semibold text-ink">{t(`onward.type.${option}`)}</span>
                  <span id={`onward-type-${option}-hint`} className="text-sm text-ink-3">{t(`onward.typeHint.${option}`)}</span>
                </span>
              </label>
            </div>
          ))}
        </div>
      </fieldset>
      {textField('organisation')}
      {textField('contactRole')}
      {textField('externalReference')}
      {textField('note', true)}
      <fieldset>
        <legend className="label">{t('onwardPanel.statusLegend')}</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {ONWARD_INITIAL_STATUSES.map(option => (
            <div key={option} className="choice bg-surface">
              <input id={`onward-status-${option}`} type="radio" name="onward-status" value={option} checked={status === option} onChange={() => setStatus(option)} />
              <label htmlFor={`onward-status-${option}`}>{t(`onwardPanel.status.${option}`)}</label>
            </div>
          ))}
        </div>
      </fieldset>
      <Notice tone="info"><p data-testid="onward-privacy">{t('onwardPanel.privacy')}</p></Notice>
      {failure ? <ErrorNotice error={failure} /> : null}
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn-primary" disabled={busy}>{t('onwardPanel.save')}</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}
