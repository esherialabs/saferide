import { randomBytes } from 'node:crypto';

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { partnerCsrfToken } from '../../middleware/partnerSession.js';
import { deriveCallbackSealKey, sealPartnerCallback } from '../../services/partnerCallbackSeal.js';
import { generatePartnerToken } from '../../services/partnerTokens.js';
import { decodePartnerCursor, encodePartnerCursor } from '../partnerCases.js';
import { registerPartnerApi } from '../partnerAuth.js';

const authRepo = vi.hoisted(() => ({ resolvePartnerSession: vi.fn() }));
const partnerRepo = vi.hoisted(() => ({ recordPartnerAccess: vi.fn(), recordPartnerAccessAtMostEvery: vi.fn() }));
const caseRepo = vi.hoisted(() => ({
  addPartnerReferralNote: vi.fn(),
  assignPartnerReferral: vi.fn(),
  createPartnerOnwardReferral: vi.fn(),
  getPartnerReferral: vi.fn(),
  getPartnerReferralCallback: vi.fn(),
  listPartnerCaseActivity: vi.fn(),
  listPartnerOnwardReferrals: vi.fn(),
  listPartnerReferralAttachments: vi.fn(),
  listPartnerReferralNotes: vi.fn(),
  listPartnerReferralTimeline: vi.fn(),
  listPartnerReferrals: vi.fn(),
  listPartnerStaff: vi.fn(),
  summarizePartnerQueue: vi.fn(),
  transitionPartnerOnwardReferral: vi.fn(),
  transitionPartnerReferral: vi.fn(),
}));
const storage = vi.hoisted(() => ({ createPresignedDownloadUrl: vi.fn() }));

vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../plugins/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../plugins/redis.js', () => ({ redis: { incr: vi.fn(), expire: vi.fn() } }));
vi.mock('../../storage/evidenceStorage.js', () => storage);
vi.mock('../../repositories/partnerAuthRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/partnerAuthRepository.js')>()),
  ...authRepo,
}));
vi.mock('../../repositories/partnerRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/partnerRepository.js')>()),
  ...partnerRepo,
}));
vi.mock('../../repositories/partnerCaseRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/partnerCaseRepository.js')>()),
  ...caseRepo,
}));

const ORIGIN = 'https://partners.example.invalid';
const HOST = 'partners.example.invalid';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const REFERRAL_ID = '33333333-3333-4333-8333-333333333333';
const ATTACHMENT_ID = '44444444-4444-4444-8444-444444444444';
const ONWARD_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STORAGE_KEY = 'evidence/synthetic/object-key';
const totpKey = randomBytes(32);
const callbackKey = randomBytes(32);
const callbackSealKey = deriveCallbackSealKey(callbackKey);
const token = generatePartnerToken('session');
let role: 'partner_caseworker' | 'partner_admin' = 'partner_caseworker';
let app: FastifyInstance;

function referral(overrides: Record<string, unknown> = {}) {
  return {
    id: REFERRAL_ID, reference: 'SR-7K3Q-9M2D', status: 'acknowledged', closureReason: null, pathway: 'referral',
    receivedAt: new Date('2026-10-21T08:00:00.000Z'), statusChangedAt: new Date('2026-10-21T09:00:00.000Z'),
    revokedAt: null, callbackShared: true, assignee: null, caseId: CASE_ID, ownerId: OWNER_ID,
    summary: {
      pathwayConsent: { recordId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      workflow: {
        schemaVersion: '1.0', workflowType: 'referral', providerId: 'ke-coast-huria', channel: 'call',
        supportBrief: { included: true, selectedFields: ['location_type'], locationType: 'matatu' },
      },
    },
    ...overrides,
  };
}

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTACHMENT_ID, owner_id: OWNER_ID, case_id: CASE_ID, bucket_path: STORAGE_KEY, mime_type: 'image/jpeg', size_bytes: 10,
    sha256: 'a'.repeat(64), expected_sha256: 'a'.repeat(64), status: 'uploaded', antivirus_status: 'clean',
    quarantine_status: 'released', metadata: null, created_at: '2026-10-21T08:01:00.000Z',
    ...overrides,
  };
}

function send(method: 'GET' | 'POST', path: string, options: { body?: unknown; csrf?: boolean; cookie?: boolean } = {}) {
  const headers: Record<string, string> = { host: HOST, origin: ORIGIN };
  if (options.cookie !== false) headers.cookie = `__Host-saferide_partner=${token}`;
  if (options.csrf !== false && method === 'POST') headers['x-saferide-partner-csrf'] = partnerCsrfToken(token);
  const inject: InjectOptions = { method, url: `/partner/v1${path}`, headers };
  if (options.body !== undefined) inject.payload = options.body as InjectOptions['payload'];
  return app.inject(inject);
}

function audits(): string[] {
  return partnerRepo.recordPartnerAccess.mock.calls.map(([entry]) =>
    [entry.action, entry.outcome, entry.referralId ?? '-', entry.attachmentId ?? '-'].join(' '));
}

