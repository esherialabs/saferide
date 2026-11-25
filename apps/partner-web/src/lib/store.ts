/**
 * The app's only state container: plain memory. Nothing here is written to
 * localStorage, sessionStorage, IndexedDB or cookies. Signing out replaces
 * the whole state, and the page is then reloaded so nothing survives in the
 * JavaScript heap either.
 *
 * Case details are not kept here at all: the case page holds its own copy in
 * component state and drops it when the person leaves.
 */
import type {
  AuthStepResponse, CaseSummary, MeResponse, OnwardReferral, OnwardSummary, QueueStatus, Referral, ReferralFilter, ReferralListResponse,
  ReferralQueueItem, ReferralTombstone, SessionWindow,
} from './partnerApi.ts';
import {
  clockFromServer, withExtension, withLocalInput, withRemoteInput, withServerTouch, type SessionClock,
} from './session.ts';

export type SignOutReason = 'user' | 'idle' | 'absolute' | 'expired';

export type Identity = {
  /** To tell, after a sign-in in another tab, whether it is still the same person. */
  userId: string;
  displayName: string;
  email: string;
  orgName: string;
  role: MeResponse['role'];
  /** An operator issued the password: the app shows only "Choose a new password" until it is changed. */
  mustChangePassword: boolean;
};

export type AuthState =
  | { status: 'unknown' }
  | { status: 'signed_out' }
  | { status: 'pre_mfa'; csrfToken: string; clock: SessionClock }
  | { status: 'signed_in'; csrfToken: string; clock: SessionClock; identity: Identity | null };

/**
 * The queue's quick views. "attention" is urgent and still new (what the
 * banner counts); "urgent" is every escalation.
 */
export const QUEUE_VIEWS = ['all', 'attention', 'mine', 'unassigned', 'urgent'] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];

export function isQueueView(value: unknown): value is QueueView {
  return typeof value === 'string' && (QUEUE_VIEWS as readonly string[]).includes(value);
}

export type QueueFilter = { view: QueueView; status: QueueStatus | 'all' };

export type QueueState = {
  filter: QueueFilter;
  items: ReferralQueueItem[];
  nextCursor: string | null;
  loadedAt: number | null;
};

/**
 * The attention banner's state. `chime` is a UI switch only: it lives in
 * memory, starts off, and is off again after a reload.
 */
export type AlertState = { summary: CaseSummary | null; loadedAt: number | null; chime: boolean; unavailable: boolean };

export type AppState = { auth: AuthState; queue: QueueState; alerts: AlertState };

export const DEFAULT_QUEUE_FILTER: QueueFilter = { view: 'all', status: 'all' };

export function initialState(auth: AuthState = { status: 'unknown' }): AppState {
  return {
    auth,
    queue: { filter: DEFAULT_QUEUE_FILTER, items: [], nextCursor: null, loadedAt: null },
    alerts: { summary: null, loadedAt: null, chime: false, unavailable: false },
  };
}

// --- auth transitions --------------------------------------------------------

// `serverNow` is the server's clock from the response Date header, when known.

export function passwordAccepted(_state: AppState, step: AuthStepResponse, now: number, serverNow?: number): AppState {
  return { ...initialState(), auth: { status: 'pre_mfa', csrfToken: step.csrfToken, clock: clockFromServer(step.session, 'pre_mfa', now, serverNow) } };
}

/** After the TOTP step, enrolment, a password-only sign-in or a password change: a full session whose identity /me fills in. */
export function sessionStarted(_state: AppState, step: AuthStepResponse, now: number, serverNow?: number): AppState {
  return {
    ...initialState(),
    auth: { status: 'signed_in', csrfToken: step.csrfToken, clock: clockFromServer(step.session, 'full', now, serverNow), identity: null },
  };
}

/**
 * The /me answer: identity, CSRF token and the server's expiry times. The
 * input times and any server-confirmed extension carry over: reading /me is
 * never input. `touched` is false for a background read (no activity flag),
 * which did not extend the server's idle timer.
 */
