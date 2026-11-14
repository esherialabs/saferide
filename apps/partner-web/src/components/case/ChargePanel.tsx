import { useState } from 'react';

import { api, store } from '../../lib/app.ts';
import { refreshSummary } from '../../lib/attention.ts';
import { formatDateTime, t } from '../../lib/i18n.ts';
import { PartnerApiError, currentAssigneeOf, errorReason, type PersonRef, type Referral, type StaffMember, type TimelineEvent } from '../../lib/partnerApi.ts';
import { activityRecorded } from '../../lib/store.ts';
import { actorText, assigneeText, initials } from '../caseBadges.tsx';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { UserIcon, UserPlusIcon } from '../icons.tsx';
import { CardHeading, ErrorNotice, Notice } from '../ui.tsx';

type Result =
  | { kind: 'done'; assignee: PersonRef | null }
  | { kind: 'conflict'; current: PersonRef | null | undefined }
  | { kind: 'invalid_assignee' }
  | { kind: 'error'; error: unknown };

const NOBODY = '';

/** The latest assignment entry for the current assignee, if the history has one. */
function lastAssignment(timeline: TimelineEvent[], assignee: PersonRef | null): TimelineEvent | null {
  if (!assignee) return null;
  const entries = timeline.filter(event => event.event === 'assigned' && (!event.assignee || event.assignee.id === assignee.id));
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}

/**
 * "In charge": who on the partner's staff is handling the case. "Assign to
 * me" and the staff picker send the assignee the person saw, so a change
 * made meanwhile by someone else is refused (409) rather than overwritten.
 */
