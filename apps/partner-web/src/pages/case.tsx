import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { CallbackPanel } from '../components/case/CallbackPanel.tsx';
import { BriefView, PacketView, UnavailableContent } from '../components/case/CaseContent.tsx';
import { ChargePanel } from '../components/case/ChargePanel.tsx';
import { EvidenceList } from '../components/case/EvidenceList.tsx';
import { NotesPanel } from '../components/case/NotesPanel.tsx';
import { OnwardPanel } from '../components/case/OnwardPanel.tsx';
import { StatusPanel } from '../components/case/StatusPanel.tsx';
import { Timeline } from '../components/case/Timeline.tsx';
import { NeedsAttention, PriorityBadge, assigneeText } from '../components/caseBadges.tsx';
import { Layout } from '../components/Layout.tsx';
import { RequireSession } from '../components/RequireSession.tsx';
import { ArrowLeftIcon, CheckCircleIcon, EyeSlashIcon, PhoneIcon, SpinnerIcon, WarningIcon } from '../components/icons.tsx';
import { CardHeading, EmptyState, ErrorNotice, Loading, Notice, PageHeading, StatusBadge } from '../components/ui.tsx';
import { api, store, useAppState } from '../lib/app.ts';
import { refreshSummary } from '../lib/attention.ts';
import { formatDateTime, t } from '../lib/i18n.ts';
import {
  PartnerApiError, isReferralId, isTombstone, type OnwardReferral, type Referral, type ReferralDetailResponse, type ReferralTombstone,
  type TimelineEvent,
} from '../lib/partnerApi.ts';
import { activityRecorded, queueItemOf, queueItemOfTombstone, queueRowUpdated } from '../lib/store.ts';

type Detail =
  | { kind: 'loading' }
  | { kind: 'ready'; data: ReferralDetailResponse }
  | { kind: 'not_found' }
  | { kind: 'error'; error: unknown };

function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 px-4 py-3">
      <dt className="meta font-semibold">{label}</dt>
      <dd className="mt-1 font-semibold text-ink">{children}</dd>
    </div>
  );
}

/** The newest time anything happened to the case (status, history, onward referrals). */
function lastUpdated(data: ReferralDetailResponse, referral: Referral): string {
  const times = [
    referral.statusChangedAt,
    ...data.timeline.map(event => event.at),
    ...data.onwardReferrals.map(item => item.statusChangedAt || item.createdAt),
  ].filter(time => Number.isFinite(Date.parse(time)));
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? referral.statusChangedAt;
}

function TombstoneSummary({ referral }: { referral: ReferralTombstone }) {
  return (
    <section aria-labelledby="summary-heading" className="card p-3 sm:p-3">
      <h2 id="summary-heading" className="sr-only">{t('case.summary')}</h2>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryItem label={t('case.type')}>{t('pathway.hidden')}</SummaryItem>
        <SummaryItem label={t('case.status')}>
          <StatusBadge status="withdrawn" />
        </SummaryItem>
        <SummaryItem label={t('case.received')}>{formatDateTime(referral.receivedAt)}</SummaryItem>
        <SummaryItem label={t('case.withdrawnOn')}>{formatDateTime(referral.withdrawnAt)}</SummaryItem>
      </dl>
    </section>
  );
}

/** The case header: priority, attention, type, status, who is in charge, and when. */
function Summary({ referral, data, myUserId }: { referral: Referral; data: ReferralDetailResponse; myUserId: string | null }) {
  const urgent = referral.priority === 'urgent';
  return (
    <section aria-labelledby="summary-heading" className={`card space-y-3 p-3 sm:p-3 ${urgent ? 'card-urgent' : ''}`} data-testid="case-summary">
      <h2 id="summary-heading" className="sr-only">{t('case.summary')}</h2>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 pt-1">
        <span className="inline-flex items-center gap-2">
          <span className="meta font-semibold">{t('case.priority')}:</span>
          <PriorityBadge priority={referral.priority} />
        </span>
        {referral.needsAttention ? <NeedsAttention /> : null}
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryItem label={t('case.type')}>{referral.pathway ? t(`pathway.${referral.pathway}`) : t('pathway.hidden')}</SummaryItem>
        <SummaryItem label={t('case.status')}>
          <StatusBadge status={referral.status} />
        </SummaryItem>
        <SummaryItem label={t('case.assignee')}>
          <span className={referral.assignee ? undefined : 'italic text-ink-3'} data-testid="summary-assignee">
            {assigneeText(referral.assignee, myUserId)}
          </span>
        </SummaryItem>
        <SummaryItem label={t('case.received')}>{formatDateTime(referral.receivedAt)}</SummaryItem>
        <SummaryItem label={t('case.updated')}>{formatDateTime(lastUpdated(data, referral))}</SummaryItem>
      </dl>
    </section>
  );
}