export function identityLoaded(
  state: AppState,
  me: MeResponse,
  now: number,
  serverNow?: number,
  options: { touched?: boolean } = {},
): AppState {
  const identity: Identity = {
    userId: me.user.id,
    displayName: me.user.displayName,
    email: me.user.email,
    orgName: me.org.displayName,
    role: me.role,
    mustChangePassword: me.mustChangePassword === true,
  };
  const previous = state.auth.status === 'signed_in' ? state.auth.clock : null;
  const fresh = clockFromServer(me.session, 'full', now, serverNow);
  if (previous && state.auth.status === 'signed_in' && state.auth.csrfToken === me.csrfToken && (previous.coverageEpoch ?? 0) > (fresh.coverageEpoch ?? 0)) return state;
  const touched = options.touched !== false;
  const clock: SessionClock = previous
    ? {
        ...fresh,
        lastLocalInputAt: previous.lastLocalInputAt,
        lastInputAt: previous.lastInputAt,
        extendedUntil: previous.extendedUntil,
        lastServerTouchAt: touched ? now : previous.lastServerTouchAt,
        ...(previous.coverageActive && !fresh.coverageActive ? { lastInputAt: now, lastLocalInputAt: now, lastServerTouchAt: now, extendedUntil: 0 } : {}),
        ...(previous.coverageActive && fresh.coverageActive && previous.coverageEpoch === fresh.coverageEpoch
          ? { absoluteAt: Math.max(previous.absoluteAt, fresh.absoluteAt) } : {}),
      }
    : fresh;
  return { ...state, auth: { status: 'signed_in', csrfToken: me.csrfToken, clock, identity } };
}

export function signedOut(): AppState {
  return initialState({ status: 'signed_out' });
}

/** Renew only this session; an older heartbeat cannot undo a newer mode change. */
export function coverageWindowLoaded(state: AppState, window: SessionWindow, session: string, now: number, serverNow?: number): AppState {
  const { auth } = state;
  if (auth.status !== 'signed_in' || auth.csrfToken !== session) return state;
  const previous = auth.clock;
  if ((window.coverageEpoch ?? 0) < (previous.coverageEpoch ?? 0)) return state;
  const fresh = clockFromServer(window, 'full', now, serverNow);
  return { ...state, auth: { ...auth, clock: { ...previous,
    coverageActive: fresh.coverageActive, coverageEpoch: fresh.coverageEpoch,
    absoluteAt: fresh.coverageActive && previous.coverageActive && fresh.coverageEpoch === previous.coverageEpoch
      ? Math.max(previous.absoluteAt, fresh.absoluteAt) : fresh.absoluteAt,
    // Turning coverage off starts a fresh normal idle window, not the old pre-shift one.
    ...(previous.coverageActive && !fresh.coverageActive ? { lastInputAt: now, lastLocalInputAt: now, lastServerTouchAt: now, extendedUntil: 0 } : {}),
  } } };
}

/** This tab's own real input (keyboard or pointer). */
export function activityRecorded(state: AppState, now: number): AppState {
  const { auth } = state;
  if (auth.status !== 'signed_in' && auth.status !== 'pre_mfa') return state;
  const clock = withLocalInput(auth.clock, now);
  return clock === auth.clock ? state : { ...state, auth: { ...auth, clock } };
}

/** Real input in another tab, reported over the tab channel: counts for idleness only. */
export function remoteActivityRecorded(state: AppState, now: number): AppState {
  const { auth } = state;
  if (auth.status !== 'signed_in') return state;
  const clock = withRemoteInput(auth.clock, now);
  return clock === auth.clock ? state : { ...state, auth: { ...auth, clock } };
}

/**
 * The server confirmed the shared session stays in use until `deadline`
 * (client clock) because of activity in another tab: this tab's idle limit
 * moves there. It is not input, so it never leads to a keep-alive. It never
 * moves earlier and never past the absolute limit.
 */
