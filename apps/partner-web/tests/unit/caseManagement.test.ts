import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FAVICON, FAVICON_ALERT, faviconFor, shouldChime, summaryPollDue, titleWithCount,
} from '../../src/lib/attentionRules.ts';
import {
  BACKGROUND_REFRESH_MIN_MS, ONWARD_LIMITS, ONWARD_TRANSITIONS, ONWARD_TYPES, PARTNER_ACTIVITY_HEADER, PARTNER_CSRF_HEADER, PartnerApiError,
  SAFERIDE_ACTOR_ID, createPartnerApi, currentAssigneeOf, errorReason, isSafeRideActor, nextOnwardStatuses, stripControlCharacters, normaliseQueueItem, normaliseSummary, onwardInputProblems, onwardRequestBody, referralListQuery,
  type MeResponse, type OnwardReferral, type Referral, type ReferralQueueItem,
} from '../../src/lib/partnerApi.ts';
import {
  DEFAULT_QUEUE_FILTER, apiFilterFor, attentionCount, chimeSet, effectiveStatus, identityLoaded, initialState, isQueueView, onwardSummaryOf,
  queueFilterChanged, queueItemOf, queueLoaded, queueRowUpdated, rowMatchesFilter, sessionStarted, signedOut, summaryLoaded, type AppState,
  type QueueFilter,
} from '../../src/lib/store.ts';

const REF = '7d0c3a52-4c8e-4f7a-9b1d-2e6f8a9c0b11';
const ONWARD = '0e0e0000-0000-4000-8000-000000000001';
const AT = '2026-10-22T08:00:00.000Z';
const AMINA = { id: 'u1', name: 'Amina' };
const JUMA = { id: 'u2', name: 'Juma' };

type Call = { url: string; init: RequestInit };

function client(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return new Response(next.status === 204 ? null : JSON.stringify(next.body ?? {}), { status: next.status });
  }) as typeof fetch;
  const api = createPartnerApi({ fetch: fetchImpl, getCsrfToken: () => 'csrf-1', onSessionExpired: () => undefined, now: () => 0 });
  return { api, calls };
}

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}

function row(id: string, extra: Partial<ReferralQueueItem> = {}): ReferralQueueItem {
  return {
    id, reference: `SR-${id}`, pathway: 'referral', status: 'new', withdrawn: false, receivedAt: AT, statusChangedAt: AT,
    priority: 'normal', needsAttention: false, assignee: null, onward: { count: 0, latest: null }, ...extra,
  };
}

function referral(extra: Partial<Referral> = {}): Referral {
  return {
    id: 'a', reference: 'SR-a', pathway: 'escalation', status: 'new', closureReason: null, withdrawn: false, receivedAt: AT,
    statusChangedAt: AT, callbackShared: false, allowedTransitions: ['acknowledged', 'closed'], priority: 'urgent', needsAttention: true,
    assignee: null, ...extra,
  };
}

function onward(id: string, createdAt: string, extra: Partial<OnwardReferral> = {}): OnwardReferral {
  return {
    id, type: 'police', organisation: null, contactRole: null, externalReference: null, note: null, status: 'planned', createdAt,
    createdBy: AMINA, statusChangedAt: createdAt, allowedTransitions: ['made', 'cancelled'], ...extra,
  };
}

const me: MeResponse = {
  user: { id: 'u1', email: 'amina@huria.test', displayName: 'Amina' },
  org: { id: 'o1', stableId: 'ke-coast-huria', displayName: 'HURIA' },
  role: 'partner_caseworker',
  csrfToken: 'csrf-me',
  session: { idleExpiresAt: '2026-10-22T08:30:00.000Z', absoluteExpiresAt: '2026-10-22T20:00:00.000Z' },
};

function signedIn(rows: ReferralQueueItem[], filter: QueueFilter = DEFAULT_QUEUE_FILTER): AppState {
  let state = sessionStarted(initialState(), { mfaRequired: false, csrfToken: 'c', session: me.session }, 0);
  state = identityLoaded(state, me, 0);
  state = queueFilterChanged(state, filter);
  return queueLoaded(state, filter, { referrals: rows, nextCursor: null }, 'replace', 0);
}

