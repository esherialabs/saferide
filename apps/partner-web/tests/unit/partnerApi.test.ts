import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLOSURE_REASONS,
  DEFAULT_EVIDENCE_ORIGIN,
  EVIDENCE_ORIGIN,
  EVIDENCE_NOT_SHAREABLE_YET,
  PARTNER_ACTIVITY_HEADER,
  PARTNER_CSRF_HEADER,
  PartnerApiError,
  createPartnerApi,
  isEnrollmentToken,
  isReferralId,
  isSafeDownloadUrl,
  isTombstone,
  nextStatuses,
  passwordProblem,
  referralListQuery,
  type Referral,
} from '../../src/lib/partnerApi.ts';

const REF = '7d0c3a52-4c8e-4f7a-9b1d-2e6f8a9c0b11';
const ATT = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string>; raw?: string } | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    const body = next.raw ?? (next.body === undefined ? null : JSON.stringify(next.body));
    return new Response(next.status === 204 ? null : body, { status: next.status, headers: next.headers });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function client(responses: Parameters<typeof fakeFetch>[0], csrf: string | null = 'csrf-1') {
  const { calls, fetchImpl } = fakeFetch(responses);
  const events = { expired: 0, touched: 0 };
  const api = createPartnerApi({
    fetch: fetchImpl,
    getCsrfToken: () => csrf,
    onSessionExpired: () => {
      events.expired += 1;
    },
    onServerTouch: () => {
      events.touched += 1;
    },
    now: () => 1_000_000,
  });
  return { api, calls, events };
}

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}

const session = { idleExpiresAt: '2026-10-21T10:30:00.000Z', absoluteExpiresAt: '2026-10-21T22:00:00.000Z' };

it('a late response from an old session cannot expire or extend the next sign-in', async () => {
  let current = 'synthetic-old-session';
  let answer!: (response: Response) => void;
  let expired = 0;
  let touched = 0;
  let confirmed = 0;
  const api = createPartnerApi({
    getCsrfToken: () => current,
    fetch: (() => new Promise<Response>(resolve => { answer = resolve; })) as typeof fetch,
    onSessionExpired: () => { expired++; }, onServerTouch: () => { touched++; }, onSessionConfirmed: () => { confirmed++; },
  });
  const failed = api.me();
  current = 'synthetic-new-session';
  answer(new Response('{}', { status: 401 }));
  await assert.rejects(failed, PartnerApiError);
  assert.equal(expired, 0);
  current = 'synthetic-old-session';
  const succeeded = api.summary();
  current = 'synthetic-new-session';
  answer(new Response(JSON.stringify({ needsAttention: 0, newTotal: 0, inProgress: 0, unassigned: 0, mine: 0 }), { status: 200 }));
  await succeeded;
  assert.equal(touched, 0);
  assert.equal(confirmed, 0);
});