describe('partner case routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    role = 'partner_caseworker';
    authRepo.resolvePartnerSession.mockImplementation(async () => ({
      sessionId: 'session-1', userId: USER_ID, orgId: ORG_ID, orgStableId: 'ke-coast-huria', role, stage: 'full', mfaVerified: true, mustChangePassword: false,
      idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 600_000),
    }));
    partnerRepo.recordPartnerAccess.mockResolvedValue(undefined);
    caseRepo.getPartnerReferral.mockResolvedValue(referral());
    caseRepo.listPartnerReferralAttachments.mockResolvedValue([attachment()]);
    caseRepo.listPartnerReferralTimeline.mockResolvedValue([
      { eventType: 'partner_routed', partnerStatus: 'new', createdAt: new Date('2026-10-21T08:00:00.000Z') },
    ]);
    caseRepo.listPartnerReferralNotes.mockResolvedValue([]);
    caseRepo.listPartnerOnwardReferrals.mockResolvedValue([]);
    caseRepo.listPartnerCaseActivity.mockResolvedValue([]);
    partnerRepo.recordPartnerAccessAtMostEvery.mockResolvedValue(true);
    storage.createPresignedDownloadUrl.mockResolvedValue('https://storage.example.invalid/presigned');
    app = Fastify({ logger: false });
    // Explicitly opted in so the scan/quarantine gate can be tested; the default is covered separately.
    await registerPartnerApi(app, { publicOrigin: ORIGIN, totpKey, callbackKey, evidenceDownload: 'originals' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('needs a partner session for every case endpoint and the CSRF header for every write', async () => {
    const reads = ['/referrals', `/referrals/${REFERRAL_ID}`, '/summary', '/staff'];
    const writes = [
      `/referrals/${REFERRAL_ID}/status`, `/referrals/${REFERRAL_ID}/notes`,
      `/referrals/${REFERRAL_ID}/evidence/${ATTACHMENT_ID}/url`, `/referrals/${REFERRAL_ID}/callback`,
      `/referrals/${REFERRAL_ID}/assign`, `/referrals/${REFERRAL_ID}/onward`, `/referrals/${REFERRAL_ID}/onward/${ONWARD_ID}/status`,
    ];
    for (const path of reads) expect((await send('GET', path, { cookie: false })).statusCode).toBe(401);
    for (const path of writes) {
      expect((await send('POST', path, { cookie: false, body: {} })).statusCode).toBe(401);
      expect((await send('POST', path, { csrf: false, body: {} })).statusCode).toBe(403);
    }
    const bearer = await app.inject({
      method: 'GET', url: '/partner/v1/referrals', headers: { host: HOST, authorization: 'Bearer synthetic' },
    });
    expect(bearer.statusCode).toBe(401);
    for (const fn of Object.values(caseRepo)) expect(fn).not.toHaveBeenCalled();
  });

  it('lists only the session org’s queue, paginated, and audits the read', async () => {
    const next = { createdAt: '2026-10-21T08:00:00.123456Z', id: REFERRAL_ID };
    caseRepo.listPartnerReferrals.mockResolvedValueOnce({
      rows: [{
        id: REFERRAL_ID, reference: 'SR-7K3Q-9M2D', status: 'new', pathway: 'escalation',
        receivedAt: new Date('2026-10-21T08:00:00.000Z'), statusChangedAt: new Date('2026-10-21T08:00:00.000Z'), revokedAt: null,
        assignee: null, onward: { count: 0, latest: null },
      }],
      nextCursor: next,
    });
    const cursor = encodePartnerCursor({ createdAt: '2026-10-22T00:00:00.000000Z', id: REFERRAL_ID });
    const response = await send('GET', `/referrals?status=new&pathway=escalation&limit=1&cursor=${cursor}`);
    expect(response.statusCode).toBe(200);
    expect(caseRepo.listPartnerReferrals).toHaveBeenCalledWith({
      orgId: ORG_ID, status: 'new', pathway: 'escalation', limit: 1,
      cursor: { createdAt: '2026-10-22T00:00:00.000000Z', id: REFERRAL_ID },
    });
    expect(response.json()).toEqual({
      referrals: [{
        id: REFERRAL_ID, reference: 'SR-7K3Q-9M2D', pathway: 'escalation', status: 'new', withdrawn: false,
        receivedAt: '2026-10-21T08:00:00.000Z', statusChangedAt: '2026-10-21T08:00:00.000Z',
        priority: 'urgent', needsAttention: true, assignee: null, onward: { count: 0, latest: null },
      }],
      nextCursor: encodePartnerCursor(next),
    });
    expect(decodePartnerCursor(response.json().nextCursor)).toEqual(next);
    expect(audits()).toEqual(['partner.referral.list success - -']);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses malformed filters and cursors with 400, auditing each refusal', async () => {
    const queries = [
      'status=open', 'pathway=chat', 'limit=101', 'limit=0', 'cursor=not-a-cursor', 'orgId=other',
      'priority=high', 'assignee=someone', 'assignee=',
    ];
    for (const query of queries) {
      expect((await send('GET', `/referrals?${query}`)).statusCode).toBe(400);
    }
    expect(decodePartnerCursor(Buffer.from(JSON.stringify(['2026-10-21', 'x'])).toString('base64url'))).toBeNull();
    expect(caseRepo.listPartnerReferrals).not.toHaveBeenCalled();
    expect(audits()).toEqual(queries.map(() => 'partner.referral.list denied - -'));
  });

  it('audits malformed ids and bodies on every endpoint before answering 400', async () => {
    const responses = [
      await send('GET', '/referrals/not-a-uuid'),
      await send('POST', '/referrals/not-a-uuid/status', { body: { to: 'acknowledged', expectedStatus: 'new' } }),
      await send('POST', `/referrals/${REFERRAL_ID}/notes`, { body: { body: '' } }),
      await send('POST', `/referrals/${REFERRAL_ID}/evidence/not-a-uuid/url`),
      await send('POST', '/referrals/not-a-uuid/callback'),
    ];
    expect(responses.map(response => response.statusCode)).toEqual([400, 400, 400, 400, 400]);
    expect(responses[0].json()).toMatchObject({ code: 'bad_request', message: 'Invalid request' });
    expect(audits()).toEqual([
      'partner.referral.read denied - -',
      'partner.referral.status denied - -',
      `partner.referral.note denied ${REFERRAL_ID} -`,
      `partner.evidence.url denied ${REFERRAL_ID} -`,
      'partner.referral.callback.read denied - -',
    ]);
    for (const fn of Object.values(caseRepo)) expect(fn).not.toHaveBeenCalled();

    // A malformed request whose refusal cannot be audited fails closed.
    partnerRepo.recordPartnerAccess.mockRejectedValueOnce(new Error('synthetic audit outage'));
    expect((await send('GET', '/referrals/not-a-uuid')).statusCode).toBe(503);
  });

  it('returns the minimised detail scoped to the session org, never survivor account ids or storage keys', async () => {
    const response = await send('GET', `/referrals/${REFERRAL_ID}`);
    expect(response.statusCode).toBe(200);
    expect(caseRepo.getPartnerReferral).toHaveBeenCalledWith(ORG_ID, REFERRAL_ID);
    expect(caseRepo.listPartnerReferralAttachments).toHaveBeenCalledWith(ORG_ID, REFERRAL_ID);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['attachments', 'notes', 'onwardReferrals', 'referral', 'timeline', 'view']);
    expect(body.referral).toMatchObject({ priority: 'normal', needsAttention: false, assignee: null });
    expect(body.onwardReferrals).toEqual([]);
    expect(body.view).toEqual({ kind: 'referral', channel: 'call', brief: { locationType: 'matatu' } });
    expect(body.attachments[0]).toMatchObject({ id: ATTACHMENT_ID, download: { available: true } });
    expect(body.timeline).toEqual([{ event: 'received', status: 'new', at: '2026-10-21T08:00:00.000Z' }]);
    for (const secret of [OWNER_ID, CASE_ID, STORAGE_KEY, 'cccccccc-cccc', 'a'.repeat(64)]) expect(response.body).not.toContain(secret);
    expect(audits()).toEqual([`partner.referral.read success ${REFERRAL_ID} -`]);
  });

  it('answers another org’s or a missing referral with 404 and audits the refusal', async () => {
    caseRepo.getPartnerReferral.mockResolvedValue(null);
    expect((await send('GET', `/referrals/${REFERRAL_ID}`)).statusCode).toBe(404);
    expect((await send('POST', `/referrals/${REFERRAL_ID}/evidence/${ATTACHMENT_ID}/url`)).statusCode).toBe(404);
    expect((await send('POST', `/referrals/${REFERRAL_ID}/callback`)).statusCode).toBe(404);
    expect(audits()).toEqual([
      `partner.referral.read denied ${REFERRAL_ID} -`,
      `partner.evidence.url denied ${REFERRAL_ID} ${ATTACHMENT_ID}`,
      `partner.referral.callback.read denied ${REFERRAL_ID} -`,
    ]);
    expect(storage.createPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('shows a withdrawn referral as a content-free tombstone and refuses every action with 410', async () => {
    caseRepo.getPartnerReferral.mockResolvedValue(referral({
      revokedAt: new Date('2026-10-21T10:00:00.000Z'), pathway: null, summary: null, callbackShared: false,
    }));
    caseRepo.transitionPartnerReferral.mockResolvedValue({ ok: false, reason: 'withdrawn' });
    caseRepo.addPartnerReferralNote.mockResolvedValue({ ok: false, reason: 'withdrawn' });
    const detail = await send('GET', `/referrals/${REFERRAL_ID}`);
    expect(detail.json()).toEqual({
      referral: {
        id: REFERRAL_ID, reference: 'SR-7K3Q-9M2D', status: 'withdrawn', withdrawn: true,
        receivedAt: '2026-10-21T08:00:00.000Z', withdrawnAt: '2026-10-21T10:00:00.000Z',
      },
      view: null, attachments: [], timeline: [], notes: [], onwardReferrals: [],
    });
    expect(caseRepo.listPartnerReferralAttachments).not.toHaveBeenCalled();
    expect(caseRepo.listPartnerOnwardReferrals).not.toHaveBeenCalled();
    const actions = [
      send('POST', `/referrals/${REFERRAL_ID}/status`, { body: { to: 'in_progress', expectedStatus: 'acknowledged' } }),
      send('POST', `/referrals/${REFERRAL_ID}/notes`, { body: { body: 'Synthetic note' } }),
      send('POST', `/referrals/${REFERRAL_ID}/evidence/${ATTACHMENT_ID}/url`),
      send('POST', `/referrals/${REFERRAL_ID}/callback`),
    ];
    for (const response of await Promise.all(actions)) {
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({
        code: 'withdrawn', message: 'This report is no longer shared with your organisation', details: { reason: 'withdrawn' },
      });
      expect(response.body).not.toMatch(/survivor/i);
    }
    expect(audits().sort()).toEqual([
      `partner.evidence.url denied ${REFERRAL_ID} ${ATTACHMENT_ID}`,
      `partner.referral.callback.read denied ${REFERRAL_ID} -`,
      `partner.referral.note denied ${REFERRAL_ID} -`,
      `partner.referral.read success ${REFERRAL_ID} -`,
      `partner.referral.status denied ${REFERRAL_ID} -`,
    ]);
  });

  it('moves the status with optimistic concurrency, acting as the session user and org', async () => {
    caseRepo.transitionPartnerReferral.mockResolvedValueOnce({ ok: true, referral: referral({ status: 'in_progress' }) });
    const moved = await send('POST', `/referrals/${REFERRAL_ID}/status`, { body: { to: 'in_progress', expectedStatus: 'acknowledged' } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().referral).toMatchObject({ status: 'in_progress', allowedTransitions: ['referred_onward', 'closed'] });
    expect(caseRepo.transitionPartnerReferral).toHaveBeenCalledWith({
      actor: { orgId: ORG_ID, userId: USER_ID, requestId: expect.any(String) },
      referralId: REFERRAL_ID, to: 'in_progress', expectedStatus: 'acknowledged', closureReason: undefined,
    });

    caseRepo.transitionPartnerReferral.mockResolvedValueOnce({ ok: false, reason: 'stale', currentStatus: 'in_progress' });
    const stale = await send('POST', `/referrals/${REFERRAL_ID}/status`, { body: { to: 'in_progress', expectedStatus: 'acknowledged' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toEqual({ reason: 'stale', currentStatus: 'in_progress' });
    caseRepo.transitionPartnerReferral.mockResolvedValueOnce({ ok: false, reason: 'invalid_transition', currentStatus: 'new' });
    const skipped = await send('POST', `/referrals/${REFERRAL_ID}/status`, { body: { to: 'referred_onward', expectedStatus: 'new' } });
    expect(skipped.statusCode).toBe(409);
    caseRepo.transitionPartnerReferral.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await send('POST', `/referrals/${REFERRAL_ID}/status`, { body: { to: 'closed', expectedStatus: 'new', closureReason: 'duplicate' } })).statusCode).toBe(404);
    // Success is audited inside the repository transaction; refusals here.
    expect(audits()).toEqual([
      `partner.referral.status denied ${REFERRAL_ID} -`,
      `partner.referral.status denied ${REFERRAL_ID} -`,
      `partner.referral.status denied ${REFERRAL_ID} -`,
    ]);
  });

  it('validates status bodies: a reason only and always when closing, and never back to new', async () => {
    for (const body of [
      { to: 'closed', expectedStatus: 'new' },
      { to: 'closed', expectedStatus: 'new', closureReason: '   ' },
      // Free text is refused: closure reasons are codes, so nothing about the survivor can be typed in.
      { to: 'closed', expectedStatus: 'new', closureReason: 'Survivor Jane at Synthetic Street was helped' },
      { to: 'closed', expectedStatus: 'new', closureReason: 'SUPPORT_PROVIDED' },
      { to: 'acknowledged', expectedStatus: 'new', closureReason: 'other' },
      { to: 'new', expectedStatus: 'acknowledged' },
      { to: 'acknowledged' },
      { to: 'acknowledged', expectedStatus: 'new', ownerId: OWNER_ID },
    ]) {
      expect((await send('POST', `/referrals/${REFERRAL_ID}/status`, { body })).statusCode).toBe(400);
    }
    expect(caseRepo.transitionPartnerReferral).not.toHaveBeenCalled();
    expect(new Set(audits())).toEqual(new Set([`partner.referral.status denied ${REFERRAL_ID} -`]));
    expect(audits()).toHaveLength(8);
  });

  it('appends trimmed notes of up to 2,000 characters', async () => {
    caseRepo.addPartnerReferralNote.mockResolvedValueOnce({
      ok: true,
      note: { id: 'note-1', body: 'Synthetic note', createdAt: new Date('2026-10-21T11:00:00.000Z'), authorUserId: USER_ID, authorDisplayName: 'Synthetic caseworker' },
    });
    const added = await send('POST', `/referrals/${REFERRAL_ID}/notes`, { body: { body: '  Synthetic note  ' } });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toEqual({
      note: { id: 'note-1', body: 'Synthetic note', createdAt: '2026-10-21T11:00:00.000Z', author: { id: USER_ID, displayName: 'Synthetic caseworker' } },
    });
    expect(caseRepo.addPartnerReferralNote).toHaveBeenCalledWith({
      actor: { orgId: ORG_ID, userId: USER_ID, requestId: expect.any(String) }, referralId: REFERRAL_ID, body: 'Synthetic note',
    });
    for (const body of [{ body: ' ' }, { body: 'x'.repeat(2001) }, {}, { body: 'ok', authorUserId: OWNER_ID }, { body: 'Synthetic\u0000note' }]) {
      expect((await send('POST', `/referrals/${REFERRAL_ID}/notes`, { body })).statusCode).toBe(400);
    }
  });

  it('issues a 60-second download-only URL only for released evidence, auditing every attempt', async () => {
    const ok = await send('POST', `/referrals/${REFERRAL_ID}/evidence/${ATTACHMENT_ID}/url`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ url: 'https://storage.example.invalid/presigned', expiresInSeconds: 60 });
    expect(storage.createPresignedDownloadUrl).toHaveBeenCalledWith({ objectKey: STORAGE_KEY, expirySeconds: 60, forceDownload: true });

    caseRepo.listPartnerReferralAttachments.mockResolvedValue([
      attachment({ antivirus_status: 'pending', quarantine_status: 'quarantined' }),
    ]);
    const quarantined = await send('POST', `/referrals/${REFERRAL_ID}/evidence/${ATTACHMENT_ID}/url`);
    expect(quarantined.statusCode).toBe(409);
    expect(quarantined.json().details).toEqual({ reason: 'unscanned' });
    caseRepo.listPartnerReferralAttachments.mockResolvedValue([attachment({ antivirus_status: 'clean', quarantine_status: 'quarantined' })]);
    expect((await send('POST', `/referrals/${REFERRAL_ID}/evidence/${ATTACHMENT_ID}/url`)).json().details).toEqual({ reason: 'quarantined' });
    caseRepo.listPartnerReferralAttachments.mockResolvedValue([]);
    expect((await send('POST', `/referrals/${REFERRAL_ID}/evidence/${ATTACHMENT_ID}/url`)).statusCode).toBe(404);
    expect(storage.createPresignedDownloadUrl).toHaveBeenCalledTimes(1);
    expect(audits()).toEqual([
      `partner.evidence.url success ${REFERRAL_ID} ${ATTACHMENT_ID}`,
      `partner.evidence.url denied ${REFERRAL_ID} ${ATTACHMENT_ID}`,
      `partner.evidence.url denied ${REFERRAL_ID} ${ATTACHMENT_ID}`,
      `partner.evidence.url denied ${REFERRAL_ID} ${ATTACHMENT_ID}`,
    ]);
  });

  it('reveals a callback number only to caseworkers, only while consent holds, and audits each view', async () => {
    const sealed = sealPartnerCallback(callbackSealKey, REFERRAL_ID, '+254712345678');
    caseRepo.getPartnerReferralCallback.mockResolvedValue({ phoneEnc: sealed });
    const shown = await send('POST', `/referrals/${REFERRAL_ID}/callback`);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({ callback: { phoneNumber: '+254712345678' } });
    expect(caseRepo.getPartnerReferralCallback).toHaveBeenCalledWith(ORG_ID, REFERRAL_ID);

    role = 'partner_admin';
    expect((await send('POST', `/referrals/${REFERRAL_ID}/callback`)).statusCode).toBe(403);
    role = 'partner_caseworker';

    caseRepo.getPartnerReferralCallback.mockResolvedValueOnce(null);
    expect((await send('POST', `/referrals/${REFERRAL_ID}/callback`)).statusCode).toBe(404);
    // Sealed for another referral: it must not open.
    caseRepo.getPartnerReferralCallback.mockResolvedValueOnce({
      phoneEnc: sealPartnerCallback(callbackSealKey, CASE_ID, '+254712345678'),
    });
    const tampered = await send('POST', `/referrals/${REFERRAL_ID}/callback`);
    expect(tampered.statusCode).toBe(503);
    expect(tampered.body).not.toContain('712345678');
    expect(audits()).toEqual([
      `partner.referral.callback.read success ${REFERRAL_ID} -`,
      `partner.referral.callback.read denied ${REFERRAL_ID} -`,
      `partner.referral.callback.read denied ${REFERRAL_ID} -`,
      `partner.referral.callback.read failed ${REFERRAL_ID} -`,
    ]);
  });

  it('keeps evidence downloads off by default: 409 evidence_not_shareable_yet, audited, while the list keeps type and size', async () => {
    await app.close();
    app = Fastify({ logger: false });
    await registerPartnerApi(app, { publicOrigin: ORIGIN, totpKey, callbackKey });
    const detail = await send('GET', `/referrals/${REFERRAL_ID}`);
    expect(detail.json().attachments).toEqual([{
      id: ATTACHMENT_ID, mediaType: 'photo', displayName: 'evidence-photo.jpg', mimeType: 'image/jpeg', sizeBytes: 10,
      receivedAt: '2026-10-21T08:01:00.000Z', download: { available: false, reason: 'evidence_not_shareable_yet' },
    }]);
    const response = await send('POST', `/referrals/${REFERRAL_ID}/evidence/${ATTACHMENT_ID}/url`);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'conflict',
      message: 'Evidence downloads are not available to partners yet',
      details: { reason: 'evidence_not_shareable_yet' },
      requestId: expect.any(String),
    });
    expect(storage.createPresignedDownloadUrl).not.toHaveBeenCalled();
    expect(audits()).toEqual([
      `partner.referral.read success ${REFERRAL_ID} -`,
      `partner.evidence.url denied ${REFERRAL_ID} ${ATTACHMENT_ID}`,
    ]);
  });

  it('cannot reveal any callback while PARTNER_CALLBACK_KEY is unset, and audits the failure', async () => {
    await app.close();
    app = Fastify({ logger: false });
    await registerPartnerApi(app, { publicOrigin: ORIGIN, totpKey });
    caseRepo.getPartnerReferralCallback.mockResolvedValue({ phoneEnc: sealPartnerCallback(callbackSealKey, REFERRAL_ID, '+254712345678') });
    const response = await send('POST', `/referrals/${REFERRAL_ID}/callback`);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('712345678');
    expect(audits()).toEqual([`partner.referral.callback.read failed ${REFERRAL_ID} -`]);
  });

  it('lets admins work the queue but fails closed with 503 and no data when the audit write fails', async () => {
    role = 'partner_admin';
    expect((await send('GET', `/referrals/${REFERRAL_ID}`)).statusCode).toBe(200);
    partnerRepo.recordPartnerAccess.mockRejectedValue(new Error('synthetic audit outage'));
    const detail = await send('GET', `/referrals/${REFERRAL_ID}`);
    expect(detail.statusCode).toBe(503);
    expect(detail.body).not.toContain('SR-7K3Q-9M2D');
    const url = await send('POST', `/referrals/${REFERRAL_ID}/evidence/${ATTACHMENT_ID}/url`);
    expect(url.statusCode).toBe(503);
    expect(url.body).not.toContain('presigned');
  });
  it('filters the queue by priority and assignee (me is the session user), and shows who is in charge', async () => {
    caseRepo.listPartnerReferrals.mockResolvedValue({
      rows: [{
        id: REFERRAL_ID, reference: 'SR-7K3Q-9M2D', status: 'in_progress', pathway: 'escalation',
        receivedAt: new Date('2026-10-21T08:00:00.000Z'), statusChangedAt: new Date('2026-10-21T09:00:00.000Z'), revokedAt: null,
        assignee: { id: USER_ID, name: 'Synthetic caseworker' },
        onward: { count: 2, latest: { type: 'police', status: 'accepted' } },
      }],
      nextCursor: null,
    });
    const mine = await send('GET', '/referrals?assignee=me&priority=urgent');
    expect(mine.statusCode).toBe(200);
    expect(caseRepo.listPartnerReferrals).toHaveBeenLastCalledWith(expect.objectContaining({
      orgId: ORG_ID, priority: 'urgent', assignee: { kind: 'user', userId: USER_ID },
    }));
    expect(mine.json().referrals[0]).toMatchObject({
      priority: 'urgent', needsAttention: false, assignee: { id: USER_ID, name: 'Synthetic caseworker' },
      onward: { count: 2, latest: { type: 'police', status: 'accepted' } },
    });
    await send('GET', '/referrals?assignee=unassigned&priority=normal');
    expect(caseRepo.listPartnerReferrals).toHaveBeenLastCalledWith(expect.objectContaining({
      priority: 'normal', assignee: { kind: 'unassigned' },
    }));
    await send('GET', `/referrals?assignee=${OTHER_USER_ID}`);
    expect(caseRepo.listPartnerReferrals).toHaveBeenLastCalledWith(expect.objectContaining({
      assignee: { kind: 'user', userId: OTHER_USER_ID },
    }));
    // A withdrawn row says nothing about priority, assignee or onward work.
    caseRepo.listPartnerReferrals.mockResolvedValueOnce({
      rows: [{
        id: REFERRAL_ID, reference: 'SR-7K3Q-9M2D', status: 'new', pathway: 'escalation',
        receivedAt: new Date('2026-10-21T08:00:00.000Z'), statusChangedAt: new Date('2026-10-21T09:00:00.000Z'),
        revokedAt: new Date('2026-10-21T10:00:00.000Z'), assignee: { id: USER_ID, name: 'x' }, onward: { count: 1, latest: null },
      }],
      nextCursor: null,
    });
    expect((await send('GET', '/referrals?status=withdrawn')).json().referrals[0]).toMatchObject({
      status: 'withdrawn', pathway: null, priority: 'normal', needsAttention: false, assignee: null, onward: { count: 0, latest: null },
    });
  });

  it('returns summary counts only, auditing successes at most once per window and every refusal', async () => {
    caseRepo.summarizePartnerQueue.mockResolvedValue({ needsAttention: 1, newTotal: 2, inProgress: 3, unassigned: 4, mine: 5 });
    const response = await send('GET', '/summary');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ needsAttention: 1, newTotal: 2, inProgress: 3, unassigned: 4, mine: 5 });
    expect(caseRepo.summarizePartnerQueue).toHaveBeenCalledWith(ORG_ID, USER_ID);
    expect(partnerRepo.recordPartnerAccessAtMostEvery).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, action: 'partner.summary.read', outcome: 'success', actor: { type: 'partner_user', userId: USER_ID } }),
      15 * 60,
    );
    expect((await send('GET', '/summary?orgId=other')).statusCode).toBe(400);
    expect(audits()).toEqual(['partner.summary.read denied - -']);
    partnerRepo.recordPartnerAccessAtMostEvery.mockRejectedValueOnce(new Error('synthetic audit outage'));
    const failed = await send('GET', '/summary');
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('needsAttention');
  });

  it('lists active staff by name and role, never emails, and audits the read', async () => {
    caseRepo.listPartnerStaff.mockResolvedValue([
      { id: USER_ID, name: 'Synthetic caseworker', role: 'partner_caseworker' },
      { id: OTHER_USER_ID, name: 'Synthetic admin', role: 'partner_admin' },
    ]);
    const response = await send('GET', '/staff');
    expect(response.json()).toEqual({ staff: [
      { id: USER_ID, name: 'Synthetic caseworker', role: 'partner_caseworker' },
      { id: OTHER_USER_ID, name: 'Synthetic admin', role: 'partner_admin' },
    ] });
    expect(caseRepo.listPartnerStaff).toHaveBeenCalledWith(ORG_ID);
    expect(response.body).not.toContain('@');
    expect(audits()).toEqual(['partner.staff.list success - -']);
  });

  it('assigns with optimistic concurrency, as the session user and org, and refuses bad assignees', async () => {
    caseRepo.assignPartnerReferral.mockResolvedValueOnce({
      ok: true, referral: referral({ assignee: { id: OTHER_USER_ID, name: 'Synthetic admin' } }),
    });
    const assigned = await send('POST', `/referrals/${REFERRAL_ID}/assign`, { body: { assigneeId: OTHER_USER_ID, expectedAssigneeId: null } });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().referral).toMatchObject({ id: REFERRAL_ID, assignee: { id: OTHER_USER_ID, name: 'Synthetic admin' } });
    expect(caseRepo.assignPartnerReferral).toHaveBeenCalledWith({
      actor: { orgId: ORG_ID, userId: USER_ID, requestId: expect.any(String) },
      referralId: REFERRAL_ID, assigneeId: OTHER_USER_ID, expectedAssigneeId: null,
    });

    caseRepo.assignPartnerReferral.mockResolvedValueOnce({ ok: false, reason: 'stale', currentAssignee: { id: USER_ID, name: 'Synthetic caseworker' } });
    const stale = await send('POST', `/referrals/${REFERRAL_ID}/assign`, { body: { assigneeId: null, expectedAssigneeId: OTHER_USER_ID } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toEqual({ reason: 'stale', currentAssignee: { id: USER_ID, name: 'Synthetic caseworker' } });
    caseRepo.assignPartnerReferral.mockResolvedValueOnce({ ok: false, reason: 'invalid_assignee' });
    const invalid = await send('POST', `/referrals/${REFERRAL_ID}/assign`, { body: { assigneeId: OTHER_USER_ID, expectedAssigneeId: null } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().details).toEqual({ reason: 'invalid_assignee' });
    caseRepo.assignPartnerReferral.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await send('POST', `/referrals/${REFERRAL_ID}/assign`, { body: { assigneeId: null, expectedAssigneeId: null } })).statusCode).toBe(404);
    caseRepo.assignPartnerReferral.mockResolvedValueOnce({ ok: false, reason: 'withdrawn' });
    expect((await send('POST', `/referrals/${REFERRAL_ID}/assign`, { body: { assigneeId: null, expectedAssigneeId: null } })).statusCode).toBe(410);
    for (const body of [{ assigneeId: OTHER_USER_ID }, { assigneeId: 'me', expectedAssigneeId: null }, { assigneeId: null, expectedAssigneeId: null, orgId: ORG_ID }]) {
      expect((await send('POST', `/referrals/${REFERRAL_ID}/assign`, { body })).statusCode).toBe(400);
    }
    expect(caseRepo.assignPartnerReferral).toHaveBeenCalledTimes(5);
    expect(audits()).toEqual(Array.from({ length: 7 }, () => `partner.referral.assign denied ${REFERRAL_ID} -`));
  });

  it('creates onward referrals with bounded, trimmed partner text, starting planned unless already made', async () => {
    const record = {
      id: ONWARD_ID, type: 'police', organisation: 'Synthetic Police Station', contactRole: null, externalReference: 'OB 1/2/2026',
      note: null, status: 'planned', createdAt: new Date('2026-10-21T11:00:00.000Z'),
      createdBy: { id: USER_ID, name: 'Synthetic caseworker' }, statusChangedAt: new Date('2026-10-21T11:00:00.000Z'),
    };
    caseRepo.createPartnerOnwardReferral.mockResolvedValue({ ok: true, onward: record });
    const created = await send('POST', `/referrals/${REFERRAL_ID}/onward`, {
      body: { type: 'police', organisation: '  Synthetic Police Station ', contactRole: '  ', externalReference: 'OB 1/2/2026', note: null },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ onward: {
      id: ONWARD_ID, type: 'police', organisation: 'Synthetic Police Station', contactRole: null, externalReference: 'OB 1/2/2026',
      note: null, status: 'planned', createdAt: '2026-10-21T11:00:00.000Z', createdBy: { id: USER_ID, name: 'Synthetic caseworker' },
      statusChangedAt: '2026-10-21T11:00:00.000Z', allowedTransitions: ['made', 'cancelled'],
    } });
    expect(caseRepo.createPartnerOnwardReferral).toHaveBeenLastCalledWith({
      actor: { orgId: ORG_ID, userId: USER_ID, requestId: expect.any(String) }, referralId: REFERRAL_ID,
      input: {
        type: 'police', organisation: 'Synthetic Police Station', contactRole: null, externalReference: 'OB 1/2/2026',
        note: null, status: 'planned',
      },
    });
    await send('POST', `/referrals/${REFERRAL_ID}/onward`, { body: { type: 'medical', status: 'made', note: 'x'.repeat(1000) } });
    expect(caseRepo.createPartnerOnwardReferral.mock.calls[1][0].input).toMatchObject({ type: 'medical', status: 'made', note: 'x'.repeat(1000) });
    for (const body of [
      {}, { type: 'hospital' }, { type: 'police', status: 'accepted' }, { type: 'police', organisation: 'x'.repeat(121) },
      { type: 'police', contactRole: 'x'.repeat(121) }, { type: 'police', externalReference: 'x'.repeat(81) },
      { type: 'police', note: 'x'.repeat(1001) }, { type: 'police', createdBy: OTHER_USER_ID },
      // Control characters (a NUL would fail in PostgreSQL as a 503): refused and audited.
      { type: 'police', note: 'Synthetic\u0000note' }, { type: 'police', organisation: 'Station\u0008' },
      { type: 'police', contactRole: 'Gender\rdesk' }, { type: 'police', externalReference: 'OB\u007f' },
    ]) {
      expect((await send('POST', `/referrals/${REFERRAL_ID}/onward`, { body })).statusCode).toBe(400);
    }
    caseRepo.createPartnerOnwardReferral.mockResolvedValueOnce({ ok: false, reason: 'withdrawn' });
    expect((await send('POST', `/referrals/${REFERRAL_ID}/onward`, { body: { type: 'shelter' } })).statusCode).toBe(410);
    caseRepo.createPartnerOnwardReferral.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await send('POST', `/referrals/${REFERRAL_ID}/onward`, { body: { type: 'shelter' } })).statusCode).toBe(404);
    expect(audits()).toEqual(Array.from({ length: 14 }, () => `partner.onward.create denied ${REFERRAL_ID} -`));
    // Newlines and tabs are fine.
    await send('POST', `/referrals/${REFERRAL_ID}/onward`, { body: { type: 'other', note: 'Line one\n\tline two' } });
    expect(caseRepo.createPartnerOnwardReferral.mock.lastCall?.[0].input.note).toBe('Line one\n\tline two');
  });

  it('moves onward referrals only forward, with optimistic concurrency', async () => {
    caseRepo.transitionPartnerOnwardReferral.mockResolvedValueOnce({
      ok: true,
      onward: {
        id: ONWARD_ID, type: 'police', organisation: null, contactRole: null, externalReference: null, note: null, status: 'accepted',
        createdAt: new Date('2026-10-21T11:00:00.000Z'), createdBy: { id: USER_ID, name: 'Synthetic caseworker' },
        statusChangedAt: new Date('2026-10-21T12:00:00.000Z'),
      },
    });
    const moved = await send('POST', `/referrals/${REFERRAL_ID}/onward/${ONWARD_ID}/status`, { body: { to: 'accepted', expectedStatus: 'made' } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().onward).toMatchObject({ status: 'accepted', allowedTransitions: ['completed'] });
    expect(caseRepo.transitionPartnerOnwardReferral).toHaveBeenCalledWith({
      actor: { orgId: ORG_ID, userId: USER_ID, requestId: expect.any(String) },
      referralId: REFERRAL_ID, onwardId: ONWARD_ID, to: 'accepted', expectedStatus: 'made',
    });
    caseRepo.transitionPartnerOnwardReferral.mockResolvedValueOnce({ ok: false, reason: 'stale', currentStatus: 'accepted' });
    const stale = await send('POST', `/referrals/${REFERRAL_ID}/onward/${ONWARD_ID}/status`, { body: { to: 'accepted', expectedStatus: 'made' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toEqual({ reason: 'stale', currentStatus: 'accepted' });
    caseRepo.transitionPartnerOnwardReferral.mockResolvedValueOnce({ ok: false, reason: 'invalid_transition', currentStatus: 'completed' });
    const terminal = await send('POST', `/referrals/${REFERRAL_ID}/onward/${ONWARD_ID}/status`, { body: { to: 'declined', expectedStatus: 'completed' } });
    expect(terminal.json().details).toEqual({ reason: 'invalid_transition', currentStatus: 'completed' });
    caseRepo.transitionPartnerOnwardReferral.mockResolvedValueOnce({ ok: false, reason: 'onward_not_found' });
    expect((await send('POST', `/referrals/${REFERRAL_ID}/onward/${ONWARD_ID}/status`, { body: { to: 'made', expectedStatus: 'planned' } })).statusCode).toBe(404);
    for (const body of [{ to: 'planned', expectedStatus: 'made' }, { to: 'made' }, { to: 'done', expectedStatus: 'made' }]) {
      expect((await send('POST', `/referrals/${REFERRAL_ID}/onward/${ONWARD_ID}/status`, { body })).statusCode).toBe(400);
    }
    expect((await send('POST', `/referrals/${REFERRAL_ID}/onward/not-a-uuid/status`, { body: { to: 'made', expectedStatus: 'planned' } })).statusCode).toBe(400);
    expect(audits()).toEqual(Array.from({ length: 7 }, () => `partner.onward.status denied ${REFERRAL_ID} -`));
  });

  it('shows onward referrals and who acted in the detail, and opening an urgent new referral changes nothing', async () => {
    caseRepo.getPartnerReferral.mockResolvedValue(referral({
      status: 'new', pathway: 'escalation', assignee: { id: USER_ID, name: 'Synthetic caseworker' },
      summary: null,
    }));
    caseRepo.listPartnerCaseActivity.mockResolvedValue([
      { kind: 'assigned', createdAt: new Date('2026-10-21T08:30:00.000Z'), actor: { id: OTHER_USER_ID, name: 'Synthetic admin' },
        assignee: { id: USER_ID, name: 'Synthetic caseworker' }, onward: null },
    ]);
    const detail = await send('GET', `/referrals/${REFERRAL_ID}`);
    expect(detail.json().referral).toMatchObject({
      status: 'new', priority: 'urgent', needsAttention: true, assignee: { id: USER_ID, name: 'Synthetic caseworker' },
    });
    expect(detail.json().timeline).toEqual([
      { event: 'received', status: 'new', at: '2026-10-21T08:00:00.000Z' },
      { event: 'assigned', status: null, at: '2026-10-21T08:30:00.000Z', actor: { id: OTHER_USER_ID, name: 'Synthetic admin' },
        assignee: { id: USER_ID, name: 'Synthetic caseworker' } },
    ]);
    expect(caseRepo.transitionPartnerReferral).not.toHaveBeenCalled();
    expect(caseRepo.assignPartnerReferral).not.toHaveBeenCalled();
  });
});