describe('case-management client (contract)', () => {
  it('sends the assignee and priority filters', () => {
    assert.equal(referralListQuery({ assignee: 'me', priority: 'urgent', status: 'new' }), '?status=new&assignee=me&priority=urgent');
    assert.equal(referralListQuery({ assignee: 'unassigned' }), '?assignee=unassigned');
    assert.equal(referralListQuery({ assignee: 'usr_123' }), '?assignee=usr_123');
  });

  it('fills in case-management fields a row lacks, and shows none for a row no longer shared', async () => {
    const { api } = client([{
      status: 200,
      body: {
        referrals: [
          { id: 'a', reference: 'SR-a', pathway: 'escalation', status: 'new', withdrawn: false, receivedAt: AT, statusChangedAt: AT },
          {
            id: 'b', reference: 'SR-b', pathway: null, status: 'withdrawn', withdrawn: true, receivedAt: AT, statusChangedAt: AT,
            priority: 'urgent', needsAttention: true, assignee: JUMA, onward: { count: 2, latest: { type: 'police', status: 'made' } },
          },
          {
            id: 'c', reference: 'SR-c', pathway: 'referral', status: 'in_progress', withdrawn: false, receivedAt: AT, statusChangedAt: AT,
            priority: 'normal', needsAttention: false, assignee: JUMA, onward: { count: 1, latest: { type: 'teleport', status: 'made' } },
          },
        ],
        nextCursor: null,
      },
    }]);
    const page = await api.listReferrals();
    assert.deepEqual(page.referrals.map(item => [item.priority, item.needsAttention, item.assignee, item.onward]), [
      ['urgent', false, null, { count: 0, latest: null }],
      ['normal', false, null, { count: 0, latest: null }],
      ['normal', false, JUMA, { count: 1, latest: null }],
    ]);
  });

  it('reads the summary in the background: no activity flag, so polling never extends the idle timer', async () => {
    const { api, calls } = client([{ status: 200, body: { needsAttention: 2, newTotal: 3, inProgress: 1, unassigned: 4, mine: 1 } }]);
    assert.deepEqual(await api.summary(), { needsAttention: 2, newTotal: 3, inProgress: 1, unassigned: 4, mine: 1 });
    assert.equal(calls[0]?.url, '/partner/v1/summary');
    assert.equal(header(calls[0]!, PARTNER_ACTIVITY_HEADER), undefined);
  });

  it('refuses a malformed summary instead of showing a false all-clear', () => {
    assert.throws(() => normaliseSummary({ needsAttention: -1, newTotal: '3', inProgress: 2.7, mine: null }), PartnerApiError);
    assert.throws(() => normaliseSummary(null), PartnerApiError);
  });

  it('asks for staff interactively (the person opened the picker)', async () => {
    const { api, calls } = client([{ status: 200, body: { staff: [{ id: 'u1', name: 'Amina', role: 'partner_caseworker' }, { id: 3 }] } }]);
    assert.deepEqual(await api.staff(), [{ id: 'u1', name: 'Amina', role: 'partner_caseworker' }]);
    assert.equal(calls[0]?.url, '/partner/v1/staff');
    assert.equal(header(calls[0]!, PARTNER_ACTIVITY_HEADER), 'interactive');
  });

  it('assigns with the expected assignee and the CSRF header, and reports a stale assignee as a conflict', async () => {
    const { api, calls } = client([
      { status: 200, body: { referral: referral({ assignee: AMINA }) } },
      { status: 409, body: { code: 'conflict', details: { reason: 'stale', currentAssignee: JUMA } } },
      { status: 400, body: { code: 'bad_request', details: { reason: 'invalid_assignee' } } },
    ]);
    const result = await api.assign(REF, { assigneeId: 'u1', expectedAssigneeId: null });
    assert.deepEqual(result.referral.assignee, AMINA);
    assert.equal(calls[0]?.url, `/partner/v1/referrals/${REF}/assign`);
    assert.equal(calls[0]!.init.body, JSON.stringify({ assigneeId: 'u1', expectedAssigneeId: null }));
    assert.equal(header(calls[0]!, PARTNER_CSRF_HEADER), 'csrf-1');
    await assert.rejects(api.assign(REF, { assigneeId: null, expectedAssigneeId: 'u1' }), (error: unknown) => {
      assert.ok(error instanceof PartnerApiError);
      assert.equal(error.kind, 'conflict');
      assert.deepEqual(currentAssigneeOf(error), JUMA, 'who holds it now');
      return true;
    });
    assert.equal(calls[1]!.init.body, JSON.stringify({ assigneeId: null, expectedAssigneeId: 'u1' }));
    await assert.rejects(api.assign(REF, { assigneeId: 'u9', expectedAssigneeId: null }), (error: unknown) => {
      assert.equal(errorReason(error), 'invalid_assignee');
      assert.equal(currentAssigneeOf(error), undefined);
      return true;
    });
  });

  it('acknowledges explicitly: new to acknowledged through the status route', async () => {
    const { api, calls } = client([{ status: 200, body: { referral: referral({ status: 'acknowledged', needsAttention: false }) } }]);
    const result = await api.acknowledge(REF);
    assert.equal(result.referral.needsAttention, false);
    assert.equal(calls[0]?.url, `/partner/v1/referrals/${REF}/status`);
    assert.equal(calls[0]!.init.body, JSON.stringify({ to: 'acknowledged', expectedStatus: 'new' }));
  });

  it('opening a case is only a read: it sends no write', async () => {
    const { api, calls } = client([{ status: 200, body: { referral: referral(), view: { kind: 'unavailable' }, attachments: [], timeline: [], notes: [] } }]);
    const detail = await api.getReferral(REF);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init.method, 'GET');
    assert.deepEqual(detail.onwardReferrals, [], 'a missing onward list reads as empty');
  });

  it('adds an onward referral with trimmed fields and no empty ones', async () => {
    const { api, calls } = client([{ status: 200, body: { onward: onward(ONWARD, AT) } }]);
    await api.addOnward(REF, { type: 'police', organisation: '  Central Police Station ', contactRole: ' ', externalReference: 'OB 12/22/10/2026', status: 'made' });
    assert.equal(calls[0]?.url, `/partner/v1/referrals/${REF}/onward`);
    assert.equal(calls[0]!.init.body, JSON.stringify({ type: 'police', organisation: 'Central Police Station', externalReference: 'OB 12/22/10/2026', status: 'made' }));
    assert.deepEqual(onwardRequestBody({ type: 'other' }), { type: 'other' });
  });

  it('moves an onward referral with the status the person saw', async () => {
    const { api, calls } = client([{ status: 200, body: { onward: onward(ONWARD, AT, { status: 'made' }) } }]);
    await api.changeOnwardStatus(REF, ONWARD, { to: 'made', expectedStatus: 'planned' });
    assert.equal(calls[0]?.url, `/partner/v1/referrals/${REF}/onward/${ONWARD}/status`);
    assert.equal(calls[0]!.init.body, JSON.stringify({ to: 'made', expectedStatus: 'planned' }));
    await assert.rejects(api.changeOnwardStatus(REF, '../x', { to: 'made', expectedStatus: 'planned' }), PartnerApiError);
  });
});

