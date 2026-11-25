import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clearDrafts, hasDraft, setDraft, subscribeDrafts } from '../../src/lib/drafts.ts';
import { clockFromServer, idleDeadline } from '../../src/lib/session.ts';
import { createSessionSync, parseSyncMessage, type ChannelLike, type SessionSyncHandlers } from '../../src/lib/sessionSync.ts';
import { idleExtendedTo, initialState, type AppState } from '../../src/lib/store.ts';

/** Two connected fake BroadcastChannel ends that record what was posted. */
function channelPair() {
  const posted: unknown[] = [];
  const a: ChannelLike = { onmessage: null, postMessage: message => deliver(b, message), close: () => undefined };
  const b: ChannelLike = { onmessage: null, postMessage: message => deliver(a, message), close: () => undefined };
  function deliver(to: ChannelLike, message: unknown) {
    posted.push(message);
    const copy = structuredClone(message);
    queueMicrotask(() => to.onmessage?.({ data: copy }));
  }
  return { a, b, posted };
}

function handlers(overrides: Partial<SessionSyncHandlers> = {}) {
  const seen = { activity: 0, signedOut: [] as string[], started: 0 };
  const value: SessionSyncHandlers = {
    onActivity: () => {
      seen.activity += 1;
    },
    onSignedOut: reason => {
      seen.signedOut.push(reason);
    },
    onSessionStarted: () => {
      seen.started += 1;
    },
    hasDraft: () => false,
    ...overrides,
  };
  return { value, seen };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('cross-tab session sync', () => {
  it('shares activity (throttled), sign-out and new sessions between tabs', async () => {
    const { a, b, posted } = channelPair();
    let clock = 0;
    const tabA = createSessionSync(a, handlers().value, { now: () => clock, activityThrottleMs: 5000 });
    const other = handlers();
    createSessionSync(b, other.value);
    tabA.activity();
    tabA.activity();
    clock = 4999;
    tabA.activity();
    clock = 5000;
    tabA.activity();
    tabA.signedOut('idle');
    tabA.sessionStarted();
    await tick();
    assert.equal(other.seen.activity, 2);
    assert.deepEqual(other.seen.signedOut, ['idle']);
    assert.equal(other.seen.started, 1);
    // Only fixed, content-free shapes ever go on the channel.
    assert.deepEqual(posted, [
      { type: 'activity' }, { type: 'activity' }, { type: 'signed_out', reason: 'idle' }, { type: 'session_started' },
    ]);
  });

  it('asks the other tabs about unsaved notes', async () => {
    const { a, b } = channelPair();
    const tabA = createSessionSync(a, handlers().value);
    let draftInB = false;
    createSessionSync(b, handlers({ hasDraft: () => draftInB }).value);
    assert.equal(await tabA.otherTabsHaveDraft(50), false);
    draftInB = true;
    assert.equal(await tabA.otherTabsHaveDraft(50), true);
  });

  it('works without BroadcastChannel (no channel): nothing is sent and no other tab has a draft', async () => {
    const sync = createSessionSync(null, handlers().value);
    assert.equal(sync.available, false);
    sync.activity();
    sync.signedOut('user');
    assert.equal(await sync.otherTabsHaveDraft(10), false);
  });

  it('ignores anything that is not an exact message shape', async () => {
    assert.equal(parseSyncMessage(null), null);
    assert.equal(parseSyncMessage('activity'), null);
    assert.equal(parseSyncMessage({ type: 'activity', note: 'x' }), null);
    assert.equal(parseSyncMessage({ type: 'signed_out', reason: 'because' }), null);
    assert.equal(parseSyncMessage({ type: 'draft_reply', queryId: 'zz', hasDraft: true }), null);
    assert.equal(parseSyncMessage({ type: 'draft_reply', queryId: '0123456789abcdef', hasDraft: 'yes' }), null);
    assert.deepEqual(parseSyncMessage({ type: 'signed_out', reason: 'absolute' }), { type: 'signed_out', reason: 'absolute' });
    const { a, b } = channelPair();
    const seen = handlers();
    createSessionSync(b, seen.value);
    a.postMessage({ type: 'signed_out', reason: 'idle', caseId: 'x' });
    a.postMessage({ type: 'unknown' });
    await tick();
    assert.deepEqual(seen.seen.signedOut, []);
  });
});

describe('unsaved drafts', () => {
  it('records only that a draft exists, and notifies on change', () => {
    clearDrafts();
    let changes = 0;
    const stop = subscribeDrafts(() => {
      changes += 1;
    });
    setDraft('note-1', true);
    setDraft('note-1', true);
    assert.equal(hasDraft(), true);
    setDraft('note-1', false);
    assert.equal(hasDraft(), false);
    stop();
    assert.equal(changes, 2);
  });
});

describe('idle extended from the server', () => {
  it('moves the idle limit later (never earlier, never past the absolute limit)', () => {
    const window = { idleExpiresAt: '2026-10-21T08:30:00.000Z', absoluteExpiresAt: '2026-10-21T20:00:00.000Z' };
    const clock = clockFromServer(window, 'full', 1_000_000, Date.parse('2026-10-21T08:00:00.000Z'));
    const state: AppState = { ...initialState(), auth: { status: 'signed_in', csrfToken: 'c', clock, identity: null } };
    const later = idleExtendedTo(state, 1_000_000 + 45 * 60 * 1000);
    assert.ok(later.auth.status === 'signed_in');
    assert.equal(idleDeadline(later.auth.clock), 1_000_000 + 45 * 60 * 1000);
    assert.equal(later.auth.clock.lastLocalInputAt, clock.lastLocalInputAt, 'not input: no keep-alive can follow');
    assert.equal(later.auth.clock.lastInputAt, clock.lastInputAt);
    assert.equal(idleExtendedTo(later, 1_000_000 + 10 * 60 * 1000), later, 'never earlier');
    const capped = idleExtendedTo(state, clock.absoluteAt + 60 * 60 * 1000);
    assert.ok(capped.auth.status === 'signed_in');
    assert.equal(idleDeadline(capped.auth.clock), clock.absoluteAt);
    const signedOutState = initialState({ status: 'signed_out' });
    assert.equal(idleExtendedTo(signedOutState, 5), signedOutState, 'no session, nothing to extend');
  });
});