describe('auth requests (P2 contract)', () => {
  it('posts the login body same-origin, uncached, without a CSRF header', async () => {
    const { api, calls } = client([{ status: 200, body: { mfaRequired: true, csrfToken: 'pre', session } }]);
    const result = await api.login('caseworker@huria.test', 'pw');
    assert.equal(result.csrfToken, 'pre');
    assert.equal(calls[0]?.url, '/partner/v1/auth/login');
    const init = calls[0]!.init;
    assert.equal(init.method, 'POST');
    assert.equal(init.body, JSON.stringify({ email: 'caseworker@huria.test', password: 'pw' }));
    assert.equal(init.mode, 'same-origin');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(header(calls[0]!, 'content-type'), 'application/json');
    assert.equal(header(calls[0]!, PARTNER_CSRF_HEADER), undefined);
  });

  it('sends the CSRF header on the TOTP step', async () => {
    const { api, calls } = client([{ status: 200, body: { mfaRequired: false, csrfToken: 'full', session } }], 'pre');
    await api.verifyTotp('123456');
    assert.equal(calls[0]?.url, '/partner/v1/auth/totp');
    assert.equal(header(calls[0]!, PARTNER_CSRF_HEADER), 'pre');
    assert.equal(calls[0]!.init.body, JSON.stringify({ code: '123456' }));
  });

  it('sets up an authenticator at sign-in with the pre-MFA CSRF header and no body', async () => {
    const totp = { keyUri: 'otpauth://totp/x', secret: 'ABCD', algorithm: 'SHA1', digits: 6, periodSeconds: 30 };
    const { api, calls } = client([{ status: 200, body: { totp } }], 'pre');
    assert.deepEqual(await api.totpSetup(), { totp });
    assert.equal(calls[0]?.url, '/partner/v1/auth/totp/setup');
    assert.equal(calls[0]!.init.body, undefined);
    assert.equal(header(calls[0]!, PARTNER_CSRF_HEADER), 'pre');
  });

  it('changes the password with CSRF and takes the new session from the answer', async () => {
    const { api, calls } = client([{ status: 200, body: { mfaRequired: false, mustChangePassword: false, csrfToken: 'rotated', session } }]);
    const result = await api.changePassword('old pass phrase', 'new pass phrase 9');
    assert.equal(result.csrfToken, 'rotated');
    assert.equal(calls[0]?.url, '/partner/v1/auth/change-password');
    assert.equal(calls[0]!.init.body, JSON.stringify({ currentPassword: 'old pass phrase', newPassword: 'new pass phrase 9' }));
    assert.equal(header(calls[0]!, PARTNER_CSRF_HEADER), 'csrf-1');
  });

  it('keeps the session when the current password is refused (400), but ends it on 401', async () => {
    const { api, events } = client([
      { status: 400, body: { code: 'bad_request', message: 'Your current password was not accepted.' } },
      { status: 401, body: { code: 'unauthorized' } },
    ]);
    await assert.rejects(api.changePassword('x', 'y'), (error: unknown) => error instanceof PartnerApiError && error.kind === 'bad_request');
    assert.equal(events.expired, 0);
    await assert.rejects(api.changePassword('x', 'y'), (error: unknown) => error instanceof PartnerApiError && error.kind === 'unauthorized');
    assert.equal(events.expired, 1);
  });

  it('logs out with the CSRF header and no body or content type', async () => {
    const { api, calls } = client([{ status: 204 }]);
    await api.logout();
    assert.equal(calls[0]?.url, '/partner/v1/auth/logout');
    assert.equal(calls[0]!.init.body, undefined);
    assert.equal(header(calls[0]!, 'content-type'), undefined);
    assert.equal(header(calls[0]!, PARTNER_CSRF_HEADER), 'csrf-1');
  });

  it('sends the enrolment token in the body, never the path', async () => {
    const token = `srpe_${'a'.repeat(43)}`;
    const { api, calls } = client([{ status: 200, body: { user: {}, org: {}, role: 'partner_caseworker', totp: {} } }]);
    await api.enrollStart(token);
    assert.equal(calls[0]?.url, '/partner/v1/auth/enroll/start');
    assert.ok(!calls[0]!.url.includes(token));
    assert.equal(calls[0]!.init.body, JSON.stringify({ token }));
  });

  it('treats a 401 on sign-in as a failed attempt, not an ended session', async () => {
    const { api, events } = client([{ status: 401, body: { code: 'unauthorized', message: 'Sign-in failed', requestId: 'req-1' } }]);
    await assert.rejects(api.login('a@b.test', 'x'), (error: unknown) => {
      assert.ok(error instanceof PartnerApiError);
      assert.equal(error.kind, 'unauthorized');
      assert.equal(error.requestId, 'req-1');
      return true;
    });
    assert.equal(events.expired, 0);
  });

  it('refuses an auth response without a CSRF token', async () => {
    const { api } = client([{ status: 200, body: { mfaRequired: true } }]);
    await assert.rejects(api.login('a@b.test', 'x'), (error: unknown) => error instanceof PartnerApiError && error.kind === 'unavailable');
  });

  it('refuses a CSRF-protected write when no token is held', async () => {
    const { api, calls, events } = client([], null);
    await assert.rejects(api.addNote(REF, 'x'), (error: unknown) => error instanceof PartnerApiError && error.kind === 'unauthorized');
    assert.equal(calls.length, 0);
    assert.equal(events.expired, 1);
  });
});