describe('partner text and the SafeRide actor (#314 af5f128)', () => {
  it('strips the control characters the API refuses, keeping newlines and tabs', () => {
    assert.equal(stripControlCharacters('Synthetic\u0000note'), 'Syntheticnote');
    assert.equal(stripControlCharacters('OB\u001b[31m 12\u007f'), 'OB[31m 12');
    assert.equal(stripControlCharacters('Gender\rdesk\u0008'), 'Genderdesk');
    assert.equal(stripControlCharacters('Line one\n\tline two'), 'Line one\n\tline two');
    assert.equal(stripControlCharacters('Mombasa — Ksh 200, “quoted”'), 'Mombasa — Ksh 200, “quoted”');
  });

  it('never sends control characters in a note or an onward referral', async () => {
    const { api, calls } = client([
      { status: 200, body: { note: { id: 'n', body: 'x', createdAt: AT, author: { id: 'u1', displayName: 'Amina' } } } },
      { status: 200, body: { onward: onward(ONWARD, AT) } },
    ]);
    await api.addNote(REF, 'Called\u0007 back\n\tlater');
    assert.equal(calls[0]!.init.body, JSON.stringify({ body: 'Called back\n\tlater' }));
    await api.addOnward(REF, { type: 'police', externalReference: 'OB\u0000 33', note: '\u0001' });
    assert.equal(calls[1]!.init.body, JSON.stringify({ type: 'police', externalReference: 'OB 33' }));
  });

  it('a refused text is a bad request the forms can show inline', async () => {
    const { api } = client([{ status: 400, body: { code: 'bad_request', message: 'Invalid request' } }]);
    await assert.rejects(api.addNote(REF, 'x'), (error: unknown) => error instanceof PartnerApiError && error.kind === 'bad_request');
  });

  it('recognises SafeRide as an actor, not a user', async () => {
    assert.equal(SAFERIDE_ACTOR_ID, 'saferide');
    assert.ok(isSafeRideActor({ id: 'saferide', name: 'SafeRide' }));
    assert.ok(!isSafeRideActor(AMINA));
    assert.ok(!isSafeRideActor(null));
    const { api } = client([{ status: 200, body: { staff: [{ id: 'saferide', name: 'SafeRide', role: 'partner_caseworker' }, { id: 'u1', name: 'Amina', role: 'partner_caseworker' }] } }]);
    assert.deepEqual((await api.staff()).map(member => member.id), ['u1'], 'never offered as an assignee');
  });
});

