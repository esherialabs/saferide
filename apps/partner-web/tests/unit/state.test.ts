import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MeResponse, Referral, ReferralQueueItem } from '../../src/lib/partnerApi.ts';
import {
  IDLE_WARNING_MS, clockFromServer, idleDeadline, keepAliveBlocksIdleCheck, keepAliveDue, serverExtension, sessionPhase,
  withExtension, withLocalInput, withRemoteInput, withServerTouch, type SessionClock,
} from '../../src/lib/session.ts';
import { REQUEST_TIMEOUT_MS } from '../../src/lib/partnerApi.ts';
import {
  activityRecorded, coverageWindowLoaded, createStore, csrfTokenOf, identityLoaded, initialState, mergeQueue, passwordAccepted, queueFilterChanged,
  queueItemOf, queueItemOfTombstone, queueLoaded, queueRowUpdated, sessionStarted, signedOut, type AppState,
} from '../../src/lib/store.ts';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const SERVER_NOW = Date.parse('2026-10-21T08:00:00Z');
const CLIENT_NOW = 5_000_000; // a different, skewed client clock

function windowAt(serverNow: number, idleMs: number, absoluteMs: number) {
  return {
    idleExpiresAt: new Date(Math.min(serverNow + idleMs, serverNow + absoluteMs)).toISOString(),
    absoluteExpiresAt: new Date(serverNow + absoluteMs).toISOString(),
  };
}

function row(id: string, receivedHoursAgo: number, extra: Partial<ReferralQueueItem> = {}): ReferralQueueItem {
  const at = new Date(SERVER_NOW - receivedHoursAgo * HOUR).toISOString();
  return {
    id, reference: `SR-${id}`, pathway: 'referral', status: 'new', withdrawn: false, receivedAt: at, statusChangedAt: at,
    priority: 'normal', needsAttention: false, assignee: null, onward: { count: 0, latest: null }, ...extra,
  };
}

function referral(id: string, receivedHoursAgo: number, extra: Partial<Referral> = {}): Referral {
  const at = new Date(SERVER_NOW - receivedHoursAgo * HOUR).toISOString();
  return {
    id, reference: `SR-${id}`, pathway: 'referral', status: 'new', closureReason: null, withdrawn: false, receivedAt: at,
    statusChangedAt: at, callbackShared: true, allowedTransitions: ['acknowledged', 'closed'],
    priority: 'normal', needsAttention: false, assignee: null, ...extra,
  };
}

const me: MeResponse = {
  user: { id: 'u1', email: 'amina@huria.test', displayName: 'Amina' },
  org: { id: 'o1', stableId: 'ke-coast-huria', displayName: 'HURIA' },
  role: 'partner_caseworker',
  csrfToken: 'csrf-me',
  session: windowAt(SERVER_NOW, 30 * MIN, 12 * HOUR),
};