export function idleExtendedTo(state: AppState, deadline: number): AppState {
  const { auth } = state;
  if (auth.status !== 'signed_in') return state;
  const clock = withExtension(auth.clock, deadline);
  return clock === auth.clock ? state : { ...state, auth: { ...auth, clock } };
}

export function serverTouched(state: AppState, now: number): AppState {
  const { auth } = state;
  if (auth.status !== 'signed_in') return state;
  const clock = withServerTouch(auth.clock, now);
  return clock === auth.clock ? state : { ...state, auth: { ...auth, clock } };
}

export function csrfTokenOf(state: AppState): string | null {
  return state.auth.status === 'signed_in' || state.auth.status === 'pre_mfa' ? state.auth.csrfToken : null;
}

// --- queue -------------------------------------------------------------------

function byNewest(a: ReferralQueueItem, b: ReferralQueueItem): number {
  const diff = Date.parse(b.receivedAt) - Date.parse(a.receivedAt);
  return diff !== 0 ? diff : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Newest first, one row per ID (a later page wins). */
export function mergeQueue(existing: ReferralQueueItem[], incoming: ReferralQueueItem[]): ReferralQueueItem[] {
  const rows = new Map<string, ReferralQueueItem>();
  for (const row of existing) rows.set(row.id, row);
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()].sort(byNewest);
}

function sameFilter(a: QueueFilter, b: QueueFilter): boolean {
  return a.view === b.view && a.status === b.status;
}

/** "Needs attention" is urgent and new, so it sets the status itself. */
export function effectiveStatus(filter: QueueFilter): QueueStatus | 'all' {
  return filter.view === 'attention' ? 'new' : filter.status;
}

/** The API query for a queue filter. */
export function apiFilterFor(filter: QueueFilter, cursor?: string): ReferralFilter {
  const status = effectiveStatus(filter);
  return {
    status: status === 'all' ? undefined : status,
    priority: filter.view === 'attention' || filter.view === 'urgent' ? 'urgent' : undefined,
    assignee: filter.view === 'mine' ? 'me' : filter.view === 'unassigned' ? 'unassigned' : undefined,
    cursor,
  };
}

/** Whether a row belongs in the queue under this filter (`userId` is the signed-in person). */
export function rowMatchesFilter(row: ReferralQueueItem, filter: QueueFilter, userId: string | null): boolean {
  const status = effectiveStatus(filter);
  const rowStatus: QueueStatus = row.withdrawn ? 'withdrawn' : row.status;
  if (status !== 'all' && status !== rowStatus) return false;
  if (filter.view === 'all') return true;
  // The case-management views only ever list cases still shared.
  if (row.withdrawn) return false;
  switch (filter.view) {
    case 'attention':
      return row.priority === 'urgent' && row.needsAttention;
    case 'urgent':
      return row.priority === 'urgent';
    case 'mine':
      return userId !== null && row.assignee?.id === userId;
    case 'unassigned':
      return row.assignee === null;
  }
}

export function queueFilterChanged(state: AppState, filter: QueueFilter): AppState {
  if (sameFilter(state.queue.filter, filter) && state.queue.loadedAt === null) return state;
  return { ...state, queue: { filter, items: [], nextCursor: null, loadedAt: null } };
}

/**
 * replace: a fresh first page. append: the next page ("Load more").
 * refresh: the first page fetched in the background; it adds new rows and
 * updates known ones but keeps the rows and cursor of pages already loaded.
 */
export function queueLoaded(
  state: AppState,
  filter: QueueFilter,
  page: ReferralListResponse,
  mode: 'replace' | 'append' | 'refresh',
  now: number,
): AppState {
  // A response for a filter the person has since left is dropped.
  if (!sameFilter(state.queue.filter, filter)) return state;
  const rows = Array.isArray(page.referrals) ? page.referrals : [];
  const items = mode === 'replace' ? mergeQueue([], rows) : mergeQueue(state.queue.items, rows);
  const nextCursor = mode === 'refresh' && state.queue.loadedAt !== null ? state.queue.nextCursor : page.nextCursor;
  return { ...state, queue: { filter, items, nextCursor, loadedAt: now } };
}