describe('onward-referral rules', () => {
  it('allows only the contract moves', () => {
    assert.deepEqual(ONWARD_TRANSITIONS, {
      planned: ['made', 'cancelled'], made: ['accepted', 'declined'], accepted: ['completed'], declined: [], completed: [], cancelled: [],
    });
    assert.deepEqual(nextOnwardStatuses({ status: 'planned' }), ['made', 'cancelled']);
    assert.deepEqual(nextOnwardStatuses({ status: 'completed' }), []);
    // The record's allowedTransitions decide, limited to contract moves.
    assert.deepEqual(nextOnwardStatuses({ status: 'planned', allowedTransitions: ['cancelled'] }), ['cancelled']);
    assert.deepEqual(nextOnwardStatuses({ status: 'made', allowedTransitions: ['planned', 'completed', 'accepted'] }), ['accepted']);
    assert.deepEqual([...ONWARD_TYPES], ['police', 'medical', 'psychosocial', 'legal_aid', 'shelter', 'child_protection', 'other']);
  });

  it('checks the type and the field limits', () => {
    assert.deepEqual(ONWARD_LIMITS, { organisation: 120, contactRole: 120, externalReference: 80, note: 1000 });
    assert.deepEqual(onwardInputProblems({ type: '' }), [{ field: 'type', problem: 'required' }]);
    assert.deepEqual(onwardInputProblems({ type: 'police', organisation: 'x'.repeat(120), note: 'y'.repeat(1000) }), []);
    assert.deepEqual(onwardInputProblems({ type: 'police', externalReference: 'x'.repeat(81), contactRole: 'r'.repeat(121) }), [
      { field: 'contactRole', problem: 'too_long' },
      { field: 'externalReference', problem: 'too_long' },
    ]);
  });

  it('summarises a case’s onward referrals for its queue row (count and newest)', () => {
    assert.deepEqual(onwardSummaryOf([]), { count: 0, latest: null });
    assert.deepEqual(onwardSummaryOf([
      onward('1', '2026-10-20T08:00:00Z', { type: 'police', status: 'accepted' }),
      onward('2', '2026-10-21T08:00:00Z', { type: 'medical', status: 'made' }),
    ]), { count: 2, latest: { type: 'medical', status: 'made' } });
  });
});

describe('queue views', () => {
  it('maps each quick view to the API filters', () => {
    assert.deepEqual(apiFilterFor({ view: 'all', status: 'all' }), { status: undefined, priority: undefined, assignee: undefined, cursor: undefined });
    assert.deepEqual(apiFilterFor({ view: 'attention', status: 'closed' }), { status: 'new', priority: 'urgent', assignee: undefined, cursor: undefined });
    assert.deepEqual(apiFilterFor({ view: 'mine', status: 'in_progress' }, 'c2'), { status: 'in_progress', priority: undefined, assignee: 'me', cursor: 'c2' });
    assert.deepEqual(apiFilterFor({ view: 'unassigned', status: 'all' }), { status: undefined, priority: undefined, assignee: 'unassigned', cursor: undefined });
    assert.deepEqual(apiFilterFor({ view: 'urgent', status: 'all' }), { status: undefined, priority: 'urgent', assignee: undefined, cursor: undefined });
    assert.equal(effectiveStatus({ view: 'attention', status: 'all' }), 'new');
    assert.ok(isQueueView('mine'));
    assert.ok(!isQueueView('everything'));
  });

  it('matches rows the way the server filters them', () => {
    const urgentNew = row('a', { priority: 'urgent', needsAttention: true });
    const mine = row('b', { assignee: AMINA, status: 'in_progress' });
    const gone = row('c', { withdrawn: true, status: 'withdrawn', pathway: null });
    assert.ok(rowMatchesFilter(urgentNew, { view: 'attention', status: 'all' }, 'u1'));
    assert.ok(!rowMatchesFilter(row('d', { priority: 'urgent', needsAttention: false }), { view: 'attention', status: 'all' }, 'u1'));
    assert.ok(rowMatchesFilter(mine, { view: 'mine', status: 'all' }, 'u1'));
    assert.ok(!rowMatchesFilter(mine, { view: 'mine', status: 'all' }, 'u2'));
    assert.ok(!rowMatchesFilter(mine, { view: 'mine', status: 'new' }, 'u1'));
    assert.ok(rowMatchesFilter(urgentNew, { view: 'unassigned', status: 'all' }, 'u1'));
    assert.ok(!rowMatchesFilter(gone, { view: 'unassigned', status: 'all' }, 'u1'), 'a case no longer shared is never "unassigned"');
    assert.ok(rowMatchesFilter(gone, { view: 'all', status: 'withdrawn' }, 'u1'));
  });

  it('drops a row from "Needs attention" once acknowledged, and from "Unassigned" once assigned', () => {
    let state = signedIn([row('a', { priority: 'urgent', needsAttention: true }), row('b', { priority: 'urgent', needsAttention: true })], { view: 'attention', status: 'all' });
    state = queueRowUpdated(state, queueItemOf(referral({ id: 'a', reference: 'SR-a', status: 'acknowledged', needsAttention: false })));
    assert.deepEqual(state.queue.items.map(item => item.id), ['b']);

    state = signedIn([row('a'), row('b')], { view: 'unassigned', status: 'all' });
    state = queueRowUpdated(state, queueItemOf(referral({ id: 'a', reference: 'SR-a', priority: 'normal', needsAttention: false, assignee: JUMA })));
    assert.deepEqual(state.queue.items.map(item => item.id), ['b']);
  });

  it('keeps a row’s onward summary unless the case page knows the full list', () => {
    const summary = { count: 1, latest: { type: 'police' as const, status: 'accepted' as const } };
    let state = signedIn([row('a', { onward: summary })]);
    state = queueRowUpdated(state, queueItemOf(referral({ id: 'a', reference: 'SR-a', assignee: AMINA })));
    assert.deepEqual(state.queue.items[0]?.onward, summary);
    assert.deepEqual(state.queue.items[0]?.assignee, AMINA);
    state = queueRowUpdated(state, queueItemOf(referral({ id: 'a', reference: 'SR-a' }), [onward('1', AT, { status: 'completed' })]));
    assert.deepEqual(state.queue.items[0]?.onward, { count: 1, latest: { type: 'police', status: 'completed' } });
  });
});

