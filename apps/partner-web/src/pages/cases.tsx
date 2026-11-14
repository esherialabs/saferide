import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

import { Layout } from '../components/Layout.tsx';
import { RequireSession } from '../components/RequireSession.tsx';
import {
  AttentionDot, NeedsAttention, OnwardStatusChip, OnwardTypeIcon, PriorityBadge, assigneeText,
} from '../components/caseBadges.tsx';
import { ClockIcon, InboxIcon, RefreshIcon, SpinnerIcon } from '../components/icons.tsx';
import { EmptyState, ErrorNotice, Loading, Notice, PageHeading, StatusBadge } from '../components/ui.tsx';
import { api, store, useAppState } from '../lib/app.ts';
import { refreshSummary } from '../lib/attention.ts';
import { formatDateTime, formatTime, t } from '../lib/i18n.ts';
import { BACKGROUND_REFRESH_MIN_MS, QUEUE_STATUS_FILTERS, type CaseSummary, type ReferralQueueItem } from '../lib/partnerApi.ts';
import {
  DEFAULT_QUEUE_FILTER, QUEUE_VIEWS, apiFilterFor, isQueueView, queueFilterChanged, queueLoaded, type QueueFilter, type QueueView,
} from '../lib/store.ts';

// The periodic refresh runs once BACKGROUND_REFRESH_MIN_MS has passed since
// the last load of any kind (or the last attempt, so failures do not retry
// faster), checked every few seconds, and only while the tab is visible.
const REFRESH_CHECK_MS = 5 * 1000;
let lastBackgroundRefreshAt = 0;