/**
 * An urgent case nobody has acknowledged: says so plainly and offers
 * "Acknowledge" as the main action. Opening the case never acknowledges it.
 */
function AttentionCallout({ referral, onAcknowledged, onReload, onWithdrawn }: {
  referral: Referral;
  onAcknowledged: (referral: Referral) => void;
  onReload: () => void;
  onWithdrawn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'conflict' } | { kind: 'error'; error: unknown } | null>(null);
  const canAcknowledge = referral.status === 'new' && referral.allowedTransitions.includes('acknowledged');

  async function acknowledge() {
    setBusy(true);
    setResult(null);
    store.update(state => activityRecorded(state, Date.now()));
    try {
      const response = await api.acknowledge(referral.id);
      onAcknowledged(response.referral);
    } catch (error) {
      if (error instanceof PartnerApiError && error.kind === 'gone') onWithdrawn();
      else setResult(error instanceof PartnerApiError && error.kind === 'conflict' ? { kind: 'conflict' } : { kind: 'error', error });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="attention-heading" className="card card-urgent space-y-3 border-error-line/60 bg-error-bg" data-testid="attention-callout">
      <div className="flex items-start gap-3">
        <span className="card-icon bg-surface text-error-fg"><WarningIcon /></span>
        <div className="min-w-0 space-y-1 text-error-fg">
          <h2 id="attention-heading" className="text-error-fg">{t('case.attentionHeading')}</h2>
          <p>{canAcknowledge ? t('case.attentionBody') : t('case.attentionNoAction')}</p>
        </div>
      </div>
      {result?.kind === 'conflict' ? (
        <Notice tone="warning" live="assertive">
          <p>{t('case.acknowledgeConflict')}</p>
          <button type="button" className="btn-secondary mt-3" onClick={onReload}>{t('statusPanel.reload')}</button>
        </Notice>
      ) : null}
      {result?.kind === 'error' ? <ErrorNotice error={result.error} /> : null}
      {canAcknowledge ? (
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void acknowledge()}>
          {busy ? <SpinnerIcon /> : <CheckCircleIcon />}
          {busy ? t('case.acknowledging') : t('case.acknowledge')}
        </button>
      ) : null}
    </section>
  );
}

/** A confirmation that takes focus (the control that triggered it has gone). */
function Flash({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} tabIndex={-1} data-testid="case-flash">
      <Notice tone="success" live="polite">{children}</Notice>
    </div>
  );
}

function syncQueue(data: ReferralDetailResponse) {
  const { referral } = data;
  store.update(state => queueRowUpdated(state, isTombstone(referral) ? queueItemOfTombstone(referral) : queueItemOf(referral, data.onwardReferrals)));
}

function CaseDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [flash, setFlash] = useState<{ key: number; text: string } | null>(null);
  const identity = useAppState(state => (state.auth.status === 'signed_in' ? state.auth.identity : null));
  const myUserId = identity?.userId ?? null;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDetail({ kind: 'loading' });
    api.getReferral(id)
      .then(data => {
        if (cancelled) return;
        setDetail({ kind: 'ready', data });
        syncQueue(data);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof PartnerApiError && error.kind === 'not_found') setDetail({ kind: 'not_found' });
        else if (!(error instanceof PartnerApiError && error.kind === 'unauthorized')) setDetail({ kind: 'error', error });
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  // Reloading shows the latest state; after a 410 that is the "no longer shared" tombstone.
  const reload = useCallback(() => setAttempt(value => value + 1), []);

  const update = (change: (data: ReferralDetailResponse) => ReferralDetailResponse) => {
    setDetail(current => (current.kind === 'ready' ? { kind: 'ready', data: change(current.data) } : current));
  };

  // After a change: fetch the case again quietly (no loading state) so the
  // history shows who did it, and keep the queue row in step. A failure
  // keeps the local update; a case no longer shared reloads into the tombstone.
  const refresh = useCallback(async () => {
    try {
      const data = await api.getReferral(id);
      if (!mounted.current) return;
      setDetail(current => (current.kind === 'ready' ? { kind: 'ready', data } : current));
      syncQueue(data);
    } catch (error) {
      if (mounted.current && error instanceof PartnerApiError && (error.kind === 'gone' || error.kind === 'not_found')) reload();
    }
  }, [id, reload]);

  const me = identity ? { id: identity.userId, name: identity.displayName } : null;
  const now = () => new Date().toISOString();

  /** Applies a local change to the loaded case and keeps the queue row in step. */
  const change = (edit: (data: ReferralDetailResponse) => ReferralDetailResponse) => {
    if (detail.kind !== 'ready') return;
    const changed = edit(detail.data);
    setDetail({ kind: 'ready', data: changed });
    syncQueue(changed);
  };

  /** A status or assignee change from the server: merge it, record it in the history, then fetch the case again. */
  const referralChanged = (next: Referral, event: TimelineEvent | null) => {
    change(data => (isTombstone(data.referral)
      ? data
      : { ...data, referral: { ...data.referral, ...next }, timeline: event ? [...data.timeline, event] : data.timeline }));
    void refresh();
    void refreshSummary();
  };

  const onwardChanged = (onward: OnwardReferral) => {
    change(data => ({
      ...data,
      onwardReferrals: data.onwardReferrals.some(item => item.id === onward.id)
        ? data.onwardReferrals.map(item => (item.id === onward.id ? onward : item))
        : [...data.onwardReferrals, onward],
    }));
    void refresh();
  };

  const back = (
    <p>
      <Link href="/cases/" className="btn-link no-underline hover:underline">
        <ArrowLeftIcon />
        {t('case.back')}
      </Link>
    </p>
  );

  if (detail.kind === 'loading') return <div className="space-y-6">{back}<Loading label={t('case.loading')} variant="detail" /></div>;
  if (detail.kind === 'not_found') {
    return (
      <div className="space-y-6">
        {back}
        <PageHeading>{t('title.case')}</PageHeading>
        <Notice tone="warning" live="polite">{t('case.notFound')}</Notice>
      </div>
    );
  }
  if (detail.kind === 'error') {
    return (
      <div className="space-y-6">
        {back}
        <PageHeading>{t('title.case')}</PageHeading>
        <ErrorNotice error={detail.error}>
          <button type="button" className="btn-secondary mt-3" onClick={reload}>{t('case.retry')}</button>
        </ErrorNotice>
      </div>
    );
  }

  const { referral, view, attachments, timeline, notes, onwardReferrals } = detail.data;

  if (isTombstone(referral) || !view) {
    return (
      <div className="space-y-6">
        {back}
        <PageHeading>{t('case.heading', { reference: referral.reference })}</PageHeading>
        {isTombstone(referral) ? <TombstoneSummary referral={referral} /> : null}
        <EmptyState
          as="section"
          titleId="withdrawn-heading"
          title={t('case.withdrawnHeading')}
          icon={<EyeSlashIcon />}
          testId="withdrawn-tombstone"
        >
          <p>{t('case.withdrawnBody')}</p>
        </EmptyState>
      </div>
    );
  }

  const caseworker = identity?.role === 'partner_caseworker';

  return (
    <div className="space-y-6">
      {back}
      <PageHeading>{t('case.heading', { reference: referral.reference })}</PageHeading>
      <Summary referral={referral} data={detail.data} myUserId={myUserId} />
      {flash ? <Flash key={flash.key}>{flash.text}</Flash> : null}
      {referral.needsAttention ? (
        <AttentionCallout
          referral={referral}
          onReload={reload}
          onWithdrawn={reload}
          onAcknowledged={next => {
            setFlash({ key: Date.now(), text: t('case.acknowledged') });
            referralChanged(
              { ...next, needsAttention: next.needsAttention && next.status === 'new' },
              { event: 'acknowledged', status: 'acknowledged', at: next.statusChangedAt || now(), actor: me },
            );
          }}
        />
      ) : null}
      {/* Phones and tablets: "In charge" first, then the case, then the other actions.
          Wide screens: the case on the left; "In charge" above the sticky actions on the right. */}
      <div className="grid items-start gap-6 lg:grid-cols-12 lg:grid-rows-[auto_1fr]">
        <div className="lg:col-span-5 lg:col-start-8 lg:row-start-1 xl:col-span-4 xl:col-start-9">
            <ChargePanel
              referral={referral}
              timeline={timeline}
              myUserId={myUserId}
              onReload={() => void refresh()}
              onWithdrawn={reload}
              onChanged={next => referralChanged(
                { ...referral, assignee: next.assignee },
                next.assignee
                  ? { event: 'assigned', status: null, at: now(), actor: me, assignee: next.assignee }
                  : { event: 'unassigned', status: null, at: now(), actor: me },
              )}
            />
        </div>
        <div className="space-y-6 lg:col-span-7 lg:col-start-1 lg:row-span-2 lg:row-start-1 xl:col-span-8">
          {view.kind === 'referral' ? <BriefView view={view} reference={referral.reference} /> : null}
          {view.kind === 'escalation' ? <PacketView view={view} /> : null}
          {view.kind === 'unavailable' ? <UnavailableContent /> : null}
          <OnwardPanel
            referralId={referral.id}
            onward={onwardReferrals}
            myUserId={myUserId}
            onChanged={onwardChanged}
            onReload={() => void refresh()}
            onWithdrawn={reload}
          />
          <EvidenceList referralId={referral.id} attachments={attachments} onWithdrawn={reload} />
          <Timeline events={timeline} myUserId={myUserId} />
        </div>
        <div className="case-actions space-y-6 lg:col-span-5 lg:col-start-8 lg:row-start-2 xl:col-span-4 xl:col-start-9">
          <StatusPanel
            referral={referral}
            onReload={reload}
            onWithdrawn={reload}
            onChanged={next => referralChanged(
              {
                ...referral,
                status: next.status,
                statusChangedAt: next.statusChangedAt,
                closureReason: next.closureReason,
                allowedTransitions: next.allowedTransitions,
                needsAttention: next.needsAttention && next.status === 'new',
              },
              next.status === 'acknowledged'
                ? { event: 'acknowledged', status: 'acknowledged', at: next.statusChangedAt, actor: me }
                : { event: 'status_change', status: next.status, at: next.statusChangedAt },
            )}
          />
          {referral.callbackShared && caseworker ? (
            <CallbackPanel referralId={referral.id} onWithdrawn={reload} />
          ) : (
            <section aria-labelledby="callback-heading" className="card space-y-3">
              <CardHeading id="callback-heading" icon={<PhoneIcon />}>{t('callback.heading')}</CardHeading>
              <p className="text-ink-2" data-testid="callback-not-shared">
                {referral.callbackShared ? t('callback.adminOnly') : t('callback.notShared')}
              </p>
            </section>
          )}
          <NotesPanel
            referralId={referral.id}
            notes={notes}
            onWithdrawn={reload}
            onAdded={note => update(data => ({ ...data, notes: [...data.notes, note] }))}
          />
        </div>
      </div>
    </div>
  );
}

function CasePageBody() {
  const router = useRouter();
  if (!router.isReady) return <Loading label={t('case.loading')} />;
  const raw = router.query.id;
  const id = typeof raw === 'string' && isReferralId(raw) ? raw : null;
  if (!id) {
    return (
      <div className="space-y-6">
        <PageHeading>{t('title.case')}</PageHeading>
        <Notice tone="warning">{t('case.missingId')}</Notice>
        <p>
          <Link href="/cases/" className="btn-link no-underline hover:underline">
            <ArrowLeftIcon />
            {t('case.back')}
          </Link>
        </p>
      </div>
    );
  }
  // Keyed so a different case starts from an empty state.
  return <CaseDetail key={id} id={id} />;
}

export default function CasePage() {
  return (
    <Layout title={t('title.case')}>
      <RequireSession>
        <CasePageBody />
      </RequireSession>
    </Layout>
  );
}