describe('attention state and signals', () => {
  it('holds the summary while signed in, and wipes it (and the chime) on sign-out', () => {
    let state = signedIn([]);
    assert.equal(attentionCount(state), 0);
    state = summaryLoaded(state, { needsAttention: 2, newTotal: 3, inProgress: 1, unassigned: 4, mine: 1 }, 5);
    assert.equal(attentionCount(state), 2);
    state = chimeSet(state, true);
    assert.equal(state.alerts.chime, true);
    assert.equal(chimeSet(state, true), state);
    const out = signedOut();
    assert.deepEqual(out.alerts, { summary: null, loadedAt: null, chime: false, unavailable: false });
    assert.equal(summaryLoaded(out, { needsAttention: 9, newTotal: 0, inProgress: 0, unassigned: 0, mine: 0 }, 6), out, 'no counts after sign-out');
  });

  it('the chime starts off', () => {
    assert.equal(initialState().alerts.chime, false);
  });

  it('polls only in a visible tab, at most every 60 s', () => {
    assert.equal(BACKGROUND_REFRESH_MIN_MS, 60_000);
    assert.ok(summaryPollDue(0, 60_000, 'visible'));
    assert.ok(!summaryPollDue(10_000, 69_999, 'visible'));
    assert.ok(!summaryPollDue(0, 600_000, 'hidden'));
  });

  it('puts only a count in the title, and a dot on the favicon', () => {
    assert.equal(titleWithCount('Cases', 0), 'Cases');
    assert.equal(titleWithCount('Cases', 2), '(2) Cases');
    assert.equal(titleWithCount('Case', 150), '(99+) Case');
    assert.equal(faviconFor(0), FAVICON);
    assert.equal(faviconFor(1), FAVICON_ALERT);
  });

  it('chimes only when switched on and the count rises after the first summary', () => {
    assert.ok(!shouldChime(null, 3, true), 'not for the first summary');
    assert.ok(shouldChime(1, 2, true));
    assert.ok(!shouldChime(2, 2, true));
    assert.ok(!shouldChime(2, 1, true));
    assert.ok(!shouldChime(1, 2, false));
  });
});

describe('normalising a queue row', () => {
  it('derives urgency from the pathway when the field is missing', () => {
    const raw = { id: 'a', reference: 'SR-a', pathway: 'escalation', status: 'new', withdrawn: false, receivedAt: AT, statusChangedAt: AT } as ReferralQueueItem;
    assert.equal(normaliseQueueItem(raw).priority, 'urgent');
  });
});