function FilterGroup<T extends string>({
  name, legend, value, options, onChange, phoneColumns,
}: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Columns of the even grid used on phones. */
  phoneColumns: 2 | 3;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="label mb-2 text-sm text-ink-2">{legend}</legend>
      <div className={`segmented ${phoneColumns === 3 ? 'segmented-3' : 'segmented-2'}`}>
        {options.map(option => {
          const id = `${name}-${option.value}`;
          return (
            <span key={option.value}>
              <input
                id={id}
                className="pill-input sr-only"
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
              />
              <label htmlFor={id} className="pill">{option.label}</label>
            </span>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The URL carries only the quick view's fixed code (never case data), so the banner can link to it. */
function viewPath(view: QueueView): string {
  return view === 'all' ? '/cases/' : `/cases/?view=${view}`;
}

function caseHref(row: ReferralQueueItem): string {
  return `/case/?id=${encodeURIComponent(row.id)}`;
}

function Queue() {
  const queue = useAppState(state => state.queue);
  const myUserId = useAppState(state => (state.auth.status === 'signed_in' ? state.auth.identity?.userId ?? null : null));
  const summary = useAppState(state => state.alerts.summary);
  const router = useRouter();
  const [loading, setLoading] = useState<'idle' | 'replace' | 'append'>('idle');
  const [failure, setFailure] = useState<unknown>(null);
  const filterRef = useRef(queue.filter);
  filterRef.current = queue.filter;

  const load = useCallback(async (mode: 'replace' | 'append' | 'refresh') => {
    const filter = filterRef.current;
    const cursor = mode === 'append' ? store.get().queue.nextCursor ?? undefined : undefined;
    if (mode !== 'refresh') setLoading(mode);
    try {
      const page = await api.listReferrals(apiFilterFor(filter, cursor), { background: mode === 'refresh' });
      store.update(state => queueLoaded(state, filter, page, mode, Date.now()));
      setFailure(null);
    } catch (error) {
      if (mode !== 'refresh') setFailure(error);
    } finally {
      if (mode !== 'refresh') setLoading('idle');
    }
  }, []);

  // A view in the address bar (the banner's link) wins; otherwise the
  // address bar is brought in line with the view kept in memory.
  const queryView = router.isReady ? router.query.view : undefined;
  useEffect(() => {
    if (!router.isReady) return;
    if (isQueueView(queryView)) {
      if (queryView !== store.get().queue.filter.view) {
        store.update(state => queueFilterChanged(state, { ...state.queue.filter, view: queryView, status: 'all' }));
      }
      return;
    }
    const current = store.get().queue.filter.view;
    if (current !== 'all') void router.replace(viewPath(current), undefined, { shallow: true, scroll: false });
  }, [router, queryView]);

  const loaded = queue.loadedAt !== null;
  useEffect(() => {
    if (!loaded) void load('replace');
  }, [loaded, queue.filter, load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const last = Math.max(lastBackgroundRefreshAt, store.get().queue.loadedAt ?? 0);
      if (document.visibilityState !== 'visible' || now - last < BACKGROUND_REFRESH_MIN_MS) return;
      lastBackgroundRefreshAt = now;
      void load('refresh');
    }, REFRESH_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const setFilter = (change: Partial<QueueFilter>) => {
    const next = { ...store.get().queue.filter, ...change };
    store.update(state => queueFilterChanged(state, next));
    if (change.view !== undefined) void router.replace(viewPath(next.view), undefined, { shallow: true, scroll: false });
  };

  const filtered = queue.filter.view !== 'all' || queue.filter.status !== 'all';

  const openRow = (event: MouseEvent<HTMLTableRowElement>, row: ReferralQueueItem) => {
    // The reference link is the row's keyboard and screen-reader target; a
    // click anywhere else on the row (not on text being selected) opens it too.
    if ((event.target as Element).closest('a, button, input, label')) return;
    if (window.getSelection()?.toString()) return;
    void router.push(caseHref(row));
  };

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div className="min-w-0">
          <PageHeading>{t('queue.heading')}</PageHeading>
          <p className="mt-2 max-w-2xl text-ink-2">{t('queue.intro')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {queue.loadedAt ? (
            <p className="meta inline-flex items-center gap-1.5">
              <ClockIcon className="h-4 w-4" />
              {t('queue.updated', { time: formatTime(queue.loadedAt) })}
            </p>
          ) : null}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void load('replace');
              void refreshSummary();
            }}
            disabled={loading !== 'idle'}
          >
            {loading === 'replace' ? <SpinnerIcon /> : <RefreshIcon />}
            {t('queue.refresh')}
          </button>
        </div>
      </div>

      {summary ? <AtAGlance summary={summary} /> : null}

      <div className="card">
        <div className="flex flex-col gap-5">
          <FilterGroup
            name="view"
            legend={t('queue.viewFilter')}
            value={queue.filter.view}
            options={QUEUE_VIEWS.map(view => ({ value: view, label: t(`queue.view.${view}`) }))}
            onChange={view => setFilter({ view, status: 'all' })}
            phoneColumns={2}
          />
          {queue.filter.view === 'attention' ? (
            <p className="meta max-w-sm self-center" data-testid="attention-filter-note">{t('queue.attentionStatusNote')}</p>
          ) : (
            <FilterGroup
              name="status"
              legend={t('queue.statusFilter')}
              value={queue.filter.status}
              options={[
                { value: 'all' as const, label: t('queue.all') },
                ...QUEUE_STATUS_FILTERS
                  .filter(status => queue.filter.view === 'all' || status !== 'withdrawn')
                  .map(status => ({ value: status, label: status === 'withdrawn' ? t('queue.filterWithdrawn') : t(`status.${status}`) })),
              ]}
              onChange={status => setFilter({ status })}
              phoneColumns={2}
            />
          )}
        </div>
      </div>

      {failure ? <ErrorNotice error={failure} /> : null}

      {loading === 'replace' && queue.items.length === 0 ? <Loading label={t('queue.loading')} variant="list" /> : null}

      {loaded && queue.items.length === 0 && loading === 'idle' ? (
        <EmptyState
          testId="queue-empty"
          icon={<InboxIcon />}
          action={filtered ? (
            <button type="button" className="btn-secondary" onClick={() => setFilter(DEFAULT_QUEUE_FILTER)}>
              {t('queue.showAll')}
            </button>
          ) : null}
        >
          <p className="text-lg text-ink">{filtered ? t('queue.emptyFiltered') : t('queue.emptyAll')}</p>
        </EmptyState>
      ) : null}

      {queue.items.length > 0 ? (
        <div className="card overflow-x-auto p-0 sm:p-0" role="region" aria-labelledby="queue-caption" tabIndex={0}>
          <table className="data-table w-full border-collapse">
            <caption id="queue-caption" className="sr-only">{t('queue.caption')}</caption>
            <thead className="bg-surface-2">
              <tr>
                <th scope="col" className="hidden sm:table-cell">{t('queue.col.priority')}</th>
                <th scope="col">{t('queue.col.reference')}</th>
                <th scope="col" className="hidden xl:table-cell">{t('queue.col.type')}</th>
                <th scope="col" className="hidden sm:table-cell">{t('queue.col.status')}</th>
                <th scope="col" className="hidden md:table-cell">{t('queue.col.assignee')}</th>
                <th scope="col" className="hidden lg:table-cell">{t('queue.col.onward')}</th>
                <th scope="col" className="hidden lg:table-cell">{t('queue.col.received')}</th>
              </tr>
            </thead>
            <tbody>
              {queue.items.map(row => (
                <QueueRow key={row.id} row={row} myUserId={myUserId} onOpen={openRow} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {queue.items.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="meta">{t('queue.shown', { count: queue.items.length })}</p>
          {queue.nextCursor ? (
            <button type="button" className="btn-secondary" onClick={() => void load('append')} disabled={loading !== 'idle'}>
              {loading === 'append' ? <SpinnerIcon /> : null}
              {t('queue.loadMore')}
            </button>
          ) : null}
        </div>
      ) : null}

      {loading === 'append' ? <Notice tone="info" live="polite">{t('queue.loading')}</Notice> : null}
    </div>
  );
}

function OnwardLine({ row }: { row: ReferralQueueItem }) {
  const latest = row.onward.latest;
  if (row.withdrawn) return <span className="text-ink-3">—</span>;
  if (!latest) return <span className="text-sm text-ink-3">{t('onward.none')}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="queue-onward">
      <OnwardTypeIcon type={latest.type} className="h-5 w-5 shrink-0 text-ink-2" />
      <span className="font-semibold text-ink">{t(`onward.type.${latest.type}`)}</span>
      <OnwardStatusChip status={latest.status} />
      {row.onward.count > 1 ? <span className="text-sm text-ink-3">{t('onward.more', { count: row.onward.count - 1 })}</span> : null}
    </span>
  );
}

function AssigneeCell({ row, myUserId }: { row: ReferralQueueItem; myUserId: string | null }) {
  if (row.withdrawn) return <span className="text-ink-3">—</span>;
  return (
    <span className={row.assignee ? 'text-ink' : 'italic text-ink-3'} data-testid="queue-assignee">
      {assigneeText(row.assignee, myUserId)}
    </span>
  );
}

function QueueRow({ row, myUserId, onOpen }: {
  row: ReferralQueueItem;
  myUserId: string | null;
  onOpen: (event: MouseEvent<HTMLTableRowElement>, row: ReferralQueueItem) => void;
}) {
  const urgent = !row.withdrawn && row.priority === 'urgent';
  const attention = urgent && row.needsAttention;
  const status = row.withdrawn ? 'withdrawn' : row.status;
  return (
    <tr
      data-testid="queue-row"
      data-href={caseHref(row)}
      data-priority={row.withdrawn ? undefined : row.priority}
      data-attention={attention ? 'true' : undefined}
      className={urgent ? 'row-urgent' : undefined}
      onClick={event => onOpen(event, row)}
    >
      <td className="hidden sm:table-cell">
        <span className="flex flex-col items-start gap-1.5 py-1">
          {attention ? <NeedsAttention /> : null}
          {row.withdrawn ? <span className="text-ink-3">—</span> : <PriorityBadge priority={row.priority} quiet />}
        </span>
      </td>
      <td className="cell-ref">
        <Link href={caseHref(row)} className="btn-link whitespace-nowrap font-mono text-[0.9375rem] tracking-wide">
          {row.reference}
        </Link>
        {/* Phones and tablets: what the hidden columns hold, under the reference. */}
        <span className="flex flex-col gap-1.5 pb-2 text-sm text-ink-3 lg:hidden">
          {attention || urgent ? (
            <span className="flex flex-wrap items-center gap-2 sm:hidden">
              {attention ? <NeedsAttention /> : null}
              {urgent ? <PriorityBadge priority={row.priority} /> : null}
            </span>
          ) : null}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="sm:hidden">
              <StatusBadge status={status} />
            </span>
            <span className="sm:hidden">{row.pathway ? t(`pathway.${row.pathway}`) : t('pathway.hidden')} ·</span>
            <span>{formatDateTime(row.receivedAt)}</span>
          </span>
          {!row.withdrawn ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden">
              <span className="font-semibold text-ink-2">{t('queue.col.assignee')}:</span>
              <AssigneeCell row={row} myUserId={myUserId} />
            </span>
          ) : null}
          {!row.withdrawn && row.onward.latest ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-semibold text-ink-2">{t('queue.col.onward')}:</span>
              <OnwardLine row={row} />
            </span>
          ) : null}
        </span>
      </td>
      <td className="hidden whitespace-nowrap text-ink-2 xl:table-cell">{row.pathway ? t(`pathway.${row.pathway}`) : t('pathway.hidden')}</td>
      <td className="hidden sm:table-cell">
        <StatusBadge status={status} />
      </td>
      <td className="hidden md:table-cell">
        <AssigneeCell row={row} myUserId={myUserId} />
      </td>
      <td className="hidden lg:table-cell">
        <OnwardLine row={row} />
      </td>
      <td className="hidden whitespace-nowrap text-ink-2 lg:table-cell">{formatDateTime(row.receivedAt)}</td>
    </tr>
  );
}

const STATS: Array<{ key: keyof CaseSummary; label: Parameters<typeof t>[0] }> = [
  { key: 'needsAttention', label: 'queue.stat.needsAttention' },
  { key: 'newTotal', label: 'queue.stat.newTotal' },
  { key: 'inProgress', label: 'queue.stat.inProgress' },
  { key: 'unassigned', label: 'queue.stat.unassigned' },
  { key: 'mine', label: 'queue.stat.mine' },
];

/** The organisation's open caseload in five numbers, from GET /summary. */
function AtAGlance({ summary }: { summary: CaseSummary }) {
  return (
    <section aria-labelledby="glance-heading" data-testid="queue-summary">
      <h2 id="glance-heading" className="sr-only">{t('queue.atAGlance')}</h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {STATS.map(({ key, label }) => {
          const alert = key === 'needsAttention' && summary.needsAttention > 0;
          return (
            <li key={key} className={`stat ${alert ? 'stat-alert' : ''}`} data-testid={`stat-${key}`}>
              <span className="stat-value">{summary[key]}</span>
              <span className="stat-label inline-flex items-center gap-1.5">
                {alert ? <AttentionDot /> : null}
                {t(label)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function CasesPage() {
  return (
    <Layout title={t('title.cases')} section="cases">
      <RequireSession>
        <Queue />
      </RequireSession>
    </Layout>
  );
}