describe('session clock', () => {
  it('coverage removes idle expiry but retains the bounded disconnected lease', () => {
    const clock = clockFromServer({ ...windowAt(SERVER_NOW, 12 * HOUR, 12 * HOUR), coverageActive: true, coverageEpoch: 1 }, 'full', CLIENT_NOW, SERVER_NOW);
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 11 * HOUR), { phase: 'active' });
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 12 * HOUR), { phase: 'expired', reason: 'absolute' });
    assert.equal(clockFromServer({ ...windowAt(SERVER_NOW, 12 * HOUR, 12 * HOUR), coverageActive: true }, 'full', CLIENT_NOW).absoluteAt, CLIENT_NOW + 12 * HOUR);
  });

  it('a late heartbeat or identity response cannot restore coverage after it was stopped', () => {
    let state = identityLoaded(initialState(), me, CLIENT_NOW, SERVER_NOW);
    const enabled = { ...windowAt(SERVER_NOW, 12 * HOUR, 12 * HOUR), coverageActive: true, coverageEpoch: 1 };
    state = coverageWindowLoaded(state, enabled, me.csrfToken, CLIENT_NOW, SERVER_NOW);
    const disabled = { ...windowAt(SERVER_NOW + HOUR, 30 * MIN, 12 * HOUR), coverageActive: false, coverageEpoch: 2 };
    state = coverageWindowLoaded(state, disabled, me.csrfToken, CLIENT_NOW + HOUR, SERVER_NOW + HOUR);
    assert.equal(coverageWindowLoaded(state, enabled, me.csrfToken, CLIENT_NOW + HOUR, SERVER_NOW), state);
    assert.equal(identityLoaded(state, { ...me, session: enabled }, CLIENT_NOW + HOUR, SERVER_NOW), state);
    assert.equal(coverageWindowLoaded(state, enabled, 'different-session', CLIENT_NOW, SERVER_NOW), state);
    assert.equal(state.auth.status === 'signed_in' && idleDeadline(state.auth.clock), CLIENT_NOW + HOUR + 30 * MIN);
  });
  it('carries durations over to a skewed client clock', () => {
    const clock = clockFromServer(windowAt(SERVER_NOW, 30 * MIN, 12 * HOUR), 'full', CLIENT_NOW, SERVER_NOW);
    assert.equal(clock.absoluteAt, CLIENT_NOW + 12 * HOUR);
    assert.equal(idleDeadline(clock), CLIENT_NOW + 30 * MIN);
  });

  it('recovers the server clock from the idle expiry when no Date header was seen', () => {
    const clock = clockFromServer(windowAt(SERVER_NOW, 30 * MIN, 3 * HOUR), 'full', CLIENT_NOW);
    assert.equal(clock.absoluteAt, CLIENT_NOW + 3 * HOUR);
  });

  it('uses the server clock when the idle expiry is capped by the absolute one', () => {
    const capped = windowAt(SERVER_NOW, 30 * MIN, 10 * MIN);
    assert.equal(clockFromServer(capped, 'full', CLIENT_NOW, SERVER_NOW).absoluteAt, CLIENT_NOW + 10 * MIN);
  });

  it('warns 2 minutes before the idle limit and expires at it', () => {
    const clock = clockFromServer(windowAt(SERVER_NOW, 30 * MIN, 12 * HOUR), 'full', CLIENT_NOW, SERVER_NOW);
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 27 * MIN), { phase: 'active' });
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 30 * MIN - IDLE_WARNING_MS), { phase: 'warning', reason: 'idle', endsAt: CLIENT_NOW + 30 * MIN });
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 30 * MIN), { phase: 'expired', reason: 'idle' });
    // Input at 29 min with its keep-alive: the limit moves to 59 min.
    const active = withServerTouch(withLocalInput(clock, CLIENT_NOW + 29 * MIN), CLIENT_NOW + 29 * MIN);
    assert.deepEqual(sessionPhase(active, CLIENT_NOW + 30 * MIN), { phase: 'active' });
    // Without a keep-alive, the server's deadline (last request + 30) still binds this tab.
    const unsent = withLocalInput(clock, CLIENT_NOW + 29 * MIN);
    assert.deepEqual(sessionPhase(unsent, CLIENT_NOW + 30 * MIN), { phase: 'expired', reason: 'idle' });
  });

  it('warns 5 minutes before the absolute limit and ends there even when active', () => {
    let clock = clockFromServer(windowAt(SERVER_NOW, 30 * MIN, 20 * MIN), 'full', CLIENT_NOW, SERVER_NOW);
    clock = withLocalInput(clock, CLIENT_NOW + 14 * MIN);
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 14 * MIN), { phase: 'active' });
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 16 * MIN), { phase: 'warning', reason: 'absolute', endsAt: CLIENT_NOW + 20 * MIN });
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 20 * MIN), { phase: 'expired', reason: 'absolute' });
  });

  it('expires a pre-MFA session after 5 minutes without warning', () => {
    const clock = clockFromServer(windowAt(SERVER_NOW, 5 * MIN, 5 * MIN), 'pre_mfa', CLIENT_NOW, SERVER_NOW);
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 4 * MIN), { phase: 'active' });
    assert.deepEqual(sessionPhase(clock, CLIENT_NOW + 5 * MIN).phase, 'expired');
  });

  it('sends a keep-alive only on input, and only when the server last heard from this tab 2+ minutes ago', () => {
    const clock = clockFromServer(windowAt(SERVER_NOW, 30 * MIN, 12 * HOUR), 'full', CLIENT_NOW, SERVER_NOW);
    assert.equal(keepAliveDue(clock, CLIENT_NOW + 1 * MIN), false, 'server touched too recently');
    assert.equal(keepAliveDue(clock, CLIENT_NOW + 2 * MIN), true);
    assert.equal(keepAliveDue(withServerTouch(clock, CLIENT_NOW + 2 * MIN), CLIENT_NOW + 3 * MIN), false);
    const preMfa = clockFromServer(windowAt(SERVER_NOW, 5 * MIN, 5 * MIN), 'pre_mfa', CLIENT_NOW, SERVER_NOW);
    assert.equal(keepAliveDue(preMfa, CLIENT_NOW + 20 * MIN), false);
  });

  it('waits for a keep-alive on its way only as long as a request can take', () => {
    assert.equal(keepAliveBlocksIdleCheck(null, CLIENT_NOW), false);
    assert.equal(keepAliveBlocksIdleCheck(CLIENT_NOW, CLIENT_NOW + 1000), true);
    assert.equal(keepAliveBlocksIdleCheck(CLIENT_NOW, CLIENT_NOW + REQUEST_TIMEOUT_MS + 1000), false, 'a hung keep-alive stops blocking');
  });

  it("counts another tab's input for idleness but never as this tab's input", () => {
    const clock = clockFromServer(windowAt(SERVER_NOW, 30 * MIN, 12 * HOUR), 'full', CLIENT_NOW, SERVER_NOW);
    const remote = withRemoteInput(clock, CLIENT_NOW + 20 * MIN);
    assert.equal(idleDeadline(remote), CLIENT_NOW + 50 * MIN);
    assert.equal(remote.lastLocalInputAt, CLIENT_NOW);
  });

  it('extends from the server only beyond what this tab\'s own requests explain', () => {
    // This tab's last interactive request (a keep-alive) was at 10 min, so the server's deadline of 40 min is its own doing.
    let clock = clockFromServer(windowAt(SERVER_NOW, 30 * MIN, 12 * HOUR), 'full', CLIENT_NOW, SERVER_NOW);
    clock = withLocalInput(clock, CLIENT_NOW + 5 * MIN);
    clock = withServerTouch(clock, CLIENT_NOW + 10 * MIN);
    assert.equal(serverExtension(clock, CLIENT_NOW + 40 * MIN + 1000, CLIENT_NOW + 35 * MIN), null);
    // Another tab made an interactive request at 30 min: deadline 60 min, later than 40 + margin.
    assert.equal(serverExtension(clock, CLIENT_NOW + 60 * MIN, CLIENT_NOW + 35 * MIN), CLIENT_NOW + 60 * MIN);
    // Too little time left either way.
    assert.equal(serverExtension(clock, CLIENT_NOW + 35 * MIN + 30_000, CLIENT_NOW + 35 * MIN), null);
    const extended = withExtension(clock, CLIENT_NOW + 60 * MIN);
    assert.equal(extended.lastLocalInputAt, clock.lastLocalInputAt, 'an extension is not input');
    assert.equal(extended.lastInputAt, clock.lastInputAt);
    assert.equal(idleDeadline(extended), CLIENT_NOW + 60 * MIN);
  });

  /**
   * Simulates the SessionManager rules minute by minute for one tab with a
   * single real input and nothing after it: keep-alives only at that input;
   * the idle check extends only via serverExtension; the server's idle
   * deadline follows interactive requests only.
   */
  function replaySingleInput(inputMinute: number) {
    let clock: SessionClock = clockFromServer(windowAt(SERVER_NOW, 30 * MIN, 12 * HOUR), 'full', CLIENT_NOW, SERVER_NOW);
    let serverIdleDeadline = CLIENT_NOW + 30 * MIN;
    const interactiveAt: number[] = [];
    const input = CLIENT_NOW + inputMinute * MIN;
    clock = withLocalInput(clock, input);
    if (keepAliveDue(clock, input)) {
      interactiveAt.push(input);
      clock = withServerTouch(clock, input + 1000); // the response arrives a moment later
      serverIdleDeadline = input + 30 * MIN;
    }
    let signedOutAt: number | null = null;
    for (let minute = inputMinute + 1; minute <= 12 * 60 && signedOutAt === null; minute += 1) {
      const now = CLIENT_NOW + minute * MIN;
      if (sessionPhase(clock, now).phase !== 'expired') continue;
      const extension = serverIdleDeadline > now ? serverExtension(clock, serverIdleDeadline, now) : null;
      if (extension === null) signedOutAt = now;
      else clock = withExtension(clock, extension);
    }
    return { signedOutAt, interactiveAt, input };
  }

  it('replays the reported loop: one input at 5 min, then nothing, ends at 35 min (regression)', () => {
    const { signedOutAt, interactiveAt, input } = replaySingleInput(5);
    assert.deepEqual(interactiveAt, [input], 'only the keep-alive at the input itself');
    assert.equal(signedOutAt, CLIENT_NOW + 35 * MIN);
  });

  it('an input soon after the last request sends nothing; the server deadline then ends the tab at 30 min', () => {
    const { signedOutAt, interactiveAt } = replaySingleInput(1);
    assert.deepEqual(interactiveAt, []);
    assert.equal(signedOutAt, CLIENT_NOW + 30 * MIN);
  });

  it('never stays signed in more than 30 minutes after the last real input, wherever that input lands', () => {
    for (let minute = 0; minute <= 40; minute += 1) {
      const { signedOutAt, input } = replaySingleInput(minute);
      assert.ok(signedOutAt !== null && signedOutAt <= input + 30 * MIN && signedOutAt >= input + 28 * MIN, `input at ${minute} min`);
    }
  });
});