export function ChargePanel({ referral, timeline, myUserId, onChanged, onReload, onWithdrawn }: {
  referral: Referral;
  timeline: TimelineEvent[];
  myUserId: string | null;
  onChanged: (referral: Referral) => void;
  onReload: () => void;
  onWithdrawn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [picking, setPicking] = useState(false);
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [staffFailure, setStaffFailure] = useState<unknown>(null);
  const [choice, setChoice] = useState<string>(NOBODY);

  const assignee = referral.assignee;
  const mine = assignee !== null && assignee.id === myUserId;
  const assignment = lastAssignment(timeline, assignee);

  async function assign(assigneeId: string | null) {
    setBusy(true);
    setResult(null);
    store.update(state => activityRecorded(state, Date.now()));
    try {
      const response = await api.assign(referral.id, { assigneeId, expectedAssigneeId: assignee?.id ?? null });
      setPicking(false);
      setResult({ kind: 'done', assignee: response.referral.assignee });
      onChanged(response.referral);
      void refreshSummary();
    } catch (error) {
      setPicking(false);
      if (error instanceof PartnerApiError && error.kind === 'gone') onWithdrawn();
      else if (error instanceof PartnerApiError && error.kind === 'conflict') setResult({ kind: 'conflict', current: currentAssigneeOf(error) });
      else if (errorReason(error) === 'invalid_assignee') setResult({ kind: 'invalid_assignee' });
      else setResult({ kind: 'error', error });
    } finally {
      setBusy(false);
    }
  }

  async function openPicker() {
    setResult(null);
    setChoice(assignee?.id ?? NOBODY);
    setStaffFailure(null);
    setPicking(true);
    try {
      setStaff(await api.staff());
    } catch (error) {
      setStaffFailure(error);
    }
  }

  // The current assignee stays choosable even if the staff list no longer has them.
  const options: StaffMember[] = staff
    ? [...staff, ...(assignee && !staff.some(member => member.id === assignee.id) ? [{ id: assignee.id, name: assignee.name, role: 'partner_caseworker' as const }] : [])]
    : [];

  return (
    <section aria-labelledby="charge-heading" className="card space-y-4" data-testid="charge-panel">
      <CardHeading id="charge-heading" icon={<UserIcon />}>{t('charge.heading')}</CardHeading>

      {assignee ? (
        <div className="flex items-center gap-3 rounded-xl bg-surface-2 p-3">
          <span className="avatar" aria-hidden="true">{initials(assignee.name)}</span>
          <div className="min-w-0">
            <p className="font-semibold text-ink" data-testid="charge-assignee">{assigneeText(assignee, myUserId)}</p>
            {assignment ? (
              <p className="text-sm text-ink-3">
                {assignment.actor
                  ? t('charge.assignedBy', { name: actorText(assignment.actor, myUserId), time: formatDateTime(assignment.at) })
                  : t('charge.assignedAt', { time: formatDateTime(assignment.at) })}
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-line-strong/60 p-3 text-ink-2" data-testid="charge-assignee">
          {t('charge.nobody')}
        </p>
      )}

      {result?.kind === 'done' ? (
        <Notice tone="success" live="polite">
          {result.assignee ? t('charge.saved', { name: assigneeText(result.assignee, myUserId) }) : t('charge.cleared')}
        </Notice>
      ) : null}
      {result?.kind === 'conflict' ? (
        <Notice tone="warning" live="assertive">
          <p>{t('charge.conflict')}</p>
          {result.current !== undefined ? (
            <p className="mt-1 font-semibold" data-testid="charge-conflict-current">
              {result.current ? t('charge.conflictNow', { name: assigneeText(result.current, myUserId) }) : t('charge.conflictNobody')}
            </p>
          ) : null}
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
      {result?.kind === 'invalid_assignee' ? (
        <Notice tone="warning" live="assertive">{t('charge.invalidAssignee')}</Notice>
      ) : null}
      {result?.kind === 'error' ? <ErrorNotice error={result.error} /> : null}

      <div className="flex flex-wrap gap-3">
        {!mine && myUserId ? (
          <button type="button" className={assignee ? 'btn-secondary' : 'btn-primary'} disabled={busy} onClick={() => void assign(myUserId)}>
            <UserPlusIcon />
            {t('charge.assignToMe')}
          </button>
        ) : null}
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void openPicker()}>
          {assignee ? t('charge.change') : t('charge.choose')}
        </button>
      </div>

      <ConfirmDialog
        open={picking}
        title={t('charge.pickerTitle')}
        confirmLabel={t('charge.save')}
        busy={busy}
        confirmDisabled={staff === null}
        describe={false}
        testId="staff-picker"
        onConfirm={() => void assign(choice === NOBODY ? null : choice)}
        onCancel={() => setPicking(false)}
      >
        <p>{t('charge.pickerIntro')}</p>
        {staffFailure ? <ErrorNotice error={staffFailure} /> : null}
        {staff === null && !staffFailure ? <p role="status">{t('charge.loadingStaff')}</p> : null}
        {staff !== null && options.length === 0 ? <p>{t('charge.noStaff')}</p> : null}
        {staff !== null ? (
          <fieldset>
            <legend className="sr-only">{t('charge.pickerLegend')}</legend>
            <div className="mt-2 max-h-[50vh] space-y-2 overflow-y-auto p-1">
              {options.map(member => (
                <div key={member.id} className="choice">
                  <input
                    id={`assignee-${member.id}`}
                    type="radio"
                    name="assignee"
                    value={member.id}
                    checked={choice === member.id}
                    onChange={() => setChoice(member.id)}
                  />
                  <label htmlFor={`assignee-${member.id}`}>
                    <span className="avatar" aria-hidden="true">{initials(member.name)}</span>
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="font-semibold text-ink">{assigneeText(member, myUserId)}</span>
                      <span className="text-sm text-ink-3">{t(`charge.role.${member.role}`)}</span>
                    </span>
                  </label>
                </div>
              ))}
              <div className="choice">
                <input id="assignee-nobody" type="radio" name="assignee" value="" checked={choice === NOBODY} onChange={() => setChoice(NOBODY)} />
                <label htmlFor="assignee-nobody">
                  <span className="font-semibold text-ink">{t('assignee.nobody')}</span>
                </label>
              </div>
            </div>
          </fieldset>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