describe('case requests (assumed P3 contract)', () => {
  it('builds the queue query from set filters only', async () => {
    assert.equal(referralListQuery({}), '');
    assert.equal(referralListQuery({ status: 'new', pathway: 'escalation', cursor: 'c 1' }), '?status=new&pathway=escalation&cursor=c+1');
    assert.equal(referralListQuery({ status: 'withdrawn', limit: 50 }), '?status=withdrawn&limit=50');
    const { api, calls, events } = client([{ status: 200, body: { referrals: [], nextCursor: null } }]);
    await api.listReferrals({ status: 'closed' });
    assert.equal(calls[0]?.url, '/partner/v1/referrals?status=closed');
    assert.equal(header(calls[0]!, PARTNER_ACTIVITY_HEADER), 'interactive');
    assert.equal(events.touched, 1);
  });

  it('sends no activity flag on background refreshes and does not count them as touching the session', async () => {
    const { api, calls, events } = client([{ status: 200, body: { referrals: [], nextCursor: null } }]);
    await api.listReferrals({}, { background: true });
    assert.equal(header(calls[0]!, PARTNER_ACTIVITY_HEADER), undefined);
    assert.equal(events.touched, 0);
  });

  it('flags user-driven reads as interactive but not writes (they always count)', async () => {
    const { api, calls } = client([{ status: 200, body: {} }, { status: 200, body: { note: {} } }]);
    await api.me();
    await api.addNote(REF, 'x');
    assert.equal(header(calls[0]!, PARTNER_ACTIVITY_HEADER), 'interactive');
    assert.equal(header(calls[1]!, PARTNER_ACTIVITY_HEADER), undefined);
  });

  it('never puts an unsafe ID into a path', async () => {
    const { api, calls } = client([]);
    await assert.rejects(api.getReferral('../me'), (error: unknown) => error instanceof PartnerApiError && error.kind === 'not_found');
    await assert.rejects(api.getReferral('ref_0001'), (error: unknown) => error instanceof PartnerApiError && error.kind === 'not_found');
    await assert.rejects(api.evidenceLink(REF, 'a/b'), (error: unknown) => error instanceof PartnerApiError && error.kind === 'not_found');
    assert.equal(calls.length, 0);
  });

  it('sends expectedStatus, and a closure reason only when closing', async () => {
    const referral = { id: REF, status: 'acknowledged' };
    const { api, calls } = client([{ status: 200, body: { referral } }, { status: 200, body: { referral } }]);
    await api.changeStatus(REF, { to: 'acknowledged', expectedStatus: 'new', closureReason: 'duplicate' });
    await api.changeStatus(REF, { to: 'closed', expectedStatus: 'acknowledged', closureReason: 'duplicate' });
    assert.equal(calls[0]?.url, `/partner/v1/referrals/${REF}/status`);
    assert.equal(calls[0]!.init.body, JSON.stringify({ to: 'acknowledged', expectedStatus: 'new' }));
    assert.equal(calls[1]!.init.body, JSON.stringify({ to: 'closed', expectedStatus: 'acknowledged', closureReason: 'duplicate' }));
    assert.equal(header(calls[0]!, PARTNER_CSRF_HEADER), 'csrf-1');
  });

  it('maps a stale status to a conflict, and a withdrawn referral to gone', async () => {
    const { api } = client([
      { status: 409, body: { code: 'conflict', message: 'changed', details: { reason: 'stale', currentStatus: 'in_progress' } } },
      { status: 410, body: { code: 'withdrawn', message: 'withdrawn', details: { reason: 'withdrawn' } } },
      { status: 503, body: { code: 'service_unavailable', message: 'The partner service is unavailable' } },
    ]);
    await assert.rejects(api.changeStatus(REF, { to: 'acknowledged', expectedStatus: 'new' }), (error: unknown) => {
      assert.ok(error instanceof PartnerApiError);
      assert.equal(error.kind, 'conflict');
      assert.deepEqual(error.details, { reason: 'stale', currentStatus: 'in_progress' });
      return true;
    });
    await assert.rejects(api.addNote(REF, 'x'), (error: unknown) => error instanceof PartnerApiError && error.kind === 'gone');
    await assert.rejects(api.getReferral(REF), (error: unknown) => error instanceof PartnerApiError && error.kind === 'unavailable');
  });

  it('reports a session that ended on the server', async () => {
    const { api, events } = client([{ status: 401, raw: 'not json' }]);
    await assert.rejects(api.getReferral(REF), (error: unknown) => error instanceof PartnerApiError && error.kind === 'unauthorized');
    assert.equal(events.expired, 1);
  });

  it('maps network failures and gateway pages', async () => {
    const { api } = client([new TypeError('offline'), { status: 502, raw: '<html>' }, { status: 429, body: { code: 'rate_limited' } }]);
    await assert.rejects(api.me(), (error: unknown) => error instanceof PartnerApiError && error.kind === 'network');
    await assert.rejects(api.me(), (error: unknown) => error instanceof PartnerApiError && error.kind === 'unavailable' && error.status === 502);
    await assert.rejects(api.me(), (error: unknown) => error instanceof PartnerApiError && error.kind === 'rate_limited');
  });

  it('posts evidence and callback requests without a body, and refuses unsafe links or odd shapes', async () => {
    const { api, calls } = client([
      { status: 200, body: { url: 'https://storage.saferide.esheria.org/evidence/x?X-Amz-Signature=1', expiresInSeconds: 60 } },
      { status: 200, body: { url: 'https://storage.example.test/x?sig=1', expiresInSeconds: 60 } },
      { status: 200, body: { callback: { phoneNumber: '+254 700 000 123' } } },
      { status: 200, body: { phoneNumber: '+254 700 000 123' } },
    ]);
    const link = await api.evidenceLink(REF, ATT);
    assert.equal(link.expiresInSeconds, 60);
    assert.equal(calls[0]?.url, `/partner/v1/referrals/${REF}/evidence/${ATT}/url`);
    assert.equal(calls[0]!.init.body, undefined);
    await assert.rejects(api.evidenceLink(REF, ATT), (error: unknown) => error instanceof PartnerApiError && error.kind === 'unavailable');
    const callback = await api.revealCallback(REF);
    assert.equal(callback.callback.phoneNumber, '+254 700 000 123');
    assert.equal(calls[2]?.url, `/partner/v1/referrals/${REF}/callback`);
    assert.equal(header(calls[2]!, PARTNER_CSRF_HEADER), 'csrf-1');
    assert.equal(EVIDENCE_ORIGIN, DEFAULT_EVIDENCE_ORIGIN, 'unit tests run with the production default');
    await assert.rejects(api.revealCallback(REF), (error: unknown) => error instanceof PartnerApiError && error.kind === 'unavailable');
  });

  it('accepts evidence links only from the configured storage origin', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { url: 'http://localhost:4321/storage/a?signature=1', expiresInSeconds: 60 } },
      { status: 200, body: { url: 'https://storage.saferide.esheria.org/a', expiresInSeconds: 60 } },
    ]);
    const api = createPartnerApi({
      fetch: fetchImpl, getCsrfToken: () => 'csrf-1', onSessionExpired: () => undefined, evidenceOrigin: 'http://localhost:4321',
    });
    assert.equal((await api.evidenceLink(REF, ATT)).url, 'http://localhost:4321/storage/a?signature=1');
    await assert.rejects(api.evidenceLink(REF, ATT), (error: unknown) => error instanceof PartnerApiError && error.kind === 'unavailable');
  });

  it('gives up on a request after the timeout, without treating it as an ended session', async () => {
    let aborted = false;
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    })) as typeof fetch;
    let expired = 0;
    const api = createPartnerApi({
      fetch: hanging, getCsrfToken: () => 'c', onSessionExpired: () => { expired += 1; }, timeoutMs: 20,
    });
    await assert.rejects(api.me(), (error: unknown) => error instanceof PartnerApiError && error.kind === 'timeout');
    await assert.rejects(api.checkSession(), (error: unknown) => error instanceof PartnerApiError && error.kind === 'timeout');
    assert.ok(aborted, 'the request was actually aborted');
    assert.equal(expired, 0);
  });

  it('counts any successful request made with the session, background or not, as confirming it', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { referrals: [], nextCursor: null } },
      { status: 200, body: {} },
      { status: 200, body: { mfaRequired: true, csrfToken: 'pre', session } },
    ]);
    let confirmed = 0;
    const api = createPartnerApi({
      fetch: fetchImpl, getCsrfToken: () => 'c', onSessionExpired: () => undefined, onSessionConfirmed: () => { confirmed += 1; },
    });
    await api.listReferrals({}, { background: true });
    await api.checkSession();
    assert.equal(confirmed, 2);
    await api.login('a@b.test', 'x');
    assert.equal(confirmed, 2, 'sign-in is not a session request');
  });

  it('reads the server clock from the Date header', async () => {
    const { api } = client([{ status: 200, body: { referrals: [], nextCursor: null }, headers: { date: 'Wed, 21 Oct 2026 10:00:00 GMT' } }]);
    assert.equal(api.serverNow(), undefined);
    await api.listReferrals();
    assert.equal(api.serverNow(), Date.parse('2026-10-21T10:00:00Z'));
  });
});