describe('app state (memory only)', () => {
  const step = { mfaRequired: true, csrfToken: 'csrf-pre', session: windowAt(SERVER_NOW, 5 * MIN, 5 * MIN) };

  function signedInWithQueue(): AppState {
    let state = sessionStarted(initialState(), { ...step, mfaRequired: false, csrfToken: 'csrf-full', session: me.session }, CLIENT_NOW, SERVER_NOW);
    state = identityLoaded(state, me, CLIENT_NOW, SERVER_NOW);
    return queueLoaded(state, state.queue.filter, { referrals: [row('a', 1), row('b', 2)], nextCursor: 'c2' }, 'replace', CLIENT_NOW);
  }

  it('moves from password to MFA to signed in, holding only the CSRF token', () => {
    let state = passwordAccepted(initialState(), step, CLIENT_NOW, SERVER_NOW);
    assert.equal(state.auth.status, 'pre_mfa');
    assert.equal(csrfTokenOf(state), 'csrf-pre');
    state = sessionStarted(state, { ...step, mfaRequired: false, csrfToken: 'csrf-full' }, CLIENT_NOW, SERVER_NOW);
    assert.equal(state.auth.status, 'signed_in');
    assert.equal(csrfTokenOf(state), 'csrf-full');
    state = identityLoaded(state, me, CLIENT_NOW + 1000, SERVER_NOW + 1000);
    assert.ok(state.auth.status === 'signed_in' && state.auth.identity?.displayName === 'Amina');
    assert.equal(csrfTokenOf(state), 'csrf-me');
  });

  it('signs straight in when the org has MFA off and remembers that the password must change', () => {
    let state = sessionStarted(initialState(), { ...step, mfaRequired: false, mustChangePassword: true, csrfToken: 'csrf-full', session: me.session }, CLIENT_NOW, SERVER_NOW);
    assert.equal(state.auth.status, 'signed_in');
    state = identityLoaded(state, { ...me, mustChangePassword: true }, CLIENT_NOW, SERVER_NOW);
    assert.ok(state.auth.status === 'signed_in' && state.auth.identity?.mustChangePassword === true);
    // An older API without the field reads as "no change needed".
    const { mustChangePassword: _ignored, ...older } = { ...me, mustChangePassword: false };
    state = identityLoaded(state, older, CLIENT_NOW, SERVER_NOW);
    assert.ok(state.auth.status === 'signed_in' && state.auth.identity?.mustChangePassword === false);
  });

  it('a background /me does not count as the person being active', () => {
    let state = signedInWithQueue();
    state = activityRecorded(state, CLIENT_NOW + 5 * MIN);
    state = identityLoaded(state, me, CLIENT_NOW + 20 * MIN, SERVER_NOW + 20 * MIN);
    assert.ok(state.auth.status === 'signed_in');
    assert.equal(state.auth.clock.lastInputAt, CLIENT_NOW + 5 * MIN);
    assert.equal(state.auth.clock.lastLocalInputAt, CLIENT_NOW + 5 * MIN);
  });

  it('signing out drops the session, identity and every queue row', () => {
    const before = signedInWithQueue();
    assert.equal(before.queue.items.length, 2);
    const after = signedOut();
    assert.deepEqual(after.auth, { status: 'signed_out' });
    assert.deepEqual(after.queue.items, []);
    assert.equal(after.queue.nextCursor, null);
    assert.equal(csrfTokenOf(after), null);
  });

  it('a new sign-in never inherits the previous queue', () => {
    const state = passwordAccepted(signedInWithQueue(), step, CLIENT_NOW, SERVER_NOW);
    assert.deepEqual(state.queue.items, []);
  });

  it('orders the queue newest first, one row per ID', () => {
    const merged = mergeQueue([row('old', 10), row('mid', 5)], [row('new', 1), row('mid', 5, { status: 'closed' })]);
    assert.deepEqual(merged.map(item => item.id), ['new', 'mid', 'old']);
    assert.equal(merged[1]?.status, 'closed');
  });

  it('replaces, appends and refreshes pages', () => {
    let state = signedInWithQueue();
    state = queueLoaded(state, state.queue.filter, { referrals: [row('c', 3)], nextCursor: null }, 'append', CLIENT_NOW);
    assert.deepEqual(state.queue.items.map(item => item.id), ['a', 'b', 'c']);
    assert.equal(state.queue.nextCursor, null);
    // A background refresh of page one adds new rows and keeps later pages and the cursor.
    state = queueLoaded(state, state.queue.filter, { referrals: [row('z', 0.5), row('a', 1)], nextCursor: 'c2' }, 'refresh', CLIENT_NOW + MIN);
    assert.deepEqual(state.queue.items.map(item => item.id), ['z', 'a', 'b', 'c']);
    assert.equal(state.queue.nextCursor, null);
    state = queueLoaded(state, state.queue.filter, { referrals: [row('a', 1)], nextCursor: 'c9' }, 'replace', CLIENT_NOW + 2 * MIN);
    assert.deepEqual(state.queue.items.map(item => item.id), ['a']);
    assert.equal(state.queue.nextCursor, 'c9');
  });

  it('drops a response for a filter the person has left', () => {
    const state = queueFilterChanged(signedInWithQueue(), { view: 'all', status: 'closed' });
    assert.deepEqual(state.queue.items, []);
    const stale = queueLoaded(state, { view: 'all', status: 'all' }, { referrals: [row('a', 1)], nextCursor: null }, 'replace', CLIENT_NOW);
    assert.equal(stale, state);
    const otherView = queueLoaded(state, { view: 'mine', status: 'closed' }, { referrals: [row('a', 1)], nextCursor: null }, 'replace', CLIENT_NOW);
    assert.equal(otherView, state);
  });

  it('updates a queue row after a status change or withdrawal, keeping only queue fields', () => {
    let state = signedInWithQueue();
    state = queueRowUpdated(state, queueItemOf(referral('a', 1, { status: 'acknowledged' })));
    assert.equal(state.queue.items[0]?.status, 'acknowledged');
    assert.ok(!('callbackShared' in (state.queue.items[0] ?? {})));
    assert.ok(!('allowedTransitions' in (state.queue.items[0] ?? {})));
    state = queueRowUpdated(state, queueItemOfTombstone({
      id: 'b', reference: 'SR-b', status: 'withdrawn', withdrawn: true, receivedAt: row('b', 2).receivedAt, withdrawnAt: row('b', 0).receivedAt,
    }));
    assert.deepEqual(state.queue.items[1], { ...row('b', 2), pathway: null, status: 'withdrawn', withdrawn: true, statusChangedAt: row('b', 0).receivedAt });
    state = queueFilterChanged(state, { view: 'all', status: 'new' });
    state = queueLoaded(state, state.queue.filter, { referrals: [row('c', 3)], nextCursor: null }, 'replace', CLIENT_NOW);
    state = queueRowUpdated(state, queueItemOf(referral('c', 3, { status: 'acknowledged' })));
    assert.deepEqual(state.queue.items, [], 'a row that no longer matches the filter leaves the list');
  });

  it('notifies subscribers only on real changes', () => {
    const store = createStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.update(state => state);
    store.update(() => signedOut());
    unsubscribe();
    store.update(() => initialState());
    assert.equal(calls, 1);
  });
});