/** A queue row's onward summary from a case's full list: the count and the newest one. */
export function onwardSummaryOf(onward: OnwardReferral[]): OnwardSummary {
  if (onward.length === 0) return { count: 0, latest: null };
  const newest = [...onward].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]!;
  return { count: onward.length, latest: { type: newest.type, status: newest.status } };
}

/** A queue row as the case page knows it: the onward summary only when it has the case's list. */
export type QueueRowUpdate = Omit<ReferralQueueItem, 'onward'> & { onward?: OnwardSummary };

/**
 * The queue row for an open referral (only queue fields are kept). Without
 * the case's onward list, the row keeps the onward summary it had.
 */
export function queueItemOf(referral: Referral, onward?: OnwardReferral[]): QueueRowUpdate {
  const row: QueueRowUpdate = {
    id: referral.id,
    reference: referral.reference,
    pathway: referral.pathway,
    status: referral.status,
    withdrawn: false,
    receivedAt: referral.receivedAt,
    statusChangedAt: referral.statusChangedAt,
    priority: referral.priority,
    needsAttention: referral.needsAttention,
    assignee: referral.assignee,
  };
  if (onward) row.onward = onwardSummaryOf(onward);
  return row;
}

/** The queue row for a withdrawn referral: nothing beyond "no longer shared". */
export function queueItemOfTombstone(tombstone: ReferralTombstone): ReferralQueueItem {
  return {
    id: tombstone.id,
    reference: tombstone.reference,
    pathway: null,
    status: 'withdrawn',
    withdrawn: true,
    receivedAt: tombstone.receivedAt,
    statusChangedAt: tombstone.withdrawnAt,
    priority: 'normal',
    needsAttention: false,
    assignee: null,
    onward: { count: 0, latest: null },
  };
}

function signedInUserId(state: AppState): string | null {
  return state.auth.status === 'signed_in' ? state.auth.identity?.userId ?? null : null;
}

/** Keeps the queue row in step with what the case page learned (status, assignee, onward referrals, withdrawal). */
export function queueRowUpdated(state: AppState, row: QueueRowUpdate): AppState {
  const existing = state.queue.items.find(item => item.id === row.id);
  if (!existing) return state;
  const merged: ReferralQueueItem = { ...row, onward: row.onward ?? existing.onward };
  const items = rowMatchesFilter(merged, state.queue.filter, signedInUserId(state))
    ? state.queue.items.map(item => (item.id === row.id ? merged : item))
    : state.queue.items.filter(item => item.id !== row.id);
  return { ...state, queue: { ...state.queue, items } };
}

// --- attention -----------------------------------------------------------------

export function summaryLoaded(state: AppState, summary: CaseSummary, now: number): AppState {
  if (state.auth.status !== 'signed_in') return state;
  return { ...state, alerts: { ...state.alerts, summary, loadedAt: now, unavailable: false } };
}

export function summaryUnavailable(state: AppState): AppState {
  return state.auth.status === 'signed_in' ? { ...state, alerts: { ...state.alerts, unavailable: true } } : state;
}

export function chimeSet(state: AppState, on: boolean): AppState {
  return state.alerts.chime === on ? state : { ...state, alerts: { ...state.alerts, chime: on } };
}

/** How many urgent cases need attention (0 until the first summary arrives). */
export function attentionCount(state: AppState): number {
  return state.alerts.summary?.needsAttention ?? 0;
}

// --- container -----------------------------------------------------------------

export type Store = {
  get(): AppState;
  update(change: (state: AppState) => AppState): void;
  subscribe(listener: () => void): () => void;
};

export function createStore(start: AppState = initialState()): Store {
  let state = start;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    update(change) {
      const next = change(state);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