describe('rules shared with the server', () => {
  it('offers the server allowed moves, known statuses only, in order', () => {
    const base: Referral = {
      id: REF, reference: 'SR-7K3Q-9M2D', pathway: 'referral', status: 'new', closureReason: null, withdrawn: false,
      receivedAt: '2026-10-21T08:00:00.000Z', statusChangedAt: '2026-10-21T08:00:00.000Z', callbackShared: false,
      allowedTransitions: ['closed', 'acknowledged'], priority: 'normal', needsAttention: false, assignee: null,
    };
    assert.deepEqual(nextStatuses(base), ['acknowledged', 'closed']);
    assert.deepEqual(nextStatuses({ ...base, status: 'closed', allowedTransitions: [] }), []);
    assert.deepEqual(nextStatuses({ ...base, allowedTransitions: ['new', 'bogus' as never, 'closed'] }), ['closed']);
    assert.ok(!isTombstone(base));
    assert.ok(isTombstone({ id: REF, reference: 'SR-1', status: 'withdrawn', withdrawn: true, receivedAt: '', withdrawnAt: '' }));
  });

  it("uses exactly P3's closure codes and evidence switch reason", () => {
    // apps/api/src/services/partnerReferralStatus.ts PARTNER_CLOSURE_REASONS (#294 at 029243e).
    assert.deepEqual([...CLOSURE_REASONS], [
      'support_provided', 'referred_elsewhere', 'survivor_did_not_make_contact', 'outside_mandate', 'duplicate', 'other',
    ]);
    // apps/api/src/routes/partnerCases.ts EVIDENCE_NOT_SHAREABLE_YET.
    assert.equal(EVIDENCE_NOT_SHAREABLE_YET, 'evidence_not_shareable_yet');
  });

  it('mirrors the P2 password policy', () => {
    assert.equal(passwordProblem('short', 'amina@huria.test'), 'too_short');
    assert.equal(passwordProblem('x'.repeat(257), 'amina@huria.test'), 'too_long');
    assert.equal(passwordProblem('my-amina-password', 'amina@huria.test'), 'contains_email');
    assert.equal(passwordProblem('abababababab', 'amina@huria.test'), 'repetitive');
    assert.equal(passwordProblem('calm river at dawn', 'amina@huria.test'), null);
    // The same "too easy to guess" rule as partnerPasswordProblem: common words, runs and repeats count little.
    for (const weak of ['Password2026!', 'SafeRide12345', 'qwertyuiop1234', '123456789012']) {
      assert.equal(passwordProblem(weak, 'amina@huria.test'), 'predictable', weak);
    }
    assert.equal(passwordProblem('k7mqa-2rx9p-hd4tz-w8nce-3vjfy', 'amina@huria.test'), null);
  });

  it('recognises tokens, IDs and safe download URLs', () => {
    assert.ok(isEnrollmentToken(`srpe_${'A'.repeat(43)}`));
    assert.ok(!isEnrollmentToken(`srps_${'A'.repeat(43)}`));
    assert.ok(isReferralId(REF));
    assert.ok(!isReferralId('ref_0001'));
    assert.ok(!isReferralId(`${REF}/x`));
    const storage = 'https://storage.saferide.esheria.org';
    assert.ok(isSafeDownloadUrl(`${storage}/evidence/a?X-Amz-Signature=1`, storage));
    assert.ok(!isSafeDownloadUrl('https://evil.example.test/a', storage), 'any other https host');
    assert.ok(!isSafeDownloadUrl('https://x.storage.saferide.esheria.org/a', storage), 'a subdomain');
    assert.ok(!isSafeDownloadUrl('https://storage.saferide.esheria.org.evil.test/a', storage), 'a lookalike host');
    assert.ok(!isSafeDownloadUrl('http://storage.saferide.esheria.org/a', storage), 'plain http');
    assert.ok(!isSafeDownloadUrl('https://user:pw@storage.saferide.esheria.org/a', storage), 'credentials');
    assert.ok(!isSafeDownloadUrl('https://storage.saferide.esheria.org:8443/a', storage), 'another port');
    assert.ok(!isSafeDownloadUrl('/evidence/a', storage), 'relative');
    assert.ok(!isSafeDownloadUrl('javascript:alert(1)', storage));
    assert.ok(!isSafeDownloadUrl('data:text/html,hi', storage));
    // The e2e build allows only the mock's localhost storage origin.
    assert.ok(isSafeDownloadUrl('http://localhost:4321/storage/a', 'http://localhost:4321'));
    assert.ok(!isSafeDownloadUrl('http://localhost:4320/storage/a', 'http://localhost:4321'));
  });
});
